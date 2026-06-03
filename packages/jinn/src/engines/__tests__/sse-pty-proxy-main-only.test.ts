import { describe, it, expect } from "vitest";
import { SsePtyProxy } from "../sse-pty-proxy.js";

// Locks the tee gate. We tee tool-bearing requests (genuine agent turns) to the UI
// and suppress only no-tools auxiliary calls (haiku topic/title detection, quota
// checks — whose output, e.g. a title-gen {"title":...}, must not leak into the
// transcript). We deliberately do NOT fingerprint main-vs-sub-agent: the main
// agent's own requests don't share a stable signature (proven in production — a
// 27-tool pre-flight then a 55-tool turn), so any such heuristic dropped real turns
// and broke streaming.

/** shouldTeeToUi is private; reach it directly for a focused unit test. */
function tee(proxy: SsePtyProxy, body: unknown): boolean {
  return (proxy as unknown as { shouldTeeToUi(b: Buffer): boolean })
    .shouldTeeToUi(Buffer.from(JSON.stringify(body)));
}

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
const newProxy = () => new SsePtyProxy("test", () => {});

describe("SsePtyProxy.shouldTeeToUi", () => {
  it("tees any tool-bearing request (the real agent turn always has tools)", () => {
    const proxy = newProxy();
    expect(tee(proxy, { system: "MAIN", messages: [], tools: TOOLS })).toBe(true);
    // A larger/later turn with a different tool set still tees — no fingerprinting.
    expect(tee(proxy, { system: "DIFFERENT", messages: [], tools: [...TOOLS, ...TOOLS] })).toBe(true);
  });

  it("suppresses no-tools auxiliary calls (title/topic gen, quota checks)", () => {
    const proxy = newProxy();
    expect(tee(proxy, { system: "title-gen", messages: [] })).toBe(false);      // tools absent
    expect(tee(proxy, { system: "topic-detector", messages: [], tools: [] })).toBe(false); // tools empty
  });

  it("suppresses non-JSON bodies (e.g. count_tokens)", () => {
    const proxy = newProxy();
    expect((proxy as unknown as { shouldTeeToUi(b: Buffer): boolean }).shouldTeeToUi(Buffer.from("not json"))).toBe(false);
  });
});
