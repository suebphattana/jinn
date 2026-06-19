/**
 * Engine authentication via OAuth device flow.
 *
 * For subscription-based engines (Codex → ChatGPT Plus/Pro), customers can't use
 * the browser/localhost OAuth on a remote server. Codex exposes a device-code
 * flow (`codex login --device-auth`) that prints a verification URL + one-time
 * code; the user enters the code on any browser and the CLI completes the login
 * on the server, writing its auth file. This module drives that flow so the web
 * UI can surface the code/URL and poll for completion — no API key, no terminal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../shared/logger.js";

export interface DeviceAuthInfo {
  url: string;
  code: string;
}

/** Strip ANSI escape codes so regex matches the plain text. Removes ALL CSI
 *  sequences (colours AND cursor moves like ESC[2G that Ink TUIs emit), OSC
 *  sequences, and single-char escapes — not just SGR colours. */
function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "") // OSC … BEL/ST
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "") // CSI (colours, cursor moves, …)
    .replace(/\x1B[@-Z\\-_]/g, ""); // other single-char escapes
  /* eslint-enable no-control-regex */
}

/**
 * Parse a verification URL + one-time code out of `codex login --device-auth`
 * output. Pure so it can be unit-tested against captured CLI text.
 */
export function parseDeviceAuth(output: string): Partial<DeviceAuthInfo> {
  const clean = stripAnsi(output);
  const url =
    clean.match(/https?:\/\/\S*device\S*/i)?.[0] ??
    clean.match(/https?:\/\/auth\.openai\.com\/\S+/i)?.[0];
  // One-time codes look like ABCD-EFGH (letters/digits, a hyphen).
  const code = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1];
  return {
    ...(url ? { url: url.replace(/[).,]+$/, "") } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Extract an OAuth "authorize" URL from CLI output (Claude's setup-token prints
 * `https://claude.com/.../oauth/authorize?...`). Pure for unit testing.
 */
export function parseAuthUrl(output: string): string | undefined {
  const lines = stripAnsi(output).split(/\r?\n/);
  // Find the line where the URL begins.
  const start = lines.findIndex((l) => /https?:\/\//i.test(l));
  if (start === -1) return undefined;
  // The URL soft-wraps across following lines; collect until the first blank
  // line (the "Paste code here" prompt lives AFTER that blank line, so this
  // stops us from gluing it onto the URL).
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].trim() === "") break;
    block.push(lines[i]);
  }
  // Rejoin the wrapped pieces (terminal wrap inserts no real spaces in a URL)
  // and pull out the URL.
  const joined = block.join("").replace(/\s+/g, "");
  const m = joined.match(/https?:\/\/\S+/i);
  return m?.[0]?.replace(/[).,]+$/, "");
}

/** How an engine authenticates: codex polls (device), claude needs a pasted code. */
export type AuthMode = "device" | "paste-code" | null;
export function authMode(engine: string): AuthMode {
  if (engine === "codex") return "device";
  if (engine === "claude") return "paste-code";
  return null;
}

export type AuthStatus = "connected" | "pending" | "not_connected" | "failed";

interface AuthState {
  status: AuthStatus;
  url?: string;
  code?: string;
  error?: string;
  proc?: ChildProcess;
  term?: pty.IPty;
  baselineMtime?: number;
  startedAt?: number;
  /** Accumulated PTY output for the paste-code flow (token is scraped from it). */
  buf?: string;
}

/** Extract a Claude long-lived OAuth token from setup-token output. The TUI may
 *  soft-wrap it, so fall back to a whitespace-stripped match. */
export function extractOAuthToken(raw: string): string | undefined {
  const clean = stripAnsi(raw);
  const direct = clean.match(/sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/);
  if (direct && direct[0].length >= 40) return direct[0];
  const compact = clean.replace(/\s+/g, "");
  const wrapped = compact.match(/sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/);
  return wrapped && wrapped[0].length >= 40 ? wrapped[0] : undefined;
}

/** Write a Claude credentials file the engine can read, from a captured token.
 *  `claude setup-token` prints the token but doesn't persist it — so we do. */
