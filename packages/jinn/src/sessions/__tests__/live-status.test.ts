import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveStatusStreamer } from "../live-status.js";
import type { Connector, Target, StreamDelta } from "../../shared/types.js";

function mockConnector() {
  const sends: string[] = [];
  const edits: Array<{ id: string | undefined; text: string }> = [];
  let nextId = 1;
  const connector = {
    sendMessage: vi.fn(async (_t: Target, text: string) => {
      sends.push(text);
      return `msg-${nextId++}`;
    }),
    editMessage: vi.fn(async (t: Target, text: string) => {
      edits.push({ id: t.messageTs, text });
    }),
  } as unknown as Connector;
  return { connector, sends, edits };
}

const target: Target = { channel: "C1" };

function toolUse(name: string, input?: string): StreamDelta {
  return { type: "tool_use", content: name, toolName: name, ...(input ? { input } : {}) };
}

describe("LiveStatusStreamer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("edit mode: creates one message then edits in place", async () => {
    const { connector, sends, edits } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");

    s.handle(toolUse("Bash", '{"command":"ls -la /home"}'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Bash");
    expect(sends[0]).toContain("ls -la /home");

    s.handle(toolUse("Read", '{"file_path":"manager.ts"}'));
    await vi.advanceTimersByTimeAsync(2600);
    expect(sends).toHaveLength(1); // still ONE message
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[edits.length - 1].id).toBe("msg-1");
    expect(edits[edits.length - 1].text).toContain("Read");
  });

  it("edit mode: does NOT re-edit when no new steps arrive (no flicker)", async () => {
    const { connector, sends, edits } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");

    s.handle(toolUse("Bash", '{"command":"ls"}'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sends).toHaveLength(1);

    // No further deltas — advancing time must NOT trigger redundant edits.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(edits).toHaveLength(0);
    expect(sends).toHaveLength(1);
  });

  it("edit mode: rapid deltas coalesce into few throttled writes", async () => {
    const { connector, sends, edits } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");

    // 20 distinct tools fired over ~2s (faster than the throttle window).
    for (let i = 0; i < 20; i++) {
      s.handle(toolUse(`Tool${i}`, `{"command":"c${i}"}`));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(3000);
    // Far fewer writes than deltas — coalesced by the 2.5s throttle.
    expect(sends.length + edits.length).toBeLessThan(6);
  });

  it("collapses claude's bare + input tool_use pair into one step", async () => {
    const { connector, sends } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");

    s.handle(toolUse("Bash")); // SSE content_block_start — no input
    s.handle(toolUse("Bash", '{"command":"echo hi"}')); // PreToolUse — with input
    await vi.advanceTimersByTimeAsync(10);

    const lines = sends[0].split("\n").filter((l) => l.includes("Bash"));
    expect(lines).toHaveLength(1);
    expect(sends[0]).toContain("echo hi");
  });

  it("append mode: posts a new message per batch and never edits", async () => {
    const { connector, sends, edits } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "append");

    s.handle(toolUse("Bash", '{"command":"a"}'));
    await vi.advanceTimersByTimeAsync(10);
    s.handle(toolUse("Read", '{"file_path":"b"}'));
    await vi.advanceTimersByTimeAsync(2600);

    expect(edits).toHaveLength(0);
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  it("finish() stops further writes", async () => {
    const { connector, sends } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");
    s.handle(toolUse("Bash", '{"command":"x"}'));
    s.finish();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sends).toHaveLength(0);
  });

  it("ignores text/context deltas", async () => {
    const { connector, sends } = mockConnector();
    const s = new LiveStatusStreamer(connector, target, "edit");
    s.handle({ type: "text", content: "hello" });
    s.handle({ type: "context", content: "1234" });
    await vi.advanceTimersByTimeAsync(10);
    expect(sends).toHaveLength(0);
  });
});
