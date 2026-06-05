import { useState, useRef, useCallback, useEffect } from "react"

/**
 * Jinn Talk — text-to-speech abstraction (Concept AURA).
 *
 * A thin, swappable TTS hook. The working-now backend is the browser Web
 * Speech API (`speechSynthesis` + `SpeechSynthesisUtterance`). The public
 * `SpeakHandle` is intentionally shaped so a future local-OSS backend
 * (Piper / Kokoro-82M behind `POST /api/tts`) is a drop-in swap — it returns
 * the same promise-based `speak()` and the same per-word `onWord` callback.
 *
 * See TTS-NOTES.md in this folder for the production path.
 */

export interface SpeakOptions {
  /** 0..2, default ~1. */
  rate?: number
  /** 0..2, default 1. */
  pitch?: number
  /** Fired per spoken word (Web Speech boundary event) for transcript sync. */
  onWord?: (info: { charIndex: number; word: string }) => void
}

export interface SpeakHandle {
  /** Resolves when the utterance finishes (or after an estimated duration if TTS is unavailable, so the demo still advances). */
  speak: (text: string, opts?: SpeakOptions) => Promise<void>
  cancel: () => void
  /**
   * Unlock TTS inside a user gesture (REQUIRED on iOS Safari). Call this on the
   * mic tap: it speaks a silent primer so later, post-network speak() calls are
   * permitted, and nudges the voice list to load.
   */
  prime: () => void
  /** True while audio is playing. */
  speaking: boolean
  /** Whether speech synthesis exists in this browser (works with the default voice). */
  supported: boolean
}

/** Average speaking pace used to estimate duration when TTS is unavailable. */
const WORDS_PER_MINUTE = 165
/** Floor for the estimated-duration fallback, so very short lines still read. */
const MIN_ESTIMATED_MS = 600

/**
 * Pick a pleasant natural English voice from the available list.
 * Heuristic priority: a "nice" named voice → first `en-*` voice → first voice.
 * Defensive: returns null when no voices are loaded yet.
 */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null

  const preferred = [
    "Natural",
    "Premium",
    "Enhanced",
    "Samantha",
    "Google US English",
    "Daniel",
  ]
  for (const needle of preferred) {
    const match = voices.find((v) => v.name.includes(needle))
    if (match) return match
  }

  const english = voices.find((v) => v.lang.toLowerCase().startsWith("en"))
  if (english) return english

  return voices[0]
}

/** Extract the word starting at `charIndex` (boundary events give the start offset). */
function wordAt(text: string, charIndex: number): string {
  if (charIndex < 0 || charIndex >= text.length) return ""
  const slice = text.slice(charIndex)
  const match = slice.match(/^\S+/)
  return match ? match[0] : ""
}