export function writeClaudeCredentials(engine: string, token: string): boolean {
  const file = authFilePath(engine);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      claudeAiOauth: {
        accessToken: token,
        refreshToken: "",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      },
    };
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    return true;
  } catch (err) {
    logger.warn(`Failed to write claude credentials: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

const states = new Map<string, AuthState>();

/** Whether device-auth (auto-polling code) is supported. Only Codex. */
export function supportsDeviceAuth(engine: string): boolean {
  return engine === "codex";
}

/** Whether any UI auth flow is supported for the engine. */
export function supportsAuth(engine: string): boolean {
  return authMode(engine) !== null;
}

/** Path to an engine's auth credentials file (existence ⇒ logged in). */
function authFilePath(engine: string): string | null {
  if (engine === "codex") return path.join(os.homedir(), ".codex", "auth.json");
  if (engine === "claude") {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(dir, ".credentials.json");
  }
  return null;
}

function fileMtime(p: string | null): number {
  try {
    return p ? fs.statSync(p).mtimeMs : 0;
  } catch {
    return 0;
  }
}

/** True when the engine has a credentials file on disk. */
export function isEngineConnected(engine: string): boolean {
  const p = authFilePath(engine);
  return !!p && fs.existsSync(p);
}

/** Current auth status for the UI to render/poll. */
export function getAuthStatus(engine: string): {
  status: AuthStatus;
  url?: string;
  code?: string;
  error?: string;
} {
  if (isEngineConnected(engine)) return { status: "connected" };
  const s = states.get(engine);
  if (s?.status === "pending") return { status: "pending", url: s.url, code: s.code };
  if (s?.status === "failed") return { status: "failed", error: s.error };
  return { status: "not_connected" };
}

/**
 * Start (or resume) a device-auth flow for an engine. Spawns the CLI, captures
 * the URL + code from its output, and leaves the process running in the
 * background to poll for completion (it writes the auth file and exits on
 * success). Resolves once the code/URL are known.
 */
export function startDeviceAuth(engine: string, bin: string): Promise<DeviceAuthInfo> {
  if (!supportsDeviceAuth(engine)) {
    return Promise.reject(new Error(`device-auth not supported for engine '${engine}'`));
  }

  // Already in flight with a known code — hand back the same one.
  const existing = states.get(engine);
  if (existing?.status === "pending" && existing.url && existing.code) {
    return Promise.resolve({ url: existing.url, code: existing.code });
  }
  existing?.proc?.kill();

  return new Promise<DeviceAuthInfo>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(bin, ["login", "--device-auth"], { env: process.env });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const state: AuthState = { status: "pending", proc, startedAt: Date.now() };
    states.set(engine, state);

    let buf = "";
    let settled = false;

    const onData = (d: Buffer) => {
      buf += d.toString();
      const parsed = parseDeviceAuth(buf);
      if (!settled && parsed.url && parsed.code) {
        settled = true;
        state.url = parsed.url;
        state.code = parsed.code;
        resolve({ url: parsed.url, code: parsed.code });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("exit", (exitCode) => {
      const connected = isEngineConnected(engine);
      state.status = connected ? "connected" : "failed";
      if (!connected) state.error = `login process exited (code ${exitCode}) without completing`;
      state.proc = undefined;
      logger.info(`Engine '${engine}' device-auth ${state.status}`);
      if (!settled) {
        settled = true;
        reject(new Error(state.error ?? "login ended before a code was issued"));
      }
    });

    proc.on("error", (err) => {
      state.status = "failed";
      state.error = err.message;
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // Codex prints the code within a second; bail if nothing arrives.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch { /* ignore */ }
        state.status = "failed";
        state.error = "timed out waiting for device code";
        reject(new Error(state.error));
      }
    }, 20_000);
  });
}

/**
 * Start a paste-code auth flow (Claude `setup-token`). Spawns the CLI in a PTY,
 * captures the OAuth URL, and waits for the user to authorize in a browser and
 * paste the resulting code back via submitAuthCode(). Resolves once the URL is
 * known. The code is shown on the OAuth provider's page (not in the terminal),
 * so unlike device-auth we only return a URL here.
 */
export function startPasteCodeAuth(engine: string, bin: string): Promise<{ url: string }> {
  if (authMode(engine) !== "paste-code") {
    return Promise.reject(new Error(`paste-code auth not supported for engine '${engine}'`));
  }

  const existing = states.get(engine);
  if (existing?.status === "pending" && existing.url && existing.term) {
    return Promise.resolve({ url: existing.url });
  }
  try { existing?.term?.kill(); } catch { /* ignore */ }

  return new Promise<{ url: string }>((resolve, reject) => {
    let term: pty.IPty;
    try {
      term = pty.spawn(bin, ["setup-token"], {
        name: "xterm-256color",
        cols: 400, // wide so the long-lived token isn't soft-wrapped across lines
        rows: 30,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const state: AuthState = {
      status: "pending",
      term,
      baselineMtime: fileMtime(authFilePath(engine)),
      startedAt: Date.now(),
      buf: "",
    };
    states.set(engine, state);

    let settled = false;
    term.onData((d) => {
      // Accumulate on state so submitAuthCode can scrape the token later.
      state.buf = (state.buf ?? "") + d;
      if (!settled) {
        const url = parseAuthUrl(state.buf);
        if (url) {
          settled = true;
          state.url = url;
          resolve({ url });
        }
      }
    });
    term.onExit(() => {
      state.term = undefined;
      if (!settled) {
        settled = true;
        state.status = "failed";
        state.error = "login process exited before issuing a URL";
        reject(new Error(state.error));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { term.kill(); } catch { /* ignore */ }
        state.status = "failed";
        state.error = "timed out waiting for the sign-in URL";
        reject(new Error(state.error));
      }
    }, 20_000);
  });
}

/**
 * Submit the code the user copied from the OAuth page into the waiting PTY, then
 * wait for the credentials file to be written (mtime advances). Resolves with
 * the resulting status.
 */
export function submitAuthCode(engine: string, code: string): Promise<{ status: AuthStatus; error?: string }> {
  const state = states.get(engine);
  if (!state?.term) {
    return Promise.resolve({ status: "failed", error: "no login in progress — start again" });
  }
  // Type the code, THEN send Enter separately. If we send `code\r` in one
  // write, Ink treats the \r as part of the paste burst (literal text) and
  // never submits — the field fills but setup-token keeps waiting → timeout.
  state.term.write(code.trim());
  setTimeout(() => {
    try { state.term?.write("\r"); } catch { /* ignore */ }
  }, 300);

  const authFile = authFilePath(engine);
  const baseline = state.baselineMtime ?? 0;
  const deadline = Date.now() + 45_000;

  return new Promise((resolve) => {
    const tick = setInterval(() => {
      // Primary path: `claude setup-token` prints a long-lived token but never
      // writes a credentials file — scrape it from the PTY output and write the
      // file ourselves (the format the claude engine reads).
      const token = engine === "claude" ? extractOAuthToken(state.buf ?? "") : undefined;
      if (token) {
        clearInterval(tick);
        const wrote = writeClaudeCredentials(engine, token);
        state.status = wrote ? "connected" : "failed";
        if (!wrote) state.error = "captured a token but couldn't write credentials";
        try { state.term?.kill(); } catch { /* ignore */ }
        state.term = undefined;
        logger.info(`Engine '${engine}' paste-code auth ${state.status} (token captured)`);
        resolve(wrote ? { status: "connected" } : { status: "failed", error: state.error });
        return;
      }
      // Fallback: some CLI versions write the credentials file directly.
      if (fileMtime(authFile) > baseline) {
        clearInterval(tick);
        state.status = "connected";
        try { state.term?.kill(); } catch { /* ignore */ }
        state.term = undefined;
        logger.info(`Engine '${engine}' paste-code auth connected (credentials file)`);
        resolve({ status: "connected" });
        return;
      }
      if (!state.term || Date.now() > deadline) {
        clearInterval(tick);
        state.status = "failed";
        state.error = !state.term ? "login process exited without completing" : "timed out after submitting code";
        resolve({ status: "failed", error: state.error });
      }
    }, 1000);
  });
}

/** Cancel an in-flight auth flow (e.g. user closed the dialog). */
export function cancelDeviceAuth(engine: string): void {
  const s = states.get(engine);
  s?.proc?.kill();
  try { s?.term?.kill(); } catch { /* ignore */ }
  states.delete(engine);
}
