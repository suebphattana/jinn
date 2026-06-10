/**
 * Jinn Talk — server-authoritative session graph (Mission Control).
 *
 * The talk UI renders the WHOLE delegation tree under the voice orchestrator —
 * AURA → COO children → employee grandchildren (any depth). The gateway owns
 * that tree: every session row carries parentSessionId, so membership is "does
 * walking up reach a source:'talk' session". Lifecycle call sites in
 * gateway/api.ts call maybeEmitTalkGraph() next to their existing session:*
 * emits; GET /api/talk/graph serves the snapshot for (re)connect rehydration.
 * Emission is best-effort — the snapshot endpoint is the source of truth.
 */
import type { Session } from "../shared/types.js";
import { TALK_EVENTS } from "./protocol.js";

export interface TalkGraphNode {
  id: string;
  parentId: string | null;
  /** 1 = COO child of the talk root, 2 = employee under a COO, … */
  depth: number;
  label: string;
  employee: string | null;
  status: string;
  lastActivity: string;
}

export type TalkGraphChange = "added" | "status" | "completed" | "removed";

const MAX_NODES = 200;

/** Human node label: title → employee → short id. */
function nodeLabel(s: Session): string {
  return (s.title && s.title.trim()) || s.employee || s.id.slice(0, 6);
}

export function toGraphNode(s: Session, depth: number): TalkGraphNode {
  return {
    id: s.id,
    parentId: s.parentSessionId ?? null,
    depth,
    label: nodeLabel(s),
    employee: s.employee ?? null,
    status: s.status,
    lastActivity: s.lastActivity,
  };
}

/** Walk parentSessionId links to the talk root (cycle-guarded). */
export function resolveTalkRoot(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): Session | undefined {
  const seen = new Set<string>();
  let cur = getSession(sessionId);
  while (cur) {
    if (cur.source === "talk") return cur;
    if (!cur.parentSessionId || seen.has(cur.id)) return undefined;
    seen.add(cur.id);
    cur = getSession(cur.parentSessionId);
  }
  return undefined;
}

/** Depth of a session below its talk root (1 = direct COO child). */
export function talkDepth(
  sessionId: string,
  getSession: (id: string) => Session | undefined,
): number {
  const seen = new Set<string>();
  let depth = 0;
  let cur = getSession(sessionId);
  while (cur && cur.source !== "talk" && cur.parentSessionId && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = getSession(cur.parentSessionId);
  }
  return depth;
}

/** BFS all descendants of a talk root (capped at MAX_NODES). */
export function buildGraphSnapshot(
  rootId: string,
  listChildSessions: (parentId: string) => Session[],
): TalkGraphNode[] {
  const nodes: TalkGraphNode[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>([rootId]);
  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const { id, depth } = queue.shift()!;
    for (const child of listChildSessions(id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      nodes.push(toGraphNode(child, depth + 1));
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }
  return nodes;
}

export interface TalkGraphEvent {
  rootId: string;
  change: TalkGraphChange;
  node: TalkGraphNode;
}

/**
 * Emit a talk:graph delta if (and only if) the session lives in a talk tree.
 * Cheap no-op for the overwhelming majority of sessions (no talk ancestor).
 */
export function maybeEmitTalkGraph(
  sessionId: string,
  change: TalkGraphChange,
  deps: {
    getSession: (id: string) => Session | undefined;
    emit: (event: string, payload: unknown) => void;
  },
): void {
  try {
    const session = deps.getSession(sessionId);
    if (!session || session.source === "talk" || !session.parentSessionId) return;
    const root = resolveTalkRoot(sessionId, deps.getSession);
    if (!root) return;
    const depth = talkDepth(sessionId, deps.getSession);
    deps.emit(TALK_EVENTS.graph, {
      rootId: root.id,
      change,
      node: toGraphNode(session, depth),
    } satisfies TalkGraphEvent);
  } catch {
    /* best-effort — snapshot endpoint is the source of truth */
  }
}
