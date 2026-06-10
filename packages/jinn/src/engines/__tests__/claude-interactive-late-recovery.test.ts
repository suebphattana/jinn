import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

describe("InteractiveClaudeEngine — late-recovery supersede", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new HookRegistry();
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
  });
  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("a late Stop after arming delivers the recovered text via onLateRecovery", () => {
    const recovered: Array<{ result: string; sessionId: string }> = [];
    engine.armLateRecovery("jinn-1", {
      prompt: "x", cwd: "/tmp",
      onLateRecovery: (info) => recovered.push(info),
    });
    registry.deliver("jinn-1", { hook_event_name: "Stop", session_id: "claude-abc", last_assistant_message: "late answer" });
    expect(recovered).toEqual([{ result: "late answer", sessionId: "claude-abc" }]);
  });

  it("fires at most once and unregisters after delivery", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("jinn-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "first" });
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "second" });
    expect(recovered).toEqual(["first"]);
  });

  it("ignores non-Stop hooks and empty messages", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("jinn-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    registry.deliver("jinn-1", { hook_event_name: "PostToolUse", tool_name: "Bash" });
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "   " });
    expect(recovered).toEqual([]);
  });

  it("cancelLateRecovery stops the listener (a new turn owns the session)", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("jinn-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    engine.cancelLateRecovery("jinn-1");
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "too late" });
    expect(recovered).toEqual([]);
  });

  it("expires after the recovery window", () => {
    const recovered: string[] = [];
    engine.armLateRecovery("jinn-1", { prompt: "x", cwd: "/tmp", onLateRecovery: (i) => recovered.push(i.result) });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "expired" });
    expect(recovered).toEqual([]);
  });

  it("does nothing when opts.onLateRecovery is absent", () => {
    engine.armLateRecovery("jinn-1", { prompt: "x", cwd: "/tmp" });
    // No listener registered → delivery is buffered by the registry, not crashed on.
    registry.deliver("jinn-1", { hook_event_name: "Stop", last_assistant_message: "ignored" });
    expect(true).toBe(true);
  });
});
