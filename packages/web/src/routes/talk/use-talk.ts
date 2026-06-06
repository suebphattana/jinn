/**
 * Jinn Talk — real voice-loop hook (Path 1).
 *
 * The voice orchestrator is a REAL gateway session (source:"talk"). Loop:
 *   mic → useStt → POST /api/sessions/{orchestratorId}/message
 *        → the orchestrator streams its reply as session:delta `text` (caption)
 *          and is spoken aloud. TTS is browser SpeechSynthesis by default (works
 *          on iOS/Android, no server deps); if the gateway ever streams Kokoro
 *          audio (talk:audio) we prefer that instead.
 *        → when it delegates to a COO child, the gateway emits talk:focus; we
 *          track that child so the UI can render it as a satellite orb.
 *        → when a COO child finishes, the orchestrator is woken (📩) and narrates
 *          — another session:delta + spoken turn, fully hands-free.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt } from "@/hooks/use-stt"
import { useSpeak } from "./use-speak"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  type TalkAudioEvent,
  type TalkFocusEvent,
  type TalkCardEvent,
  type TalkCardUpdateEvent,
  type TalkCardDismissEvent,
  type SessionDeltaEvent,
  type SessionCompletedEvent,
} from "./protocol"
import type { TranscriptEntry } from "./transcript"
import type { AvatarState, Card } from "./types"
import { VadEndpointer, VAD_DEFAULTS, BARGE_IN_DEFAULTS } from "./vad"
import { MicEnergyMonitor } from "./mic-energy"

/** Most recent cards kept on the surface at once (older ones drift out). */
const MAX_CARDS = 4

/** localStorage key for the hands-free (continuous) mode preference. */
const HANDS_FREE_KEY = "talk-hands-free"
/** Gap after AURA stops speaking before the mic auto-reopens (hands-free). */
const AUTO_REOPEN_DELAY_MS = 450

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/** A COO child session the orchestrator is working with (a satellite orb). */
export interface TalkChild {
  id: string
  label: string
  /** "thinking" while running, "idle"/"speaking" briefly on completion before it fades. */
  state: AvatarState
}

export interface UseTalkReturn {
  state: AvatarState
  entries: TranscriptEntry[]
  /** Active COO child sessions (satellite orbs around the orchestrator). */
  children: TalkChild[]
  /** Detail cards the orchestrator pushed for the current answer(s). */
  cards: Card[]
  /** 0..1 while listening/speaking (server audio), undefined → orb self-animates. */
  level: number | undefined
  connected: boolean
  listening: boolean
  sttAvailable: boolean | null
  ttsStatus: TtsStatus
  /** Hands-free (continuous) mode: VAD auto-send + barge-in + auto-reopen. */
  handsFree: boolean
  toggleHandsFree: () => void
  startListening: () => void
  stop: () => void
}

