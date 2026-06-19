import { randomUUID } from "node:crypto";
import type { Engine, EngineRunOpts, EngineResult, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
/** Keep per-session history bounded (OpenRouter is stateless — we resend it). */
const MAX_HISTORY_MESSAGES = 40;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * OpenRouterEngine — an API-based engine (no CLI/PTY). It replies using a model
 * served by OpenRouter (OpenAI-compatible chat completions). OpenRouter is
 * stateless, so we keep a bounded per-session message history in memory and
 * resend it each turn; resumeSessionId continues a thread, a new id starts fresh.
 *
 * This is a plain request/response engine (no agentic tools/file editing) — it
 * answers chat turns, which is what subscription/utility models are used for here.
 */
export class OpenRouterEngine implements Engine {
  name = "openrouter" as const;

  private histories = new Map<string, ChatMessage[]>();

  constructor(private readonly getConfig: () => JinnConfig) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const startMs = Date.now();
    const sessionId = opts.resumeSessionId || opts.sessionId || randomUUID();
    const cfg = this.getConfig();
    const apiKey = cfg.engines.openrouter?.apiKey;
    const model = opts.model || cfg.engines.openrouter?.model || DEFAULT_MODEL;

    if (!apiKey) {
      return {
        sessionId,
        result: "",
        error: "OpenRouter is not configured — set an API key in Settings → Engine Configuration.",
      };
    }

    const history = this.histories.get(sessionId) ?? [];
    if (history.length === 0 && opts.systemPrompt?.trim()) {
      history.push({ role: "system", content: opts.systemPrompt });
    }
    history.push({ role: "user", content: opts.prompt });

    let full = "";
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/suebphattana/jinn",
          "X-Title": "Jinn",
        },
        body: JSON.stringify({ model, messages: history, stream: !!opts.onStream }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 300)}`);
      }

      if (opts.onStream && res.body) {
        full = await this.consumeStream(res.body, opts.onStream);
      } else {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        full = data.choices?.[0]?.message?.content ?? "";
        if (opts.onStream) opts.onStream({ type: "text", content: full });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`OpenRouter run error: ${message}`);
      // Drop the user turn we optimistically pushed so a retry isn't doubled.
      history.pop();
      this.histories.set(sessionId, history.slice(-MAX_HISTORY_MESSAGES));
      return { sessionId, result: "", error: message, durationMs: Date.now() - startMs };
    }

    history.push({ role: "assistant", content: full });
    this.histories.set(sessionId, history.slice(-MAX_HISTORY_MESSAGES));

    if (opts.onStream) opts.onStream({ type: "text_snapshot", content: full });

    return {
      sessionId,
      result: full,
      durationMs: Date.now() - startMs,
      numTurns: 1,
    };
  }

  /** Parse an OpenAI-style SSE stream, forwarding text deltas and returning the
   *  full concatenated content. */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    onStream: NonNullable<EngineRunOpts["onStream"]>,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onStream({ type: "text", content: delta });
          }
        } catch {
          /* ignore keep-alive / partial lines */
        }
      }
    }
    return full;
  }

  /** Forget a session's conversation history (used on /reset). */
  resetSession(sessionId: string): void {
    this.histories.delete(sessionId);
  }
}
