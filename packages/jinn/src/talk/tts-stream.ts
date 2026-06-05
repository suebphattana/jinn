/**
 * Jinn Talk — server-side TTS streaming for the voice orchestrator (Path 1).
 *
 * The orchestrator is a normal gateway session. As it streams its reply, the
 * run loop (api.ts) feeds each `text` delta here via feedTalkText(); when the
 * turn completes it calls flushTalkSpeech(), which speaks the WHOLE accumulated
 * reply in ONE Kokoro call. Speaking once per turn (rather than per sentence)
 * matters: kokoro.speak() resets its `seq` counter to 0 and flags the final
 * chunk `last:true` on every call, so multiple calls per turn would collide on
 * ordering and prematurely signal end-of-audio. kokoro.speak() already splits
 * the text into sentence-sized chunks internally for low-latency playback.
 *
 * The Kokoro engine is a process-wide singleton shared with routes.ts (status /
 * download endpoints) so there is exactly one sidecar.
 */
import { createKokoroTts } from "./kokoro.js";
import type { Tts, Emit } from "./protocol.js";
import { logger } from "../shared/logger.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTalkTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

// Per-session accumulator of the current turn's spoken text.
const pending = new Map<string, string>();

/** Append a streamed `text` delta to the session's current-turn buffer. */
export function feedTalkText(sessionId: string, text: string): void {
  if (!text) return;
  pending.set(sessionId, (pending.get(sessionId) ?? "") + text);
}

/**
 * Speak everything accumulated for this turn (one Kokoro call), then clear the
 * buffer. Awaitable so the caller can let audio finish; safe to fire-and-forget.
 */
export async function flushTalkSpeech(
  sessionId: string,
  opts: KokoroOpts | undefined,
  emit: Emit,
): Promise<void> {
  const text = (pending.get(sessionId) ?? "").trim();
  pending.delete(sessionId);
  if (!text) return;
  try {
    await getTalkTts(opts).speak(sessionId, text, emit);
  } catch (err) {
    logger.warn(`[talk] TTS speak failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Drop any buffered text for a session without speaking (e.g. on interrupt). */
export function discardTalkSpeech(sessionId: string): void {
  pending.delete(sessionId);
}
