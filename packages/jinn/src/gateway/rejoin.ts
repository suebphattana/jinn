/**
 * Deterministic post-restart rejoin.
 *
 * Restarting the gateway kills the session that issued the restart, so the
 * operator otherwise has to message first to discover it's back. Before
 * restarting, `tools/safe-restart.sh` writes a marker file; on the next startup
 * the gateway reads it and acts once the connector is actually running:
 *
 *  - Always: send a brief "I'm back" notice DIRECTLY through the connector
 *    (no cron, no LLM turn) so the operator gets instant feedback.
 *  - If the marker names the session that triggered the restart, ALSO resume
 *    that session — inject a turn so the assistant picks up any unfinished work
 *    and replies on its own, instead of waiting for the operator to message.
 */
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { Connector, IncomingMessage, Session } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { getSession } from "../sessions/registry.js";

const REJOIN_FILE = path.join(JINN_HOME, "tmp", "rejoin.json");

interface RejoinNotice {
  connector?: string;
  channel: string;
  text: string;
  /** Session that triggered the restart. When set (and the session is
   *  resumable), the gateway re-engages it instead of only sending `text`. */
  sessionId?: string;
  /** What to tell the resumed assistant. Defaults to a generic continue prompt. */
  resumePrompt?: string;
}

/** Persist a notice to send on the next startup (used by tools/safe-restart.sh). */
export function writeRejoinNotice(notice: RejoinNotice): void {
  fs.mkdirSync(path.dirname(REJOIN_FILE), { recursive: true });
  fs.writeFileSync(REJOIN_FILE, JSON.stringify(notice));
}

const DEFAULT_RESUME_PROMPT =
  "🔄 The gateway just finished restarting (you triggered it). Pick up where you " +
  "left off: continue any unfinished work from before the restart and report the " +
  "result. If everything was already complete, just confirm you're back online.";

/**
 * If a rejoin marker exists, wait for its connector to come up (Discord/Telegram
 * login takes a few seconds), then send the notice and — if a resumable session
 * is named — re-engage that session. Fire-and-forget: never throws, never blocks
 * startup.
 */
export async function flushRejoinNotice(
  connectors: Map<string, Connector>,
  sessionManager?: SessionManager,
  opts: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<void> {
  let notice: RejoinNotice;
  try {
    notice = JSON.parse(fs.readFileSync(REJOIN_FILE, "utf8"));
  } catch {
    return; // no marker (the common case)
  }
  if (!notice?.channel || !notice?.text) {
    try { fs.unlinkSync(REJOIN_FILE); } catch { /* ignore */ }
    return;
  }

  const connName = notice.connector || "discord";
  const pollMs = opts.pollMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 45_000;
  const deadline = Date.now() + maxWaitMs;

  // Wait for the connector to be live before doing anything.
  let connector: Connector | undefined;
  while (Date.now() < deadline) {
    const c = connectors.get(connName);
    if (c && c.getHealth().status === "running") {
      connector = c;
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!connector) {
    logger.warn(`Rejoin: connector "${connName}" never came up; giving up`);
    try { fs.unlinkSync(REJOIN_FILE); } catch { /* ignore */ }
    return;
  }

  // Always send the brief "I'm back" notice for instant feedback.
  try {
    await connector.sendMessage({ channel: notice.channel }, notice.text);
    logger.info(`Rejoin notice sent via "${connName}"`);
  } catch (err) {
    logger.warn(`Rejoin notice send failed: ${err instanceof Error ? err.message : err}`);
  }

  // If a resumable session was named, re-engage it so the assistant continues
  // its work on its own. Clearing the marker first prevents a resume loop if the
  // resumed turn itself restarts the gateway.
  try { fs.unlinkSync(REJOIN_FILE); } catch { /* ignore */ }

  if (notice.sessionId && sessionManager) {
    const session = getSession(notice.sessionId);
    if (!session) {
      logger.warn(`Rejoin: session ${notice.sessionId} not found; resume skipped`);
      return;
    }
    if (!isResumable(session)) {
      logger.info(`Rejoin: session ${notice.sessionId} is "${session.status}" (not resumable); resume skipped`);
      return;
    }
    try {
      const msg = buildResumeMessage(session, notice.resumePrompt || DEFAULT_RESUME_PROMPT);
      logger.info(`Rejoin: resuming session ${session.id} (${session.sessionKey})`);
      await sessionManager.route(msg, connector);
    } catch (err) {
      logger.warn(`Rejoin: resume of session ${notice.sessionId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Whether to resume an explicitly-named session. The marker is only written by
 * a deliberate restart, so honour it broadly: between boot (which marks stale
 * sessions "interrupted") and the connector coming up, the engine can settle a
 * recovered transcript and flip the status to "idle" — that drift must not
 * cancel the resume. The one status we skip is "waiting" (paused on a Claude
 * usage limit): poking it would just re-queue behind the limit.
 */
function isResumable(session: Session): boolean {
  return session.status !== "waiting";
}

/** Synthesize the IncomingMessage a connector would have produced, so route()
 *  finds the existing session (by sessionKey) and resumes it. */
function buildResumeMessage(session: Session, prompt: string): IncomingMessage {
  const ctx = (session.replyContext ?? {}) as Record<string, unknown>;
  return {
    connector: session.connector ?? session.source,
    source: session.source,
    sessionKey: session.sessionKey,
    replyContext: session.replyContext ?? {},
    channel: typeof ctx.channel === "string" ? ctx.channel : "",
    thread: typeof ctx.thread === "string" ? ctx.thread : undefined,
    user: "system",
    userId: typeof session.userId === "string" ? session.userId : "",
    text: prompt,
    attachments: [],
    raw: {},
    ...(session.transportMeta ? { transportMeta: session.transportMeta } : {}),
  };
}
