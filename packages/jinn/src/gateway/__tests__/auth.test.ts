import { describe, it, expect } from "vitest";
import {
  hashPassword,
  sessionToken,
  safeEqual,
  parseCookies,
  authEnabled,
  isPublicApiPath,
  isAuthed,
  SESSION_COOKIE,
  ADMIN_HEADER,
} from "../auth.js";
import type { JinnConfig } from "../../shared/types.js";

function cfg(gateway: Record<string, unknown> = {}): JinnConfig {
  return { gateway: { port: 7777, host: "127.0.0.1", ...gateway } } as unknown as JinnConfig;
}

describe("password hashing", () => {
  it("hashes deterministically and differs per input", () => {
    expect(hashPassword("hunter2")).toBe(hashPassword("hunter2"));
    expect(hashPassword("a")).not.toBe(hashPassword("b"));
    expect(hashPassword("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("session token derives from the hash (rotates when password changes)", () => {
    const h1 = hashPassword("one");
    const h2 = hashPassword("two");
    expect(sessionToken(h1)).not.toBe(sessionToken(h2));
    expect(sessionToken(h1)).toBe(sessionToken(h1));
  });
});

describe("safeEqual", () => {
  it("matches equal strings, rejects others/undefined", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual(undefined, "abc")).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("a=1; jinn_session=tok; b=2").jinn_session).toBe("tok");
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("isPublicApiPath", () => {
  it("treats login/auth-status/admin as public", () => {
    expect(isPublicApiPath("/api/login")).toBe(true);
    expect(isPublicApiPath("/api/auth/status")).toBe(true);
    expect(isPublicApiPath("/api/admin/reset-password")).toBe(true);
    expect(isPublicApiPath("/api/config")).toBe(false);
    expect(isPublicApiPath("/api/sessions")).toBe(false);
  });
});

describe("authEnabled / isAuthed", () => {
  it("is open when no password configured", () => {
    expect(authEnabled(cfg())).toBe(false);
    expect(isAuthed({ headers: {} }, cfg())).toBe(true);
  });

  it("requires credentials when a password is set", () => {
    const c = cfg({ authPassword: hashPassword("pw") });
    expect(authEnabled(c)).toBe(true);
    expect(isAuthed({ headers: {} }, c)).toBe(false);
  });

  it("accepts a valid session cookie", () => {
    const c = cfg({ authPassword: hashPassword("pw") });
    const cookie = `${SESSION_COOKIE}=${sessionToken(c.gateway.authPassword!)}`;
    expect(isAuthed({ headers: { cookie } }, c)).toBe(true);
  });

  it("rejects a stale cookie after the password changes", () => {
    const old = sessionToken(hashPassword("old"));
    const c = cfg({ authPassword: hashPassword("new") });
    expect(isAuthed({ headers: { cookie: `${SESSION_COOKIE}=${old}` } }, c)).toBe(false);
  });

  it("accepts the admin key header (automation / fleet ops)", () => {
    const c = cfg({ authPassword: hashPassword("pw"), adminKey: "MASTER-KEY" });
    expect(isAuthed({ headers: { [ADMIN_HEADER]: "MASTER-KEY" } }, c)).toBe(true);
    expect(isAuthed({ headers: { [ADMIN_HEADER]: "wrong" } }, c)).toBe(false);
  });
});
