/**
 * Jinn Talk — voice-activity endpointer (pure, testable).
 *
 * A tiny energy-based VAD state machine for hands-free turn-taking. It is fed
 * one RMS energy frame at a time (0..1) with a monotonic timestamp and returns
 * a transition event:
 *   - "speech-start" — sustained energy above the onset threshold: the user has
 *     actually begun talking. We only endpoint AFTER this, so we never cut off
 *     on the leading silence before they speak.
 *   - "endpoint"     — speech was detected and has since been followed by a
 *     trailing silence long enough to call the utterance finished (or the
 *     max-utterance safety cap was hit).
 *   - null           — nothing to report this frame.
 *
 * No audio APIs here on purpose — feed it synthetic frames in tests. The runtime
 * glue (reading an AnalyserNode each rAF frame) lives in use-talk.ts and
 * mic-energy.ts. The same machine drives barge-in: with a higher threshold and a
 * longer onset sustain it reports "speech-start" when the user talks over AURA,
 * while ignoring the speaker bleed of AURA's own voice (see BARGE_IN_DEFAULTS).
 */

export interface VadConfig {
  /** RMS at/above which a frame counts as speech (onset). */
  onsetThreshold: number
  /** RMS at/above which speech is still considered ongoing (hysteresis; ≤ onset). */
  releaseThreshold: number
  /** Energy must stay above onset this long (ms) before "speech-start" fires. */
  minOnsetMs: number
  /** Minimum speech length (ms) before a trailing silence may endpoint. */
  minSpeechMs: number
  /** Trailing silence (ms) below release that ends the utterance. */
  trailingSilenceMs: number
  /** Hard safety cap (ms) — endpoint even if the user never pauses. */
  maxUtteranceMs: number
}

export type VadEvent = "speech-start" | "endpoint" | null

/** Hands-free auto-endpointing of the user's own mic capture. */
export const VAD_DEFAULTS: VadConfig = {
  onsetThreshold: 0.045,
  releaseThreshold: 0.03,
  minOnsetMs: 100,
  minSpeechMs: 350,
  trailingSilenceMs: 1000,
  maxUtteranceMs: 20_000,
}

/**
 * Barge-in detection while AURA is speaking. Only "speech-start" is consumed.
 * Higher threshold + longer sustain so AURA's own TTS leaking into the mic does
 * not self-trigger (paired with browser echo-cancellation on the capture, see
 * mic-energy.ts).
 */
export const BARGE_IN_DEFAULTS: VadConfig = {
  onsetThreshold: 0.09,
  releaseThreshold: 0.07,
  minOnsetMs: 350,
  minSpeechMs: 0,
  trailingSilenceMs: Number.POSITIVE_INFINITY,
  maxUtteranceMs: Number.POSITIVE_INFINITY,
}

export class VadEndpointer {
  private cfg: VadConfig
  private onset = false
  private aboveSince: number | null = null
  private speechStart = 0
  private lastLoud = 0

  constructor(cfg: VadConfig) {
    this.cfg = cfg
  }

  reset(): void {
    this.onset = false
    this.aboveSince = null
    this.speechStart = 0
    this.lastLoud = 0
  }

  push(rms: number, nowMs: number): VadEvent {
    if (!this.onset) {
      // Wait for sustained energy above the onset threshold before declaring
      // speech — a single loud frame (a click, a road bump) must not start a turn.
      if (rms >= this.cfg.onsetThreshold) {
        if (this.aboveSince == null) this.aboveSince = nowMs
        if (nowMs - this.aboveSince >= this.cfg.minOnsetMs) {
          this.onset = true
          this.speechStart = nowMs
          this.lastLoud = nowMs
          this.aboveSince = null
          return "speech-start"
        }
      } else {
        this.aboveSince = null
      }
      return null
    }

    // Speech is underway — track the last "loud" frame for trailing-silence.
    if (rms >= this.cfg.releaseThreshold) this.lastLoud = nowMs

    const speechElapsed = nowMs - this.speechStart
    const silenceElapsed = nowMs - this.lastLoud

    if (speechElapsed >= this.cfg.maxUtteranceMs) {
      this.reset()
      return "endpoint"
    }
    if (
      speechElapsed >= this.cfg.minSpeechMs &&
      silenceElapsed >= this.cfg.trailingSilenceMs
    ) {
      this.reset()
      return "endpoint"
    }
    return null
  }
}
