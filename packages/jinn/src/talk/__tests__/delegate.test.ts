import { describe, it, expect, vi } from "vitest";
import { delegateToThread, type DelegateDeps } from "../delegate.js";
import type { Session } from "../../shared/types.js";

function fakeSession(over: Partial<Session>): Session {
  return {
    id: "t1",
    engine: "claude",
    engineSessionId: null,
    source: "talk",
    sourceRef: "talk:main",
    connector: "web",
    sessionKey: "talk:main",
    employee: null,
    model: null,
    title: "Talk",
    parentSessionId: null,
    userId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    replyContext: null,
    messageId: null,
    transportMeta: null,
    createdAt: "2026-06-10T00:00:00Z",
    lastActivity: "2026-06-10T00:00:00Z",
    lastError: null,
    ...over,
  } as Session;
}

function deps(over: Partial<DelegateDeps> = {}): DelegateDeps {
  return {
    getSession: (id) => (id === "t1" ? fakeSession({}) : undefined),
    listChildSessions: () => [
      fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Pravko" }),
    ],
    spawnChild: vi.fn(async () => ({ id: "new-child" })),
    continueThread: vi.fn(async () => {}),
    updateSession: vi.fn(),
    emit: vi.fn(),
    ...over,
  };
}

describe("delegateToThread", () => {
  it("spawns a new COO child with thread:'new', sets title, emits thread label", async () => {
    const d = deps();
    const r = await delegateToThread(
      { sessionId: "t1", thread: "new", label: "Pravko pipeline", brief: "Run phase 2" },
      d,
    );
    expect(r).toEqual({ ok: true, threadId: "new-child", created: true });
    expect(d.spawnChild).toHaveBeenCalledWith({ prompt: "Run phase 2", parentSessionId: "t1" });
    expect(d.updateSession).toHaveBeenCalledWith("new-child", { title: "Pravko pipeline" });
    expect(d.emit).toHaveBeenCalledWith("talk:thread:label", {
      sessionId: "t1",
      threadId: "new-child",
      label: "Pravko pipeline",
    });
  });

  it("continues an existing child thread", async () => {
    const d = deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "c1"
            ? fakeSession({ id: "c1", source: "web", parentSessionId: "t1", title: "Pravko" })
            : undefined,
    });
    const r = await delegateToThread({ sessionId: "t1", thread: "c1", brief: "Follow up" }, d);
    expect(r).toEqual({ ok: true, threadId: "c1", created: false });
    expect(d.continueThread).toHaveBeenCalledWith("c1", "Follow up");
  });

  it("rejects an unknown thread id with the live roster", async () => {
    const r = await delegateToThread({ sessionId: "t1", thread: "nope", brief: "x" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.threads).toEqual([{ id: "c1", label: "Pravko", status: "idle" }]);
    }
  });

  it("rejects a non-talk sessionId", async () => {
    const d = deps({ getSession: () => fakeSession({ id: "w1", source: "web" }) });
    const r = await delegateToThread({ sessionId: "w1", thread: "new", brief: "x" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects empty brief and missing sessionId", async () => {
    expect(
      (await delegateToThread({ sessionId: "t1", thread: "new", brief: "  " }, deps())).ok,
    ).toBe(false);
    expect((await delegateToThread({ thread: "new", brief: "x" }, deps())).ok).toBe(false);
  });

  it("defaults the label from the brief when omitted on a new thread", async () => {
    const d = deps();
    await delegateToThread(
      { sessionId: "t1", thread: "new", brief: "Check the MoveKit order status please" },
      d,
    );
    // Brief is 37 chars → slice(0,35).trimEnd() + "…"
    expect(d.updateSession).toHaveBeenCalledWith("new-child", {
      title: "Check the MoveKit order status plea…",
    });
  });

  it("rejects continuing a child that belongs to a DIFFERENT talk session", async () => {
    const d = deps({
      getSession: (id) =>
        id === "t1"
          ? fakeSession({})
          : id === "foreign"
            ? fakeSession({ id: "foreign", source: "web", parentSessionId: "other-talk", title: "Foreign" })
            : undefined,
    });
    const r = await delegateToThread({ sessionId: "t1", thread: "foreign", brief: "x" }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.threads).toEqual([{ id: "c1", label: "Pravko", status: "idle" }]);
    }
    expect(d.continueThread).not.toHaveBeenCalled();
  });
});
