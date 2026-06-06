/**
 * Jinn Talk — VAD endpointer logic tests.
 *
 * Drives the pure endpointer with synthetic energy frames (constant RMS over a
 * duration, stepped at a fixed frame interval) so the onset / trailing-silence /
 * safety-cap decisions are verified without a real microphone.
 */
import { describe, it, expect } from "vitest"
import { VadEndpointer, VAD_DEFAULTS, BARGE_IN_DEFAULTS, type VadConfig } from "../vad"

const DT = 16 // ms per frame (~60fps)
const LOUD = 0.2 // clearly above either onset threshold
const SOFT = 0.005 // clearly silence

/** Feed segments of [rms, durationMs] and collect (event, time) transitions. */
function run(
  ep: VadEndpointer,
  segments: Array<[number, number]>,
): Array<{ ev: "speech-start" | "endpoint"; t: number }> {
  let t = 0
  const events: Array<{ ev: "speech-start" | "endpoint"; t: number }> = []
  for (const [rms, durMs] of segments) {
    const frames = Math.round(durMs / DT)
    for (let i = 0; i < frames; i++) {
      const ev = ep.push(rms, t)
      if (ev) events.push({ ev, t })
      t += DT
    }
  }
  return events
}

describe("VadEndpointer", () => {
  it("never fires on pure silence (no onset → no endpoint)", () => {
    const events = run(new VadEndpointer(VAD_DEFAULTS), [[SOFT, 3000]])
    expect(events).toHaveLength(0)
  })

  it("emits speech-start then endpoints after the trailing silence", () => {
    const events = run(new VadEndpointer(VAD_DEFAULTS), [
      [LOUD, 800],
      [SOFT, 1500],
    ])
    expect(events.map((e) => e.ev)).toEqual(["speech-start", "endpoint"])

    const start = events[0].t
    const end = events[1].t
    // Onset only after the sustain window.
    expect(start).toBeGreaterThanOrEqual(VAD_DEFAULTS.minOnsetMs)
    // Endpoint only after a full trailing-silence past the last loud frame
    // (speech ran ~800ms, so the silence gate dominates).
    expect(end - 800).toBeGreaterThanOrEqual(VAD_DEFAULTS.trailingSilenceMs - DT)
  })

  it("does not endpoint while speech is still ongoing", () => {
    // 600ms of speech then only 400ms of silence (< trailingSilenceMs) → no endpoint yet.
    const events = run(new VadEndpointer(VAD_DEFAULTS), [
      [LOUD, 600],
      [SOFT, 400],
    ])
    expect(events.map((e) => e.ev)).toEqual(["speech-start"])
  })

  it("ignores a blip shorter than the onset sustain", () => {
    const events = run(new VadEndpointer(VAD_DEFAULTS), [
      [LOUD, 64], // < minOnsetMs (100)
      [SOFT, 800],
    ])
    expect(events).toHaveLength(0)
  })

  it("endpoints at the max-utterance safety cap when the user never pauses", () => {
    const cfg: VadConfig = { ...VAD_DEFAULTS, maxUtteranceMs: 500, trailingSilenceMs: 100_000 }
    // 700ms of unbroken speech: long enough to hit the 500ms cap once, short
    // enough that the post-endpoint reset doesn't re-onset before frames end.
    const events = run(new VadEndpointer(cfg), [[LOUD, 700]])
    expect(events.map((e) => e.ev)).toEqual(["speech-start", "endpoint"])
    // Endpoint near the cap, measured from speech onset.
    const start = events[0].t
    const end = events[1].t
    expect(end - start).toBeGreaterThanOrEqual(500)
    expect(end - start).toBeLessThan(500 + 2 * DT)
  })

  it("reset() returns the machine to its initial state", () => {
    const ep = new VadEndpointer(VAD_DEFAULTS)
    expect(ep.push(LOUD, 0)).toBeNull()
    ep.reset()
    // After reset, an immediate single loud frame must NOT count as onset.
    expect(ep.push(LOUD, 0)).toBeNull()
  })

  describe("barge-in config (talk-over detection)", () => {
    it("does not trigger on short TTS-bleed blips with gaps", () => {
      const events = run(new VadEndpointer(BARGE_IN_DEFAULTS), [
        [0.12, 200], // each blip < minOnsetMs (350)
        [SOFT, 200],
        [0.12, 200],
        [SOFT, 200],
        [0.12, 200],
        [SOFT, 200],
      ])
      expect(events).toHaveLength(0)
    })

    it("triggers speech-start on sustained talk-over", () => {
      const events = run(new VadEndpointer(BARGE_IN_DEFAULTS), [[0.12, 600]])
      expect(events.map((e) => e.ev)).toEqual(["speech-start"])
      expect(events[0].t).toBeGreaterThanOrEqual(BARGE_IN_DEFAULTS.minOnsetMs)
    })

    it("ignores energy below the (raised) barge-in threshold", () => {
      // 0.06 would pass VAD_DEFAULTS onset (0.045) but not barge-in (0.09).
      const events = run(new VadEndpointer(BARGE_IN_DEFAULTS), [[0.06, 800]])
      expect(events).toHaveLength(0)
    })
  })
})
