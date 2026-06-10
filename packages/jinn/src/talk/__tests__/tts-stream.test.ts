import { describe, it, expect, vi, beforeEach } from "vitest"
import { extractSentences, feedTalkText, flushTalkSpeech, discardTalkSpeech, __setTalkTtsForTest } from "../tts-stream.js"

describe("extractSentences", () => {
  it("extracts complete sentences, keeps the incomplete remainder", () => {
    expect(extractSentences("Hello there. How are")).toEqual({ complete: ["Hello there."], rest: "How are" })
  })
  it("requires whitespace after the terminator (decimals survive)", () => {
    expect(extractSentences("Pi is 3.14 and counting")).toEqual({ complete: [], rest: "Pi is 3.14 and counting" })
  })
  it("handles multiple sentences and newlines", () => {
    const r = extractSentences("One. Two!\nThree? Four")
    expect(r.complete).toEqual(["One.", "Two!", "Three?"])
    expect(r.rest).toBe("Four")
  })
})

describe("per-sentence streaming", () => {
  const speak = vi.fn(async (_sid: string, text: string, _emit: unknown, opts?: { seqStart?: number; final?: boolean }) => {
    void text; void opts
    return 1 // pretend each call emits exactly 1 chunk
  })
  beforeEach(() => {
    speak.mockClear()
    __setTalkTtsForTest({ speak } as never)
  })

  it("synthesizes each completed sentence as it arrives, monotonic seq, final only on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s1", "Hello there. How ", undefined, emit)
    feedTalkText("s1", "are you? I am", undefined, emit)
    await flushTalkSpeech("s1", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls[0][1]).toBe("Hello there.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: false })
    expect(speak.mock.calls[1][1]).toBe("How are you?")
    expect(speak.mock.calls[1][3]).toEqual({ seqStart: 1, final: false })
    expect(speak.mock.calls[2][1]).toBe("I am")
    expect(speak.mock.calls[2][3]).toEqual({ seqStart: 2, final: true })
  })

  it("discard drops buffered + not-yet-synthesized text", async () => {
    const emit = vi.fn()
    feedTalkText("s2", "One. Two", undefined, emit)
    discardTalkSpeech("s2")
    await flushTalkSpeech("s2", undefined, emit)
    // Let the stranded chain task (queued "One.") run — the epoch guard must drop it.
    await new Promise((r) => setTimeout(r, 0))
    expect(speak.mock.calls.filter((c) => c[0] === "s2")).toHaveLength(0)
  })

  it("advances seq by the actual chunk count when kokoro re-splits a sentence", async () => {
    const emit = vi.fn()
    speak.mockImplementationOnce(async () => 2) // first sentence yields 2 chunks
    feedTalkText("s4", "Hello\nthere. Next one. Tail", undefined, emit)
    await flushTalkSpeech("s4", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(3)
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: false })
    expect(speak.mock.calls[1][3]).toEqual({ seqStart: 2, final: false }) // +2, not +1
    expect(speak.mock.calls[2][3]).toEqual({ seqStart: 3, final: true })
  })

  it("without emit (legacy buffering) everything speaks on flush", async () => {
    const emit = vi.fn()
    feedTalkText("s3", "Alpha. Beta.")
    await flushTalkSpeech("s3", undefined, emit)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0][1]).toBe("Alpha. Beta.")
    expect(speak.mock.calls[0][3]).toEqual({ seqStart: 0, final: true })
  })
})
