import { describe, it, expect } from "vitest";
import { SsePtyProxy } from "../sse-pty-proxy.js";

// Locks the main-only streaming gate. Only the MAIN agent's stream is teed to the
// UI; Task sub-agents (different system fingerprint) and auxiliary calls (haiku
// topic/title detection, quota checks — no tools) are suppressed. Suppressing
// these is what keeps the transcript clean: no per-sub-agent cards, and no
// auxiliary output (e.g. a title-gen `{"title":...}`) leaking into the chat.

/** isMainAgentStream is private; reach it directly for a focused unit test. */
function isMain(proxy: SsePtyProxy, body: unknown): boolean {
  return (proxy as unknown as { isMainAgentStream(b: Buffer): boolean })
    .isMainAgentStream(Buffer.from(JSON.stringify(body)));
}

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
const newProxy = () => new SsePtyProxy("test", () => {});

describe("SsePtyProxy.isMainAgentStream", () => {
  it("streams the main agent (first tool-bearing request) and its later turns", () => {
    const proxy = newProxy();
    const main = { system: "MAIN", messages: [{ role: "user", content: "x" }], tools: TOOLS };
    expect(isMain(proxy, main)).toBe(true);  // first tool turn = main
    expect(isMain(proxy, main)).toBe(true);  // same fingerprint = still main
  });

  it("suppresses a Task sub-agent (tool-bearing, different system)", () => {
    const proxy = newProxy();
    isMain(proxy, { system: "MAIN", messages: [], tools: TOOLS }); // establish main
    expect(isMain(proxy, { system: "SUBAGENT", messages: [], tools: TOOLS })).toBe(false);
  });

  it("suppresses auxiliary calls (no tools) and never lets them become main", () => {
    const proxy = newProxy();
    // Aux lands first — must NOT poison the baseline...
    expect(isMain(proxy, { system: "topic-detector", messages: [] })).toBe(false);
    expect(isMain(proxy, { system: "title-gen", messages: [], tools: [] })).toBe(false);
    // ...so the first real tool turn still becomes main.
    expect(isMain(proxy, { system: "MAIN", messages: [], tools: TOOLS })).toBe(true);
  });

  it("fails safe to suppression on an unparseable / system-less body", () => {
    const proxy = newProxy();
    expect((proxy as unknown as { isMainAgentStream(b: Buffer): boolean }).isMainAgentStream(Buffer.from("not json"))).toBe(false);
    expect(isMain(proxy, { messages: [], tools: TOOLS })).toBe(false); // no system
  });
});
