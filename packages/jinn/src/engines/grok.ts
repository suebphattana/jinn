import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";

export const GROK_DEFAULT_MODEL = "grok-build";
export const GROK_SESSIONS_DIR = path.join(os.homedir(), ".grok", "sessions");

const STDERR_MAX = 10 * 1024;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface GrokParsedLine {
  deltas: StreamDelta[];
  sessionId?: string;
  doneText?: string;
  error?: string;
  terminal?: boolean;
  contextTokens?: number;
}

export function grokCliFlags(flags: string[] | undefined): string[] {
  // `--chrome` is a Claude Code flag. Shared employee config can carry it; Grok
  // rejects unknown flags before a session starts.
  return (flags ?? []).filter((flag) => flag !== "--chrome");
}

export function buildGrokHeadlessArgs(opts: EngineRunOpts, prompt: string, sessionId: string): string[] {
  const args = ["--no-auto-update"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.resumeSessionId) args.push("--resume", sessionId);
  args.push("--always-approve", "--output-format", "streaming-json");
  args.push(...grokCliFlags(opts.cliFlags));
  args.push("-p", prompt);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const b = asRecord(block);
      if (!b) return "";
      return stringField(b, ["text", "content", "value", "output"]) ?? "";
    })
    .join("");
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  if (!obj) return "";
  return stringField(obj, ["text", "content", "value", "output", "message"]) ?? textFromContent(obj.content);
}

function extractText(obj: Record<string, unknown>, eventType: string, terminal: boolean): { text: string; snapshot: boolean } {
  const message = asRecord(obj.message);
  const role = String(obj.role ?? message?.role ?? "").toLowerCase();
  if (role === "user" || role === "system" || eventType === "user" || eventType === "system") {
    return { text: "", snapshot: true };
  }

  const deltaText = textFromUnknown(obj.delta);
  if (deltaText) return { text: deltaText, snapshot: false };

  const messageText = message ? textFromContent(message.content) || textFromUnknown(message.text) : "";
  if (messageText) return { text: messageText, snapshot: true };

  const contentText = textFromContent(obj.content);
  if (contentText) return { text: contentText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };

  const directText = terminal
    ? stringField(obj, ["result", "final", "answer", "output", "text", "content"])
    : stringField(obj, ["text", "content"]);
  if (!directText) return { text: "", snapshot: true };
  return { text: directText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };
}

function extractError(obj: Record<string, unknown>): string | undefined {
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err;
  const errObj = asRecord(err);
  if (errObj) {
    const msg = stringField(errObj, ["message", "error", "detail"]);
    if (msg) return msg;
  }
  return stringField(obj, ["errorMessage", "message", "detail"]);
}