export function useSpeak(): SpeakHandle {
  const [speaking, setSpeaking] = useState(false)
  const [supported, setSupported] = useState(false)

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  // Resolver for the in-flight speak() promise — lets cancel()/unmount settle it.
  const resolveRef = useRef<(() => void) | null>(null)
  // Timers driving the fallback (no-TTS) path: end timer + per-word timers.
  const fallbackTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])

  // Load voices on mount. Voices are frequently empty on the first synchronous
  // call, so we also listen for the async `voiceschanged` event.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setSupported(false)
      return
    }

    const synth = window.speechSynthesis
    // The API exists → we can speak (with the default voice if the list is
    // still empty, which is the normal state on iOS Safari until first speak).
    setSupported(true)

    const loadVoices = () => {
      const voices = synth.getVoices()
      if (voices.length > 0) voiceRef.current = pickVoice(voices)
    }

    loadVoices()
    synth.addEventListener("voiceschanged", loadVoices)

    return () => {
      synth.removeEventListener("voiceschanged", loadVoices)
    }
  }, [])

  const clearFallbackTimers = useCallback(() => {
    for (const t of fallbackTimersRef.current) clearTimeout(t)
    fallbackTimersRef.current = []
  }, [])

  // Settle the in-flight promise (if any) and clear playing state.
  const settle = useCallback(() => {
    const resolve = resolveRef.current
    resolveRef.current = null
    utteranceRef.current = null
    setSpeaking(false)
    if (resolve) resolve()
  }, [])

  const cancel = useCallback(() => {
    clearFallbackTimers()
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    settle()
  }, [clearFallbackTimers, settle])

  // iOS Safari only allows speechSynthesis.speak() after it has been called once
  // inside a user gesture. The mic tap is that gesture: speak a silent primer to
  // unlock the audio channel and load voices, so the post-network reply speaks.
  const prime = useCallback(() => {
    const synth =
      typeof window !== "undefined" ? window.speechSynthesis : undefined
    if (!synth) return
    try {
      synth.cancel()
      const primer = new SpeechSynthesisUtterance(" ")
      primer.volume = 0
      synth.speak(primer)
      synth.resume()
      const voices = synth.getVoices()
      if (voices.length > 0 && !voiceRef.current) voiceRef.current = pickVoice(voices)
      setSupported(true)
    } catch {
      /* noop */
    }
  }, [])

  const speak = useCallback(
    (text: string, opts?: SpeakOptions): Promise<void> => {
      // Cancel anything already in flight so promises never overlap.
      clearFallbackTimers()
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      const prevResolve = resolveRef.current
      resolveRef.current = null
      if (prevResolve) prevResolve()

      const rate = opts?.rate ?? 1
      const pitch = opts?.pitch ?? 1

      const synth =
        typeof window !== "undefined" ? window.speechSynthesis : undefined

      // ----- Working-now path: real Web Speech synthesis -----
      // Gate on the API existing — NOT on a picked voice. On iOS Safari the voice
      // list is empty until the first speak(), but speaking with the engine's
      // default voice works fine, so requiring a voice here silenced all output.
      if (synth) {
        return new Promise<void>((resolve) => {
          resolveRef.current = resolve

          const utterance = new SpeechSynthesisUtterance(text)
          if (voiceRef.current) utterance.voice = voiceRef.current
          utterance.rate = rate
          utterance.pitch = pitch
          utteranceRef.current = utterance

          if (opts?.onWord) {
            const onWord = opts.onWord
            utterance.onboundary = (e: SpeechSynthesisEvent) => {
              // Only word boundaries drive the transcript; ignore sentence marks.
              if (e.name !== "word") return
              onWord({
                charIndex: e.charIndex,
                word: wordAt(text, e.charIndex),
              })
            }
          }

          utterance.onend = () => {
            if (utteranceRef.current === utterance) settle()
          }
          utterance.onerror = () => {
            if (utteranceRef.current === utterance) settle()
          }

          setSpeaking(true)
          synth.speak(utterance)
        })
      }

      // ----- Fallback path: no TTS — estimate duration so the demo flows -----
      return new Promise<void>((resolve) => {
        resolveRef.current = resolve
        setSpeaking(true)

        const words = text.split(/\s+/).filter(Boolean)
        const totalMs = Math.max(
          MIN_ESTIMATED_MS,
          (words.length / WORDS_PER_MINUTE) * 60_000,
        )

        // Fire onWord on a timer so the transcript reveal stays in sync.
        if (opts?.onWord && words.length > 0) {
          const onWord = opts.onWord
          const perWord = totalMs / words.length
          let charIndex = 0
          words.forEach((word, i) => {
            const at = charIndex
            const timer = setTimeout(() => {
              onWord({ charIndex: at, word })
            }, perWord * i)
            fallbackTimersRef.current.push(timer)
            // +1 approximates the single whitespace char between words.
            charIndex += word.length + 1
          })
        }

        const endTimer = setTimeout(() => {
          settle()
        }, totalMs)
        fallbackTimersRef.current.push(endTimer)
      })
    },
    [clearFallbackTimers, settle],
  )

  // Clean up any in-flight utterance / timers on unmount.
  useEffect(() => {
    return () => {
      clearFallbackTimers()
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      const resolve = resolveRef.current
      resolveRef.current = null
      if (resolve) resolve()
    }
  }, [clearFallbackTimers])

  return { speak, cancel, prime, speaking, supported }
}
