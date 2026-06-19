import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDeviceAuth, supportsDeviceAuth, parseAuthUrl, authMode, supportsAuth, extractOAuthToken, writeClaudeCredentials, isEngineConnected } from "../engine-auth.js";

describe("parseDeviceAuth", () => {
  it("extracts url + code from real codex --device-auth output", () => {
    // Captured from `codex login --device-auth` (ANSI colours included).
    const out =
      "\nWelcome to Codex [\x1b[90mv0.141.0\x1b[0m]\n" +
      "\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link in your browser and sign in to your account\n" +
      "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
      "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n" +
      "   \x1b[94mVM0A-W5WIQ\x1b[0m\n";
    const r = parseDeviceAuth(out);
    expect(r.url).toBe("https://auth.openai.com/codex/device");
    expect(r.code).toBe("VM0A-W5WIQ");
  });

  it("returns partial when only the URL has arrived yet", () => {
    const r = parseDeviceAuth("navigate to https://auth.openai.com/codex/device");
    expect(r.url).toBe("https://auth.openai.com/codex/device");
    expect(r.code).toBeUndefined();
  });

  it("returns empty for unrelated text", () => {
    const r = parseDeviceAuth("starting up, please wait...");
    expect(r.url).toBeUndefined();
    expect(r.code).toBeUndefined();
  });

  it("strips trailing punctuation from the url", () => {
    const r = parseDeviceAuth("open (https://auth.openai.com/codex/device).");
    expect(r.url).toBe("https://auth.openai.com/codex/device");
  });

  it("matches codes of varying length", () => {
    expect(parseDeviceAuth("code ABCD-EFGHI").code).toBe("ABCD-EFGHI");
    expect(parseDeviceAuth("code WXYZ-1234").code).toBe("WXYZ-1234");
  });
});

describe("supportsDeviceAuth", () => {
  it("supports codex", () => {
    expect(supportsDeviceAuth("codex")).toBe(true);
  });
  it("does not device-auth claude (it pastes a code instead)", () => {
    expect(supportsDeviceAuth("claude")).toBe(false);
  });
});

describe("authMode / supportsAuth", () => {
  it("codex uses device mode", () => {
    expect(authMode("codex")).toBe("device");
    expect(supportsAuth("codex")).toBe(true);
  });
  it("claude uses paste-code mode", () => {
    expect(authMode("claude")).toBe("paste-code");
    expect(supportsAuth("claude")).toBe(true);
  });
  it("unknown engines have no auth", () => {
    expect(authMode("grok")).toBeNull();
    expect(supportsAuth("grok")).toBe(false);
  });
});

describe("extractOAuthToken (Claude setup-token)", () => {
  it("extracts a token printed on one line", () => {
    const out = "Success! Your token:\n  sk-ant-oat01-AbCdEf0123456789_-XYZabcdef0123456789ghijklmnop\n";
    expect(extractOAuthToken(out)).toBe(
      "sk-ant-oat01-AbCdEf0123456789_-XYZabcdef0123456789ghijklmnop",
    );
  });

  it("recovers a soft-wrapped token (whitespace fallback)", () => {
    const wrapped =
      "sk-ant-oat01-AbCdEf0123456789_-XYZabcdef01234\n56789ghijklmnopQRSTUVWXYZ0123456789";
    const token = extractOAuthToken(wrapped);
    expect(token?.startsWith("sk-ant-oat01-")).toBe(true);
    expect(token).not.toMatch(/\s/);
    expect(token!.length).toBeGreaterThan(40);
  });

  it("ignores short false positives / unrelated text", () => {
    expect(extractOAuthToken("no token here, just sk-ant-oat01-short")).toBeUndefined();
    expect(extractOAuthToken("loading…")).toBeUndefined();
  });
});

describe("writeClaudeCredentials", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cred-"));
    prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a claudeAiOauth credentials file the engine can read", () => {
    const ok = writeClaudeCredentials("claude", "sk-ant-oat01-TESTTOKEN");
    expect(ok).toBe(true);
    expect(isEngineConnected("claude")).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
    expect(json.claudeAiOauth.accessToken).toBe("sk-ant-oat01-TESTTOKEN");
    expect(json.claudeAiOauth.scopes).toContain("user:inference");
    expect(json.claudeAiOauth.subscriptionType).toBe("max");
    expect(json.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("parseAuthUrl (Claude setup-token)", () => {
  it("extracts the oauth authorize url from real PTY output", () => {
    // From `claude setup-token` (soft-wrapped across terminal lines, ANSI).
    const out =
      "Browser didn't open? Use the url below to sign in (c to copy)\n\n" +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&resp\n" +
      "onse_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3\n" +
      "Ainference&code_challenge=OnFU&state=gViR\n\nPaste code here if prompted >";
    const url = parseAuthUrl(out);
    expect(url).toContain("https://claude.com/cai/oauth/authorize?");
    expect(url).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    // soft-wrap rejoined (no embedded spaces/newlines)
    expect(url).not.toMatch(/\s/);
  });

  it("returns undefined when no authorize url present", () => {
    expect(parseAuthUrl("Welcome to Claude Code\nLoading...")).toBeUndefined();
  });

  it("strips Ink cursor-move codes and does not glue the 'Paste code' prompt", () => {
    // Ink TUI emits cursor moves (ESC[2G, ESC[8G) + the prompt sits after a blank line.
    const out =
      "\x1b[2GBrowser didn't open? Use the url below\x1b[0m\n\n" +
      "\x1b[8Ghttps://claude.com/cai/oauth/authorize?client_id=abc&state=XYZ\n\n" +
      "\x1b[2GPaste\x1b[8Gcode here if prompted >";
    const url = parseAuthUrl(out);
    expect(url).toBe("https://claude.com/cai/oauth/authorize?client_id=abc&state=XYZ");
    expect(url).not.toMatch(/paste/i);
    expect(url).not.toMatch(/\s/);
  });
});
