import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "../server.js";

describe("CORS origin policy", () => {
  it("allows absent origins for same-origin requests and CLI/curl clients", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
  });

  it("allows loopback browser origins used by local dashboard/dev servers", () => {
    expect(isAllowedCorsOrigin("http://localhost:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://app.localhost:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://0.0.0.0:7777")).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:7777")).toBe(true);
  });

  it("rejects arbitrary web origins instead of reflecting a wildcard", () => {
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("file://localhost/tmp/x.html")).toBe(false);
    expect(isAllowedCorsOrigin("not a url")).toBe(false);
  });
});
