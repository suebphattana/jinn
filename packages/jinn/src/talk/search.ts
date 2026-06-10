/**
 * Jinn Talk — session search (Mission Control).
 *
 * Merges title/metadata hits (searchSessions) and full-text content hits
 * (searchMessages) into a unified result list, de-duped by sessionId. Title
 * hits win position; content hits attach as hits[]. Total results capped at 20;
 * hits per session capped at 3 (newest first — searchMessages already returns
 * newest-first so we just take the first HITS_PER_SESSION for each session).
 */
import type { Session } from "../shared/types.js";
import type { MessageSearchResult } from "../sessions/registry.js";

const RESULTS_CAP = 20;
const HITS_PER_SESSION = 3;

export interface SearchHit {
  snippet: string;
  role: string;
  ts: number;
}

export interface SearchResult {
  sessionId: string;
  title: string | null;
  employee: string | null;
  source: string;
  lastActivity: string;
  status: string;
  isTalkChild: boolean;
  hits: SearchHit[];
}

export type SearchResponse =
  | { ok: true; results: SearchResult[] }
  | { ok: false; status: number; error: string };

export interface SearchDeps {
  searchSessions: (query: string, limit?: number) => Session[];
  searchMessages: (query: string, limit?: number) => MessageSearchResult[];
  getSession: (id: string) => Session | undefined;
  /**
   * Injected from graph.ts — walks parentSessionId chain to the talk root.
   * Returns the root Session when the chain reaches source==="talk", undefined
   * otherwise. Injected rather than imported directly to match the
   * dependency-injection style in delegate.ts.
   */
  resolveTalkRoot: (
    sessionId: string,
    getSession: (id: string) => Session | undefined,
  ) => Session | undefined;
}

/**
 * Search sessions by title/metadata and by message content, merge, de-dupe,
 * and return up to 20 results with up to 3 content-hit snippets each.
 *
 * Pure logic — all I/O comes through injected `deps`.
 */
export function searchTalkSessions(q: unknown, deps: SearchDeps): SearchResponse {
  if (typeof q !== "string" || !q.trim()) {
    return { ok: false, status: 400, error: "q must be a non-empty string" };
  }

  const query = q.trim();

  // Title / metadata hits — newest-first (searchSessions orders by last_activity DESC).
  // Request up to twice the cap so de-dup doesn't leave us short.
  const sessionHits = deps.searchSessions(query, RESULTS_CAP * 2);

  // Full-text content hits — newest-first. Fetch enough to fill HITS_PER_SESSION
  // slots for up to RESULTS_CAP result entries.
  const messageHits = deps.searchMessages(query, RESULTS_CAP * HITS_PER_SESSION);

  // Build an ordered, de-duped map: sessionId → { session, accumulated hits }.
  // Insertion order = title-hit order first, then content-only sessions.
  type Entry = { session: Session; hits: SearchHit[] };
  const map = new Map<string, Entry>();
  const order: string[] = [];

  // 1. Title hits win position.
  for (const session of sessionHits) {
    if (!map.has(session.id)) {
      map.set(session.id, { session, hits: [] });
      order.push(session.id);
    }
  }

  // 2. Content hits: attach to the existing entry or add a new one.
  for (const hit of messageHits) {
    const { sessionId, snippet, role, timestamp } = hit;
    if (!map.has(sessionId)) {
      const session = deps.getSession(sessionId);
      if (!session) continue; // Session deleted or not yet visible — skip.
      map.set(sessionId, { session, hits: [] });
      order.push(sessionId);
    }
    const entry = map.get(sessionId)!;
    if (entry.hits.length < HITS_PER_SESSION) {
      entry.hits.push({ snippet, role, ts: timestamp });
    }
  }

  // 3. Materialise results, capped at RESULTS_CAP.
  const results: SearchResult[] = [];
  for (const sessionId of order) {
    if (results.length >= RESULTS_CAP) break;
    const { session, hits } = map.get(sessionId)!;
    results.push({
      sessionId: session.id,
      title: session.title,
      employee: session.employee,
      source: session.source,
      lastActivity: session.lastActivity,
      status: session.status,
      isTalkChild: !!deps.resolveTalkRoot(session.id, deps.getSession),
      hits,
    });
  }

  return { ok: true, results };
}
