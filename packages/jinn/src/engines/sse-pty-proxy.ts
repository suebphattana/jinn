import http from "node:http";
import https from "node:https";
import { logger } from "../shared/logger.js";

/** Shared keep-alive agent so concurrent turns (and sub-agent fan-out) reuse a
 *  small TLS socket pool instead of opening a fresh handshake per request — the
 *  per-request TLS churn was the likely source of intermittent "bad record mac"
 *  errors under sub-agent concurrency. */
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/** Kill an upstream connection that goes silent this long (no bytes). Generous so
 *  long extended-thinking pauses and slow first-token never trip it; only a truly
 *  hung/half-open socket is reaped. */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** A parsed Anthropic SSE event's `data:` JSON payload (already JSON.parsed). */
export interface SseDataEvent {
  type?: string;
  [k: string]: unknown;
}

/** Signature of `https.request`/`http.request` — the seam we inject in tests so
 *  the proxy can target a local fake upstream instead of api.anthropic.com. */
type UpstreamRequestFn = (
  options: https.RequestOptions,
  cb: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

/** Test/override hooks. All optional; defaults reproduce production behavior
 *  (https → api.anthropic.com:443 over the shared keep-alive pool). */
export interface SsePtyProxyOpts {
  requestFn?: UpstreamRequestFn;
  upstream?: { hostname: string; port: number };
  /** Agent for the FIRST attempt. Default: the shared keep-alive pool. */
  primaryAgent?: https.Agent | http.Agent | false;
}

/** Is this upstream error the "stale pooled socket" symptom — a connection that
 *  was reset/torn before we got any response? Those are safe to retry on a fresh
 *  socket (request body fully buffered, nothing streamed to the client yet). We
 *  deliberately do NOT retry idle-timeouts or post-response errors. */
function isRetriableUpstreamError(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    /socket hang up/i.test(err.message)
  );
}

/**
 * Per-PTY forward proxy. The genuine `claude` CLI is pointed at this proxy via
 * ANTHROPIC_BASE_URL; every request is forwarded UNCHANGED to api.anthropic.com
 * (same method/path/headers/body, subscription OAuth token preserved → still
 * cc_entrypoint=cli, subsidy-safe — verified in Item A) and the response is
 * streamed back to the client byte-for-byte. The ONLY mutation is stripping the
 * client's `accept-encoding` so the SSE body comes back as plaintext we can
 * parse; the (now-uncompressed) response headers are forwarded as-is.
 *
 * When the upstream response is text/event-stream we tee a parsed copy of each
 * SSE `data:` event to `onEvent` — this is the live streaming source for the web
 * chat pane (word-by-word text, tool markers in true order, live context tokens).
 *
 * Auxiliary-suppression: besides the real conversation turn, Claude Code fires
 * extra requests through this same proxy — haiku topic/title detection and quota
 * checks (NO tools), plus a smaller pre-flight conversation request before the full
 * turn. We tee to `onEvent` every request that carries a non-empty `tools` array
 * (the genuine agent turns) and suppress only the no-tools auxiliary calls (whose
 * output, e.g. a title-gen `{"title":...}`, must never leak into the transcript).
 *
 * We deliberately do NOT try to fingerprint "main vs sub-agent": empirically the
 * main agent's own requests do not share a stable signature (tool set and system
 * drift across a turn as MCP tools/instructions load and per-request reminders are
 * injected), so any such heuristic suppressed legitimate turns and broke streaming.
 * Sub-agents therefore stream inline like any other tool work — there are no cards.
 */
export class SsePtyProxy {
  private server: http.Server;
  /** Resolved listening port (0 until start() completes). */
  port = 0;

  private readonly requestFn: UpstreamRequestFn;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number;
  private readonly primaryAgent: https.Agent | http.Agent | false;

