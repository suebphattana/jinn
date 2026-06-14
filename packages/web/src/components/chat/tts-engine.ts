/**
 * Read-aloud playback engine — the real `TtsStart` for the chat TTS controller.
 *
 * Strategy per message:
 *   1. Strip markdown so we speak clean prose, not asterisks/backticks.
 *   2. Prefer our custom server TTS (Kokoro) via POST /api/tts → play the WAV.
 *      Availability is probed once (GET /api/tts, cached) so we pick the browser
 *      fallback WITHOUT a failed POST when Kokoro isn't installed.
 *   3. Fall back to the browser Web Speech API (speechSynthesis) when Kokoro is
 *      unavailable OR the synth request fails at call time.
 *
 * All browser touchpoints (fetch / Audio / speechSynthesis) are injected so the
 * selection logic is unit-testable without a DOM or network.
 */
import { stripMarkdown } from "@/lib/strip-markdown"
import type { TtsStart, TtsStartCallbacks } from "./tts-controller"

export interface TtsEngineDeps {
  /** Probe whether the custom (Kokoro) TTS is available. Cached by the caller. */
  checkAvailable: () => Promise<boolean>
  /** POST the text to the custom TTS; resolve with a WAV blob, reject on failure. */
  fetchAudio: (text: string) => Promise<Blob>
  /** Play a synthesized WAV blob; returns a stop() handle. */
  playAudio: (blob: Blob, cbs: TtsStartCallbacks) => () => void
  /** Browser Web Speech fallback; returns a stop() handle. */
  speak: (text: string, cbs: TtsStartCallbacks) => () => void
}

const NOOP = () => {}

/** Build a `TtsStart` from injected playback dependencies. */
export function createTtsStart(deps: TtsEngineDeps): TtsStart {
  return async (raw, cbs) => {
    const text = stripMarkdown(raw).trim()
    if (!text) {
      // Nothing speakable (e.g. a media-only / code-only message) — end cleanly.
      cbs.onEnd()
      return NOOP
    }

    let available = false
    try {
      available = await deps.checkAvailable()
    } catch {
      available = false
    }

    if (available) {
      try {
        const blob = await deps.fetchAudio(text)
        return deps.playAudio(blob, cbs)
      } catch {
        // Kokoro was advertised available but the request failed — degrade to Web Speech.
      }
    }

    return deps.speak(text, cbs)
  }
}

/* ── Default browser-backed dependencies ─────────────────────────────────── */

let availabilityPromise: Promise<boolean> | null = null

/** GET /api/tts once and cache the answer for the page lifetime. */
function checkAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    availabilityPromise = fetch("/api/tts")
      .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
      .then((d) => !!d.available)
      .catch(() => false)
  }
  return availabilityPromise
}

async function fetchAudio(text: string): Promise<Blob> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}`)
  return r.blob()
}

function playAudio(blob: Blob, { onPlaying, onEnd, onError }: TtsStartCallbacks): () => void {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    URL.revokeObjectURL(url)
  }
  audio.onplaying = () => onPlaying()
  audio.onended = () => {
    cleanup()
    onEnd()
  }
  audio.onerror = () => {
    cleanup()
    onError()
  }
  audio.play().catch(() => {
    cleanup()
    onError()
  })
  return () => {
    audio.pause()
    cleanup()
  }
}

function speak(text: string, { onPlaying, onEnd, onError }: TtsStartCallbacks): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    onError()
    return NOOP
  }
  const utt = new SpeechSynthesisUtterance(text)
  utt.onstart = () => onPlaying()
  utt.onend = () => onEnd()
  utt.onerror = () => onError()
  synth.cancel() // clear any queued/leftover speech first
  synth.speak(utt)
  return () => {
    // cancel() may fire a late onend/onerror — the controller's generation guard
    // ignores those, so stop() is safe to call here.
    synth.cancel()
  }
}

/** Production dependencies (browser fetch + Audio + Web Speech). */
export function defaultTtsDeps(): TtsEngineDeps {
  return { checkAvailable, fetchAudio, playAudio, speak }
}