function extractContextTokens(obj: Record<string, unknown>): number | undefined {
  const usage = asRecord(obj.usage) ?? asRecord(obj.token_usage) ?? asRecord(obj.tokens);
  const candidate =
    usage?.input_tokens ??
    usage?.inputTokens ??
    usage?.context_tokens ??
    usage?.contextTokens ??
    obj.context_tokens ??
    obj.contextTokens;
  const n = Number(candidate ?? 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseGrokJsonLine(line: string): GrokParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return null;
    obj = record;
  } catch {
    logger.debug(`[grok stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return null;
  }

  const method = String(obj.method ?? "");
  if (method === "session/update") {
    const params = asRecord(obj.params);
    const update = asRecord(params?.update);
    const updateType = String(update?.sessionUpdate ?? "").toLowerCase();
    const nestedSessionId = params ? stringField(params, ["sessionId", "session_id"]) : undefined;
    if (updateType === "agent_message_chunk") {
      const content = asRecord(update?.content);
      const text = textFromUnknown(content?.text ?? update?.content);
      return {
        deltas: text ? [{ type: "text", content: text }] : [],
        sessionId: nestedSessionId,
        terminal: false,
      };
    }
    return { deltas: [], sessionId: nestedSessionId, terminal: false };
  }

  const rawType = String(obj.type ?? obj.event ?? obj.kind ?? "");
  const eventType = rawType.toLowerCase();
  const terminal =
    Boolean(obj.done || obj.is_final || obj.final) ||
    /complete|completed|done|result|final|agent_end|turn_end/.test(eventType) ||
    eventType === "end";
  const deltas: StreamDelta[] = [];

  const sessionId = stringField(obj, ["session_id", "sessionId", "conversation_id", "conversationId"]);
  const contextTokens = extractContextTokens(obj);
  if (contextTokens) deltas.push({ type: "context", content: String(contextTokens) });

  if (eventType.includes("error") || eventType.includes("failed") || obj.error !== undefined) {
    const error = extractError(obj) ?? "Grok reported an error";
    return { deltas: [{ type: "error", content: error }, ...deltas], sessionId, error, terminal: true };
  }

  if (eventType === "thought") {
    return { deltas, sessionId, terminal, contextTokens };
  }

  if (eventType === "text") {
    const text = textFromUnknown(obj.data);
    if (text) deltas.push({ type: "text", content: text });
    return { deltas, sessionId, terminal, contextTokens };
  }

  const toolName = stringField(obj, ["toolName", "tool_name", "name"]) ?? stringField(asRecord(obj.tool) ?? {}, ["name"]);
  if (eventType.includes("tool") && (eventType.includes("start") || eventType.includes("call") || eventType.includes("use"))) {
    const content = toolName ? `Using ${toolName}` : "Using tool";
    return {
      deltas: [{ type: "tool_use", content, toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }
  if (eventType.includes("tool") && (eventType.includes("end") || eventType.includes("result") || eventType.includes("complete"))) {
    const content = textFromUnknown(obj.result) || stringField(obj, ["output", "content"]) || "Done";
    return {
      deltas: [{ type: "tool_result", content: content.slice(0, 500), toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }

  const { text, snapshot } = extractText(obj, eventType, terminal);
  let doneText: string | undefined;
  if (text) {
    const deltaType: StreamDelta["type"] = snapshot ? "text_snapshot" : "text";
    deltas.push({ type: deltaType, content: text });
    if (terminal || snapshot) doneText = text;
  }

  return { deltas, sessionId, doneText, terminal, contextTokens };
}

export class GrokEngine implements InterruptibleEngine {
  name = "grok" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Grok process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) this.kill(sessionId, "Interrupted: gateway shutting down");
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `grok-${Date.now()}`;
    const grokSessionId = opts.resumeSessionId || trackingId;

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("grok", opts.bin);
    const args = buildGrokHeadlessArgs(opts, prompt, grokSessionId);
    logger.info(`Grok engine starting: ${bin} --model ${opts.model || "default"} (session: ${grokSessionId})`);

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: this.buildCleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(trackingId, { proc, terminationReason: null });

      let stderr = "";
      let lineBuf = "";
      let resultText = "";
      let turnError: string | null = null;
      let lastContextTokens: number | undefined;
      let settled = false;
      let resolvedSessionId = grokSessionId;

      const handleParsed = (parsed: GrokParsedLine | null) => {
        if (!parsed) return;
        if (parsed.sessionId) resolvedSessionId = parsed.sessionId;
        if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
        if (parsed.error) turnError = parsed.error;
        for (const delta of parsed.deltas) {
          if (delta.type === "text") resultText += delta.content;
          if (delta.type === "text_snapshot") resultText = delta.content;
          opts.onStream?.(delta);
        }
        if (parsed.doneText) resultText = parsed.doneText;
      };

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) handleParsed(parseGrokJsonLine(line));
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr = (stderr + chunk).slice(-STDERR_MAX);
        for (const line of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[grok stderr] ${line}`);
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        handleParsed(parseGrokJsonLine(lineBuf));
        const terminationReason = this.liveProcesses.get(trackingId)?.terminationReason ?? null;
        this.liveProcesses.delete(trackingId);

        if (terminationReason) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: terminationReason,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || resultText.trim()) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: resultText.trim() ? undefined : (turnError ?? undefined),
            numTurns: 1,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        const errMsg = turnError || `Grok exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: resolvedSessionId,
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Grok CLI: ${err.message}`));
      });
    });
  }

  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (k === "CODEX" || k.startsWith("CODEX_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    return cleanEnv;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Grok process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