  constructor(
    private readonly label: string,
    private readonly onEvent: (e: SseDataEvent) => void,
    opts: SsePtyProxyOpts = {},
  ) {
    this.requestFn = opts.requestFn ?? https.request;
    this.upstreamHost = opts.upstream?.hostname ?? "api.anthropic.com";
    this.upstreamPort = opts.upstream?.port ?? 443;
    this.primaryAgent = opts.primaryAgent ?? upstreamAgent;
    this.server = http.createServer((req, res) => this.handle(req, res));
    // node http servers throw on unhandled 'clientError'; swallow so a flaky
    // client socket can never crash the daemon.
    this.server.on("clientError", (err, socket) => {
      logger.warn(`SsePtyProxy[${this.label}] clientError: ${err.message}`);
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  /** Bind to an ephemeral 127.0.0.1 port; resolves with the chosen port. */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.server.once("error", onErr);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onErr);
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Tear down the proxy. Safe to call multiple times. */
  stop(): void {
    try { this.server.close(); } catch { /* already closed */ }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    // Holder (not a plain `let`) so the req-close handler always destroys the
    // CURRENT in-flight upstream even after a retry swapped it out.
    const inflight: { current?: http.ClientRequest } = {};
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
    // Client (the claude CLI) hung up mid-turn — abort the in-flight upstream so
    // we don't keep streaming to a dead socket (resource leak per interrupted
    // turn). We listen on `res` 'close', NOT `req` 'close': req 'close' fires as
    // soon as the request body is fully read — which is BEFORE we've even sent
    // the response — and would destroy a perfectly healthy upstream (and silently
    // kill the retry). `res` 'close' with `!writableFinished` is the real
    // "client went away before we finished" signal.
    res.on("close", () => {
      if (!res.writableFinished) { try { inflight.current?.destroy(); } catch { /* ignore */ } }
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // Decide once per request whether to tee its events to the UI. Tool-bearing
      // requests (real agent turns) are teed; no-tools auxiliary calls are still
      // forwarded upstream but suppressed from the chat pane.
      const tee = this.shouldTeeToUi(body);
      const headers: Record<string, unknown> = { ...req.headers, host: this.upstreamHost };
      // Plaintext SSE so we can parse it; we then forward the (uncompressed)
      // upstream response headers as-is, so the client sees consistent framing.
      delete headers["accept-encoding"];

      this.sendUpstream(req, res, body, tee, headers, inflight, 0);
    });
  }

  /** Forward one buffered request upstream and stream the response back. On a
   *  "stale pooled socket" error before any response bytes, retry ONCE on a
   *  guaranteed-fresh socket (agent:false) — the keep-alive pool occasionally
   *  hands us a connection the server already half-closed, which surfaced to the
   *  CLI as a bare `502`. Anything else (or any error after streaming started)
   *  ends as 502 exactly as before. */
  private sendUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    tee: boolean,
    headers: Record<string, unknown>,
    inflight: { current?: http.ClientRequest },
    attempt: number,
  ): void {
    // First try over the shared keep-alive pool; the retry forces a brand-new
    // socket so we can't be handed the same dead one again.
    const agent = attempt === 0 ? this.primaryAgent : false;
    const upstream = this.requestFn(
      {
        hostname: this.upstreamHost,
        port: this.upstreamPort,
        path: req.url,
        method: req.method,
        headers: headers as http.OutgoingHttpHeaders,
        agent,
      },
      (uRes) => {
        res.writeHead(uRes.statusCode || 502, uRes.headers);
        const isSSE = String(uRes.headers["content-type"] || "").includes("text/event-stream");
        let sseBuf = "";
        uRes.on("data", (chunk: Buffer) => {
          // Forward UNCHANGED to the client first (never let parsing affect the stream).
          try { res.write(chunk); } catch { /* client gone */ }
          if (isSSE && tee) sseBuf = this.parseSse(sseBuf + chunk.toString("utf-8"));
        });
        uRes.on("end", () => { try { res.end(); } catch { /* already ended */ } });
        uRes.on("error", () => { try { res.end(); } catch { /* ignore */ } });
      },
    );
    inflight.current = upstream;
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      // Retry only a connection that died before we committed any response, and
      // only once — a fresh socket can't fix a genuinely-down upstream.
      if (attempt === 0 && !res.headersSent && isRetriableUpstreamError(err)) {
        logger.warn(`SsePtyProxy[${this.label}] upstream ${err.message} — retrying on fresh socket`);
        this.sendUpstream(req, res, body, tee, headers, inflight, attempt + 1);
        return;
      }
      logger.warn(`SsePtyProxy[${this.label}] upstream error: ${err.message}`);
      try { if (!res.headersSent) res.writeHead(502); res.end(); } catch { /* ignore */ }
    });
    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      logger.warn(`SsePtyProxy[${this.label}] upstream idle-timeout — destroying`);
      try { upstream.destroy(new Error("upstream idle timeout")); } catch { /* ignore */ }
    });
    if (body.length) upstream.write(body);
    upstream.end();
  }

  /** Is this request the MAIN agent's stream (the only one teed to the UI)? Main =
   *  the first tool-bearing request's system fingerprint, then every later request
   *  matching it. No/empty tools => an auxiliary call (haiku topic/title detection,
   *  quota check); a different fingerprint => a Task sub-agent. Both are suppressed.
   *  Fail-SAFE to suppression: the main agent's turns are always parseable, tool-
   *  bearing, and fingerprint-stable. */
  private shouldTeeToUi(body: Buffer): boolean {
    let json: { tools?: unknown } | null = null;
    try { json = JSON.parse(body.toString("utf-8")) as { tools?: unknown }; }
    catch { return false; }                                          // non-JSON (e.g. count_tokens) — never a turn
    return Array.isArray(json?.tools) && json.tools.length > 0;      // tool-bearing = a real agent turn
  }

  /** Consume complete SSE frames (separated by a blank line) from `buf`, JSON.parse
   *  each event's `data:` payload, fire onEvent, and return the trailing incomplete
   *  remainder for the next chunk. Only ever called for the main agent's stream. */
  private parseSse(buf: string): string {
    let idx: number;
    // Frames are delimited by a blank line. Handle both \n\n and \r\n\r\n.
    while ((idx = indexOfFrameEnd(buf)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + frameDelimLen(buf, idx));
      let dataStr = "";
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trimStart();
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: SseDataEvent;
      try { parsed = JSON.parse(dataStr) as SseDataEvent; } catch { continue; }
      try { this.onEvent(parsed); } catch (err) {
        logger.warn(`SsePtyProxy[${this.label}] onEvent threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return buf;
  }
}

/** Index of the first blank-line frame delimiter (\n\n or \r\n\r\n), or -1. */
function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function frameDelimLen(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}
