/**
 * Jinn Talk — HTTP route dispatcher (Path 1).
 *
 * Single entry point `handleTalkApi(req, res, context)` for everything under
 * `/api/talk/*`. Registered from gateway/api.ts near the STT routes. Returns
 * `true` when it owns the path (so api.ts can early-return), `false` otherwise.
 *
 * Path 1 — the voice orchestrator is a REAL gateway session, not an in-process
 * Agent-SDK loop. So this dispatcher is thin: it only bootstraps/returns the
 * orchestrator session and exposes Kokoro TTS readiness/download. Actual voice
 * turns go through the normal POST /api/sessions/:id/message; the orchestrator's
 * spoken reply is synthesized server-side (see talk/tts-stream.ts, driven from
 * the run loop in api.ts) and streamed as talk:audio over the WebSocket.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ApiContext } from "../gateway/api.js";
import { createSession, getSessionBySessionKey } from "../sessions/registry.js";
import { getTalkTts } from "./tts-stream.js";

/** Stable session key for the single hands-free orchestrator surface. */
const TALK_SESSION_KEY = "talk:main";

/**
 * Dispatch any `/api/talk/*` request. Returns `true` if handled (caller should
 * early-return), `false` if the path is not a talk route.
 */
export async function handleTalkApi(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/talk/")) return false;

  try {
    // POST /api/talk/session — bootstrap (or reuse) the orchestrator session.
    // The orchestrator is a normal idle gateway session with source:"talk";
    // buildContext() layers the AURA voice persona on it. Reuses the existing
    // talk session across reloads unless { fresh:true } is sent.
    if (method === "POST" && pathname === "/api/talk/session") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { fresh?: boolean };
      const config = context.getConfig();

      if (!body.fresh) {
        const existing = getSessionBySessionKey(TALK_SESSION_KEY);
        if (existing && existing.source === "talk") {
          json(res, { sessionId: existing.id, reused: true });
          return true;
        }
      }

      const session = createSession({
        engine: "claude",
        source: "talk",
        sourceRef: TALK_SESSION_KEY,
        connector: "web",
        sessionKey: TALK_SESSION_KEY,
        replyContext: { source: "talk" },
        model: config.talk?.orchestratorModel ?? "haiku",
        title: "Talk",
        portalName: config.portal?.portalName,
      });
      json(res, { sessionId: session.id, reused: false });
      return true;
    }

    // GET /api/talk/status — TTS engine readiness.
    if (method === "GET" && pathname === "/api/talk/status") {
      const s = getTalkTts(context.getConfig().talk?.kokoro).status();
      json(res, {
        ttsAvailable: s.available,
        ttsDownloading: s.downloading,
        progress: s.progress,
        voice: s.voice,
        ready: s.ready,
      });
      return true;
    }

    // POST /api/talk/tts/download — kick Kokoro weight download in the
    // background (progress streams over talk:tts:download:* WS events).
    if (method === "POST" && pathname === "/api/talk/tts/download") {
      getTalkTts(context.getConfig().talk?.kokoro)
        .download(context.emit)
        .catch((err) => {
          context.emit("talk:tts:download:error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      json(res, { status: "downloading" });
      return true;
    }

    // Unknown /api/talk/* path — let api.ts fall through to its 404.
    return false;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, { ok: false, error }, 500);
    return true;
  }
}

// ── Local copies of api.ts response helpers ─────────────────────────────
async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  opts?: { allowEmpty?: boolean },
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  } catch {
    badRequest(res, "Failed to read request body");
    return { ok: false };
  }
  if (!raw.trim()) {
    if (opts?.allowEmpty) return { ok: true, body: null };
    badRequest(res, "Empty request body");
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}