export function useTalk(): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [children, setChildren] = useState<TalkChild[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })
  const [handsFree, setHandsFree] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return localStorage.getItem(HANDS_FREE_KEY) === "1"
  })

  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)
  const orchestratorIdRef = useRef<string | null>(null)
  orchestratorIdRef.current = orchestratorId

  // Mirrors of state read from inside rAF ticks / timers / WS callbacks.
  const handsFreeRef = useRef(handsFree)
  handsFreeRef.current = handsFree
  const stateRef = useRef(state)
  stateRef.current = state

  // Hands-free turn-taking machinery.
  const vadRef = useRef<VadEndpointer | null>(null)
  const vadFiredRef = useRef(false)
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Late-bound refs so rAF ticks / effects can call the latest stop/startListening.
  const stopRef = useRef<() => void>(() => {})
  const startListeningRef = useRef<() => void>(() => {})

  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  const speak = useSpeak()
  const speakRef = useRef(speak)
  speakRef.current = speak

  const levelRafRef = useRef<number>(0)
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  const turnSeqRef = useRef(0)

  // Per-turn assistant bubble + accumulated text (for Web Speech on completion).
  const asstIdRef = useRef<string | null>(null)
  const turnTextRef = useRef("")
  const turnCounterRef = useRef(0)
  // Did the gateway stream Kokoro audio this turn? If so we DON'T also Web-Speak.
  const audioThisTurnRef = useRef(false)
  // Known child session ids so we can route their stream events.
  const childIdsRef = useRef<Set<string>>(new Set())
  const childRemovalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const stt = useStt()
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop (mic listening OR server-audio output) ---------------
  const stopLevelLoop = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = 0
    }
    levelModeRef.current = null
    setLevel(undefined)
  }, [])

  const startLevelLoop = useCallback((mode: "mic" | "output") => {
    if (levelRafRef.current && levelModeRef.current === mode) return
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelModeRef.current = mode
    const tick = () => {
      if (mode === "mic") {
        const analyser = sttRef.current.analyser
        if (analyser) {
          const buf = new Uint8Array(analyser.fftSize)
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buf.length)
          setLevel(Math.min(1, rms * 3.2))
          // Hands-free VAD auto-endpointing: once the user has actually spoken,
          // a trailing silence ends the turn and sends it — no second tap.
          if (
            handsFreeRef.current &&
            !vadFiredRef.current &&
            vadRef.current &&
            sttRef.current.state === "recording"
          ) {
            if (vadRef.current.push(rms, performance.now()) === "endpoint") {
              vadFiredRef.current = true
              stopRef.current()
            }
          }
        } else setLevel(undefined)
      } else {
        const player = playerRef.current
        setLevel(player && player.playing ? player.level : undefined)
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Transcript helpers --------------------------------------------------
  const appendAssistantText = useCallback((fragment: string) => {
    setEntries((prev) => {
      if (!asstIdRef.current) {
        turnCounterRef.current += 1
        asstIdRef.current = `a${turnCounterRef.current}`
        turnTextRef.current = ""
      }
      const id = asstIdRef.current
      turnTextRef.current += fragment
      const existing = prev.find((e) => e.id === id)
      const merged = existing ? existing.text + fragment : fragment
      return [...prev.filter((e) => e.id !== id), { id, role: "assistant", text: merged, partial: true }]
    })
  }, [])

  // ---- Child (satellite) bookkeeping ---------------------------------------
  const upsertChild = useCallback((id: string, label: string, st: AvatarState) => {
    setChildren((prev) => {
      const i = prev.findIndex((c) => c.id === id)
      if (i === -1) return [...prev, { id, label, state: st }]
      const next = prev.slice()
      next[i] = { ...next[i], label: label || next[i].label, state: st }
      return next
    })
  }, [])

  const scheduleChildRemoval = useCallback((id: string) => {
    const existing = childRemovalTimers.current.get(id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      setChildren((prev) => prev.filter((c) => c.id !== id))
      childIdsRef.current.delete(id)
      childRemovalTimers.current.delete(id)
    }, 4500)
    childRemovalTimers.current.set(id, t)
  }, [])

  // ---- Detail-card surface (orchestrator pushes via POST /api/talk/card) ----
  // talk:card upserts by id (re-posting the same id updates it in place);
  // talk:card:update patches one card; :dismiss drops one; :clear wipes all.
  const upsertCard = useCallback((card: Card) => {
    setCards((prev) => {
      const i = prev.findIndex((c) => c.id === card.id)
      if (i !== -1) {
        const next = prev.slice()
        next[i] = card
        return next
      }
      const next = [...prev, card]
      return next.length > MAX_CARDS ? next.slice(next.length - MAX_CARDS) : next
    })
  }, [])

  const patchCard = useCallback((id: string, patch: Partial<Card>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Card) : c)))
  }, [])

  const dismissCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const clearCards = useCallback(() => setCards([]), [])

  // ---- Hands-free auto-reopen ----------------------------------------------
  // After AURA finishes speaking, in hands-free mode reopen the mic for the next
  // turn so the conversation continues without a tap. Guarded so it only fires
  // when still idle + hands-free + STT usable (never tight-loops on no-model).
  const scheduleAutoListen = useCallback(() => {
    if (!handsFreeRef.current) return
    if (sttRef.current.available === false) return
    if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current)
    autoListenTimerRef.current = setTimeout(() => {
      autoListenTimerRef.current = null
      if (handsFreeRef.current && stateRef.current === "idle") startListeningRef.current()
    }, AUTO_REOPEN_DELAY_MS)
  }, [])

  // ---- WS subscription -----------------------------------------------------
  useEffect(() => {
    const player = playerRef.current!
    player.onIdle(() => {
      setState((s) => (s === "speaking" ? "idle" : s))
      stopLevelLoop()
      scheduleAutoListen()
    })

    const sid = (p: unknown): string | undefined =>
      typeof p === "object" && p !== null ? (p as { sessionId?: string }).sessionId : undefined

    const GLOBAL_TTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    const speakReplyIfNeeded = () => {
      const text = turnTextRef.current.trim()
      if (audioThisTurnRef.current) {
        // Kokoro audio is playing; player.onIdle will settle.
        setState("speaking")
      } else if (text && speakRef.current.supported) {
        setState("speaking")
        speakRef.current
          .speak(text)
          .then(() => { setState((s) => (s === "speaking" ? "idle" : s)); scheduleAutoListen() })
          .catch(() => { setState((s) => (s === "speaking" ? "idle" : s)); scheduleAutoListen() })
      } else {
        setState("idle")
        stopLevelLoop()
        scheduleAutoListen()
      }
      audioThisTurnRef.current = false
    }

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      if (GLOBAL_TTS.has(event)) {
        if (event === TALK_EVENTS.ttsDownloadProgress) setTtsStatus({ kind: "downloading", progress: (payload as { progress?: number }).progress ?? 0 })
        else if (event === TALK_EVENTS.ttsDownloadComplete) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "error", message: (payload as { error?: string }).error ?? "TTS error" })
        return
      }

      if (event === TALK_EVENTS.focus) {
        const ev = payload as TalkFocusEvent
        if (ev.parentId === orchestratorIdRef.current) {
          childIdsRef.current.add(ev.cooId)
          const t = childRemovalTimers.current.get(ev.cooId)
          if (t) { clearTimeout(t); childRemovalTimers.current.delete(ev.cooId) }
          upsertChild(ev.cooId, ev.label, "thinking")
        }
        return
      }

      const s = sid(payload)
      const isOrch = s === orchestratorIdRef.current
      const isChild = s !== undefined && childIdsRef.current.has(s)

      switch (event) {
        case "session:delta": {
          const ev = payload as SessionDeltaEvent
          if (isOrch) {
            if (ev.type === "text" && typeof ev.content === "string" && ev.content) {
              appendAssistantText(ev.content)
              setState((st) => (st === "speaking" ? st : "thinking"))
            }
          } else if (isChild && s) {
            upsertChild(s, "", "thinking") // keep it alive/working
          }
          break
        }
        case TALK_EVENTS.audio: {
          if (!isOrch) break
          const ev = payload as TalkAudioEvent
          audioThisTurnRef.current = true
          player.enqueue(ev.seq, ev.mime, ev.dataBase64)
          setState("speaking")
          startLevelLoop("output")
          break
        }
        case TALK_EVENTS.card: {
          if (!isOrch) break
          upsertCard((payload as TalkCardEvent).card)
          break
        }
        case TALK_EVENTS.cardUpdate: {
          if (!isOrch) break
          const ev = payload as TalkCardUpdateEvent
          patchCard(ev.cardId, ev.patch)
          break
        }
        case TALK_EVENTS.cardDismiss: {
          if (!isOrch) break
          dismissCard((payload as TalkCardDismissEvent).cardId)
          break
        }
        case TALK_EVENTS.cardClear: {
          if (!isOrch) break
          clearCards()
          break
        }
        case "session:completed": {
          void (payload as SessionCompletedEvent)
          if (isOrch) {
            setEntries((prev) => prev.map((e) => (e.id === asstIdRef.current ? { ...e, partial: false } : e)))
            asstIdRef.current = null
            speakReplyIfNeeded()
          } else if (isChild && s) {
            upsertChild(s, "", "idle")
            scheduleChildRemoval(s)
          }
          break
        }
      }
    })

    return () => { unsub() }
  }, [gateway, appendAssistantText, upsertChild, scheduleChildRemoval, startLevelLoop, stopLevelLoop, upsertCard, patchCard, dismissCard, clearCards, scheduleAutoListen])

  // ---- Bootstrap orchestrator + probe TTS ----------------------------------
  useEffect(() => {
    let alive = true
    api.talkCreateSession()
      .then((r) => { if (alive) setOrchestratorId(r.sessionId) })
      .catch(() => { /* surfaced via connection hint */ })
    api.talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.downloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // ---- Mic control ---------------------------------------------------------
  const startListening = useCallback(() => {
    if (autoListenTimerRef.current) { clearTimeout(autoListenTimerRef.current); autoListenTimerRef.current = null }
    playerRef.current?.resume()
    // Unlock browser TTS within the user gesture (iOS Safari requires this, or
    // the post-network reply is silently blocked).
    try { speakRef.current.prime() } catch { /* noop */ }
    // Arm a fresh VAD endpointer for this utterance (hands-free auto-send).
    if (!vadRef.current) vadRef.current = new VadEndpointer(VAD_DEFAULTS)
    else vadRef.current.reset()
    vadFiredRef.current = false
    setState("listening")
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop])
  startListeningRef.current = startListening

  const stop = useCallback(async () => {
    if (autoListenTimerRef.current) { clearTimeout(autoListenTimerRef.current); autoListenTimerRef.current = null }
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return
      const orch = orchestratorIdRef.current
      if (text && text.trim() && orch) {
        setEntries((prev) => [...prev, { id: `u${Date.now()}`, role: "user", text }])
        try {
          await api.sendMessage(orch, { message: text })
        } catch {
          setState("idle"); stopLevelLoop()
        }
      } else {
        // Empty/failed transcription (e.g. VAD endpointed on noise). In
        // hands-free, re-arm the mic so the conversation doesn't stall.
        setState("idle"); stopLevelLoop(); scheduleAutoListen()
      }
    } else {
      s.cancelRecording()
      playerRef.current?.reset()
      setState("idle"); stopLevelLoop()
    }
  }, [stopLevelLoop, scheduleAutoListen])
  stopRef.current = stop

  const toggleHandsFree = useCallback(() => {
    setHandsFree((prev) => {
      const next = !prev
      try { localStorage.setItem(HANDS_FREE_KEY, next ? "1" : "0") } catch { /* noop */ }
      // Turning it off mid-conversation: cancel any pending auto-reopen.
      if (!next && autoListenTimerRef.current) {
        clearTimeout(autoListenTimerRef.current)
        autoListenTimerRef.current = null
      }
      return next
    })
  }, [])

  // ---- Barge-in: talk over AURA to interrupt (hands-free only) --------------
  // While AURA is speaking we run a short-lived AEC-enabled mic monitor. On
  // SUSTAINED speech energy above a raised threshold (BARGE_IN_DEFAULTS) we
  // cancel the TTS and immediately open a fresh listening turn. The echo-
  // cancellation + threshold + onset-sustain together stop AURA's own voice
  // (leaking through the speaker) from interrupting herself.
  const onBargeIn = useCallback(() => {
    try { speakRef.current.cancel() } catch { /* noop */ }
    playerRef.current?.reset()
    audioThisTurnRef.current = false
    startListeningRef.current()
  }, [])

  useEffect(() => {
    if (!handsFree || state !== "speaking") return
    const monitor = new MicEnergyMonitor()
    const detector = new VadEndpointer(BARGE_IN_DEFAULTS)
    let done = false
    monitor
      .start((rms, now) => {
        if (done) return
        if (detector.push(rms, now) === "speech-start") {
          done = true
          monitor.stop()
          onBargeIn()
        }
      })
      .catch(() => { /* mic unavailable → no barge-in, tap still works */ })
    return () => { done = true; monitor.stop() }
  }, [handsFree, state, onBargeIn])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      if (autoListenTimerRef.current) clearTimeout(autoListenTimerRef.current)
      for (const t of childRemovalTimers.current.values()) clearTimeout(t)
      childRemovalTimers.current.clear()
      try { speakRef.current.cancel() } catch { /* noop */ }
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  return useMemo(
    () => ({
      state, entries, children, cards, level,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      ttsStatus,
      handsFree, toggleHandsFree,
      startListening, stop,
    }),
    [state, entries, children, cards, level, gateway.connected, listening, stt.available, ttsStatus, handsFree, toggleHandsFree, startListening, stop],
  )
}
