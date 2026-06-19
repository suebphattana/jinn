import { describe, it, expect } from "vitest";
import { parseDeviceAuth, supportsDeviceAuth } from "../engine-auth.js";

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
  it("does not support claude (uses setup-token instead)", () => {
    expect(supportsDeviceAuth("claude")).toBe(false);
  });
});
