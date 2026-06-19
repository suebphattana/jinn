/**
 * Simple shared-password auth for the web UI.
 *
 * Two secrets in config.gateway:
 *  - authPassword — sha256 hash of the web-UI login password. Unset ⇒ no login
 *    required (opt-in, so fresh installs / golden images aren't locked out).
 *  - adminKey — a master key (plaintext) the operator's external app holds. It
 *    authenticates the remote reset endpoint AND lets trusted automation bypass
 *    the cookie login (the gateway can't tell nginx-proxied from local traffic,
 *    so we authenticate by key, not source IP).
 *
 * Login flow: POST /api/login {password} → if it hashes to authPassword, set an
 * httpOnly cookie whose value is derived from the stored hash (so changing the
 * password invalidates old sessions). Middleware accepts a valid cookie OR the
 * admin key header.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { JinnConfig } from "../shared/types.js";

const SESSION_SALT = "jinn-web-session-v1";
export const SESSION_COOKIE = "jinn_session";
export const ADMIN_HEADER = "x-jinn-admin-key";

/** sha256 hex of a string. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash a plaintext password for storage in config.gateway.authPassword. */
export function hashPassword(plain: string): string {
  return sha256(plain);
}

/** The session-cookie value for a given stored password hash. Deterministic, so
 *  a password change rotates the value and invalidates existing cookies. */
export function sessionToken(passwordHash: string): string {
  return sha256(`${passwordHash}:${SESSION_SALT}`);
}

/** Constant-time-ish string compare (length-leak only). */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse a Cookie header into a map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Whether web auth is enabled (a password is configured). */
export function authEnabled(config: JinnConfig): boolean {
  return !!config.gateway.authPassword;
}

/** API path prefixes reachable WITHOUT a login (so the login screen can work). */
const PUBLIC_API_PREFIXES = ["/api/login", "/api/auth/status", "/api/admin/"];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/** Does this request carry valid credentials (cookie OR admin key)? */
export function isAuthed(req: Pick<IncomingMessage, "headers">, config: JinnConfig): boolean {
  if (!authEnabled(config)) return true; // opt-in: no password set ⇒ open
  const adminKey = config.gateway.adminKey;
  if (adminKey) {
    const provided = req.headers[ADMIN_HEADER];
    if (typeof provided === "string" && safeEqual(provided, adminKey)) return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  const expected = sessionToken(config.gateway.authPassword!);
  return safeEqual(cookies[SESSION_COOKIE], expected);
}
