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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../shared/logger.js";

export interface DeviceAuthInfo {
  url: string;
  code: string;
}

/** Strip ANSI escape codes so regex matches the plain text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*m/g, "");
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

export type AuthStatus = "connected" | "pending" | "not_connected" | "failed";

interface AuthState {
  status: AuthStatus;
  url?: string;
  code?: string;
  error?: string;
  proc?: ChildProcess;
  startedAt?: number;
}

const states = new Map<string, AuthState>();

/** Whether device-auth is supported for an engine. Only Codex for now. */
export function supportsDeviceAuth(engine: string): boolean {
  return engine === "codex";
}

/** Path to an engine's auth credentials file (existence ⇒ logged in). */
function authFilePath(engine: string): string | null {
  if (engine === "codex") return path.join(os.homedir(), ".codex", "auth.json");
  return null;
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

/** Cancel an in-flight device-auth flow (e.g. user closed the dialog). */
export function cancelDeviceAuth(engine: string): void {
  const s = states.get(engine);
  s?.proc?.kill();
  states.delete(engine);
}
