import { describe, it, expect, vi } from "vitest";
import { resolveTalkRoot, buildGraphSnapshot, maybeEmitTalkGraph } from "../graph.js";
import type { Session } from "../../shared/types.js";

function s(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:main",
    connector: "web",
    sessionKey: id,
    employee: null,
    model: null,
    title: null,
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

const sessions = new Map<string, Session>();
const getSession = (id: string) => sessions.get(id);
const listChildSessions = (pid: string) =>
  [...sessions.values()].filter((x) => x.parentSessionId === pid);

function seedTree() {
  sessions.clear();
  sessions.set("root", s("root", { source: "talk" }));
  sessions.set("coo1", s("coo1", { parentSessionId: "root", title: "Pravko", status: "running" }));
  sessions.set("coo2", s("coo2", { parentSessionId: "root", title: "MoveKit" }));
  sessions.set("emp1", s("emp1", { parentSessionId: "coo1", title: null, employee: "pravko-lead", status: "running" }));
}

describe("resolveTalkRoot", () => {
  it("walks any depth up to the talk root", () => {
    seedTree();
    expect(resolveTalkRoot("emp1", getSession)?.id).toBe("root");
    expect(resolveTalkRoot("coo2", getSession)?.id).toBe("root");
    expect(resolveTalkRoot("root", getSession)?.id).toBe("root");
  });
  it("returns undefined for non-talk trees and cycles", () => {
    seedTree();
    sessions.set("loner", s("loner"));
    expect(resolveTalkRoot("loner", getSession)).toBeUndefined();
    sessions.set("a", s("a", { parentSessionId: "b" }));
    sessions.set("b", s("b", { parentSessionId: "a" }));
    expect(resolveTalkRoot("a", getSession)).toBeUndefined();
  });
});

describe("buildGraphSnapshot", () => {
  it("returns all descendants with depth, labels, status", () => {
    seedTree();
    const nodes = buildGraphSnapshot("root", listChildSessions);
    expect(nodes).toHaveLength(3);
    const emp = nodes.find((n) => n.id === "emp1")!;
    expect(emp.depth).toBe(2);
    expect(emp.parentId).toBe("coo1");
    expect(emp.label).toBe("pravko-lead"); // employee fallback when no title
    const coo = nodes.find((n) => n.id === "coo1")!;
    expect(coo.depth).toBe(1);
    expect(coo.label).toBe("Pravko");
    expect(coo.status).toBe("running");
  });
});

describe("maybeEmitTalkGraph", () => {
  it("emits talk:graph for sessions inside a talk tree", () => {
    seedTree();
    const emit = vi.fn();
    maybeEmitTalkGraph("emp1", "added", { getSession, emit });
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe("talk:graph");
    expect(payload.rootId).toBe("root");
    expect(payload.change).toBe("added");
    expect(payload.node.id).toBe("emp1");
    expect(payload.node.depth).toBe(2);
  });
  it("stays silent outside talk trees", () => {
    seedTree();
    sessions.set("loner", s("loner"));
    const emit = vi.fn();
    maybeEmitTalkGraph("loner", "completed", { getSession, emit });
    expect(emit).not.toHaveBeenCalled();
  });
});
