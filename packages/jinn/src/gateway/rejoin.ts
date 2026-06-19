/**
 * Deterministic post-restart "I'm back" notice.
 *
 * Restarting the gateway kills the session that issued the restart, so the
 * operator otherwise has to message first to discover it's back. The previous
 * approach (a self-deleting cron job that ran a COO turn) was flaky — it
 * depended on cron timing AND an LLM turn succeeding.
 *
 * This is solid instead: before restarting, write a marker file; on the next
 * startup the gateway reads it and sends the message DIRECTLY through the
 * connector (no cron, no LLM turn) once that connector is actually running.
 */
import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { Connector } from "../shared/types.js";

const REJOIN_FILE = path.join(JINN_HOME, "tmp", "rejoin.json");

interface RejoinNotice {
  connector?: string;
  channel: string;
  text: string;
}

/** Persist a notice to send on the next startup (used by tools/safe-restart.sh). */
export function writeRejoinNotice(notice: RejoinNotice): void {
  fs.mkdirSync(path.dirname(REJOIN_FILE), { recursive: true });
  fs.writeFileSync(REJOIN_FILE, JSON.stringify(notice));
}

/**
 * If a rejoin marker exists, wait for its connector to come up (Discord/Telegram
 * login takes a few seconds) and send the message, then clear the marker.
 * Fire-and-forget — never throws, never blocks startup.
 */
export async function flushRejoinNotice(
  connectors: Map<string, Connector>,
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
  let done = false;

  while (!done && Date.now() < deadline) {
    const connector = connectors.get(connName);
    if (connector && connector.getHealth().status === "running") {
      try {
        await connector.sendMessage({ channel: notice.channel }, notice.text);
        logger.info(`Rejoin notice sent via "${connName}"`);
      } catch (err) {
        logger.warn(`Rejoin notice send failed: ${err instanceof Error ? err.message : err}`);
      }
      done = true; // terminal: sent or send-errored — don't spam
    } else {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  if (!done) {
    logger.warn(`Rejoin notice: connector "${connName}" never came up; giving up`);
  }
  // Clear the marker once we've reached a terminal state (sent / errored / timed
  // out). If the process crashes mid-wait, the marker survives and retries next boot.
  try { fs.unlinkSync(REJOIN_FILE); } catch { /* ignore */ }
}
