/**
 * Jinn Talk — server-owned delegation (Mission Control).
 *
 * One endpoint owns spawn-vs-continue so the orchestrator LLM never decides it
 * from prose: `thread:"new"` spawns a COO child; `thread:"<id>"` validates the
 * id is a live child of THIS talk session and posts a follow-up. Unknown ids
 * fail with the live roster in the body — a self-correcting error for the model.
 * Spawning/continuing goes through the normal /api/sessions HTTP routes (via
 * injected deps) so queueing, talk:focus, and parent callbacks behave exactly
 * as a hand-rolled curl did.
 */
import type { Session } from "../shared/types.js";

export interface DelegateDeps {
  getSession: (id: string) => Session | undefined;
  listChildSessions: (parentId: string) => Session[];
  /** Internal POST /api/sessions — spawn a COO child; resolves to the new id. */
  spawnChild: (opts: { prompt: string; parentSessionId: string }) => Promise<{ id: string }>;
  /** Internal POST /api/sessions/:id/message — continue an existing thread. */
  continueThread: (sessionId: string, message: string) => Promise<void>;
  updateSession: (id: string, updates: { title?: string }) => unknown;
  emit: (event: string, payload: unknown) => void;
}

export type DelegateResult =
  | { ok: true; threadId: string; created: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      threads?: Array<{ id: string; label: string; status: string }>;
    };

/** Compact roster of a talk session's COO children (for self-correcting errors). */
export function threadRoster(deps: DelegateDeps, talkSessionId: string) {
  return deps.listChildSessions(talkSessionId).map((c) => ({
    id: c.id,
    label: c.title || "(untitled)",
    status: c.status,
  }));
}

/** Derive a ≤36-char title from the brief when no label is given. */
function defaultLabel(brief: string): string {
  const s = brief.replace(/\s+/g, " ").trim();
  return s.length > 36 ? s.slice(0, 35).trimEnd() + "…" : s;
}

export async function delegateToThread(
  body: unknown,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.sessionId !== "string" || !b.sessionId.trim()) {
    return {
      ok: false,
      status: 400,
      error: "sessionId must be a non-empty string (your own talk session id)",
    };
  }
  const talk = deps.getSession(b.sessionId);
  if (!talk || talk.source !== "talk") {
    return {
      ok: false,
      status: 400,
      error: `sessionId ${b.sessionId} is not a talk session`,
    };
  }
  if (typeof b.brief !== "string" || !b.brief.trim()) {
    return {
      ok: false,
      status: 400,
      error: "brief must be a non-empty string (the expanded task brief)",
    };
  }
  const brief = b.brief.trim();
  if (typeof b.thread !== "string" || !b.thread.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'thread must be "new" or an existing COO thread id',
      threads: threadRoster(deps, talk.id),
    };
  }

  if (b.thread === "new") {
    const label =
      typeof b.label === "string" && b.label.trim()
        ? b.label.trim().slice(0, 64)
        : defaultLabel(brief);
    const { id } = await deps.spawnChild({ prompt: brief, parentSessionId: talk.id });
    deps.updateSession(id, { title: label });
    deps.emit("talk:thread:label", { sessionId: talk.id, threadId: id, label });
    return { ok: true, threadId: id, created: true };
  }

  const child = deps.getSession(b.thread);
  if (!child || child.parentSessionId !== talk.id) {
    return {
      ok: false,
      status: 400,
      error: `thread ${b.thread} is not one of your COO threads — use "new" or one of the ids below`,
      threads: threadRoster(deps, talk.id),
    };
  }
  await deps.continueThread(child.id, brief);
  return { ok: true, threadId: child.id, created: false };
}
