/**
 * Jinn Talk — real voice-loop hook (Path 1).
 *
 * The voice orchestrator is a REAL gateway session (source:"talk"), not an
 * in-process Agent-SDK loop. So the loop is:
 *
 *   mic → useStt → POST /api/sessions/{orchestratorId}/message
 *        → the orchestrator session streams its reply as session:delta `text`
 *          (live caption) and, at turn end, the gateway synthesizes the whole
 *          reply with Kokoro and streams it back as talk:audio (drives the orb).
 *        → when the orchestrator delegates to a COO child, the gateway emits
 *          talk:focus so the UI can animate to that channel.
 *        → when a COO child finishes, the gateway wakes the orchestrator with a
 *          📩 notification; it narrates — which arrives as another session:delta
 *          + talk:audio turn, fully hands-free.
 *
 * Reuses existing infra: useGateway().subscribe (shared WS), useStt (mic+STT),
 * TalkAudioPlayer (ordered low-latency playback feeding the orb level).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt } from "@/hooks/use-stt"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  type TalkAudioEvent,
  type TalkFocusEvent,
  type SessionDeltaEvent,
  type SessionCompletedEvent,
} from "./protocol"
import type { TranscriptEntry } from "./transcript"
import type { AvatarState, Card, TrackerTask } from "./types"

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/** The COO channel the orchestrator is currently delegating to / narrating. */
export interface TalkFocus {
  cooId: string
  label: string
}

export interface UseTalkReturn {
  state: AvatarState
  entries: TranscriptEntry[]
  cards: Card[]
  tasks: TrackerTask[]
  /** 0..1 while listening/speaking, undefined when the orb should self-animate. */
  level: number | undefined
  /** Gateway WS connection state. */
  connected: boolean
  /** True while the mic is actively recording. */
  listening: boolean
  /** Whether backend STT is available (null = still checking). */
  sttAvailable: boolean | null
  /** TTS model readiness / download progress (drives the page hint). */
  ttsStatus: TtsStatus
  /** The COO channel currently in focus (null when none). */
  focus: TalkFocus | null
  /** Start mic capture (also resumes the audio context for output playback). */
  startListening: () => void
  /** Stop everything: cancel mic, drain audio, settle to idle. */
  stop: () => void
}

export function useTalk(): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [cards] = useState<Card[]>([]) // voice-first v1: cards land in a later pass
  const [tasks] = useState<TrackerTask[]>([])
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })
  const [focus, setFocus] = useState<TalkFocus | null>(null)

  // The real orchestrator session id (null until bootstrapped).
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)
  const orchestratorIdRef = useRef<string | null>(null)
  orchestratorIdRef.current = orchestratorId

  // One audio player for the lifetime of the hook.
  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  const levelRafRef = useRef<number>(0)
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  const turnSeqRef = useRef(0)

  // Id of the in-progress assistant transcript entry (null between turns) and a
  // monotonic counter so each turn (user-initiated OR callback narration) gets a
  // fresh bubble.
  const asstIdRef = useRef<string | null>(null)
  const turnCounterRef = useRef(0)
  // Safety timer: after a turn completes we wait briefly for talk:audio; if none
  // arrives (TTS unavailable), settle to idle instead of hanging on "thinking".
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ttsReadyRef = useRef(false)
  ttsReadyRef.current = ttsStatus.kind === "ready"

  const stt = useStt()
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop ------------------------------------------------------
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
        } else {
          setLevel(undefined)
        }
      } else {
        const player = playerRef.current
        if (player && player.playing) setLevel(player.level)
        else setLevel(undefined)
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Append a streamed assistant text fragment ---------------------------
  const appendAssistantText = useCallback((fragment: string) => {
    setEntries((prev) => {
      // Start a fresh assistant bubble at the first fragment of a turn.
      if (!asstIdRef.current) {
        turnCounterRef.current += 1
        asstIdRef.current = `a${turnCounterRef.current}`
      }
      const id = asstIdRef.current
      const existing = prev.find((e) => e.id === id)
      const merged = existing ? existing.text + fragment : fragment
      const without = prev.filter((e) => e.id !== id)
      return [...without, { id, role: "assistant", text: merged, partial: true }]
    })
  }, [])

  // ---- WS subscription -----------------------------------------------------
  useEffect(() => {
    const player = playerRef.current!
    player.onIdle(() => {
      setState((s) => (s === "speaking" ? "idle" : s))
      stopLevelLoop()
    })

    const ours = (p: unknown): boolean =>
      typeof p === "object" && p !== null &&
      (p as { sessionId?: string }).sessionId === orchestratorIdRef.current

    const GLOBAL_TTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    const clearSettle = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      // Global TTS-download frames are sessionless.
      if (GLOBAL_TTS.has(event)) {
        if (event === TALK_EVENTS.ttsDownloadProgress) {
          setTtsStatus({ kind: "downloading", progress: (payload as { progress?: number }).progress ?? 0 })
        } else if (event === TALK_EVENTS.ttsDownloadComplete) {
          setTtsStatus({ kind: "ready" })
        } else {
          setTtsStatus({ kind: "error", message: (payload as { error?: string }).error ?? "TTS download failed" })
        }
        return
      }

      // talk:focus is keyed by parentId (the orchestrator), not sessionId.
      if (event === TALK_EVENTS.focus) {
        const ev = payload as TalkFocusEvent
        if (ev.parentId === orchestratorIdRef.current) setFocus({ cooId: ev.cooId, label: ev.label })
        return
      }

      // Everything else must belong to the orchestrator session.
      if (!ours(payload)) return

      switch (event) {
        case "session:delta": {
          const ev = payload as SessionDeltaEvent
          if (ev.type === "text" && typeof ev.content === "string" && ev.content) {
            appendAssistantText(ev.content)
            // Reply is forming — show "thinking" until audio starts speaking.
            setState((s) => (s === "speaking" ? s : "thinking"))
          }
          break
        }
        case TALK_EVENTS.audio: {
          const ev = payload as TalkAudioEvent
          clearSettle()
          player.enqueue(ev.seq, ev.mime, ev.dataBase64)
          setState("speaking")
          startLevelLoop("output")
          break
        }
        case "session:completed": {
          void (payload as SessionCompletedEvent)
          // Finalize the assistant bubble for this turn.
          setEntries((prev) =>
            prev.map((e) => (e.id === asstIdRef.current ? { ...e, partial: false } : e)),
          )
          asstIdRef.current = null
          // Audio (Kokoro) is synthesized AFTER completion and arrives as
          // talk:audio shortly after. Wait briefly for it; if TTS isn't ready or
          // nothing comes, settle to idle.
          clearSettle()
          if (player.playing) {
            setState("speaking")
          } else if (ttsReadyRef.current) {
            setState("thinking")
            settleTimerRef.current = setTimeout(() => {
              if (!playerRef.current?.playing) {
                setState("idle")
                stopLevelLoop()
              }
            }, 3500)
          } else {
            setState("idle")
            stopLevelLoop()
          }
          break
        }
      }
    })

    return () => {
      clearSettle()
      unsub()
    }
  }, [gateway, appendAssistantText, startLevelLoop, stopLevelLoop])

  // ---- Bootstrap the orchestrator session + probe TTS ----------------------
  useEffect(() => {
    let alive = true
    api
      .talkCreateSession()
      .then((r) => { if (alive) setOrchestratorId(r.sessionId) })
      .catch(() => { /* surfaced via connection hint */ })
    api
      .talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.downloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => { /* status endpoint optional — leave idle */ })
    return () => { alive = false }
  }, [])

  // ---- Mic control ---------------------------------------------------------
  const startListening = useCallback(() => {
    playerRef.current?.resume()
    setState("listening")
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop])

  const stop = useCallback(async () => {
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return // superseded by a newer turn
      const orch = orchestratorIdRef.current
      if (text && text.trim() && orch) {
        const uid = `u${Date.now()}`
        setEntries((prev) => [...prev, { id: uid, role: "user", text }])
        try {
          await api.sendMessage(orch, { message: text })
          // From here the orchestrator session streams session:delta + talk:audio.
        } catch {
          setState("idle")
          stopLevelLoop()
        }
      } else {
        setState("idle")
        stopLevelLoop()
      }
    } else {
      s.cancelRecording()
      playerRef.current?.reset()
      setState("idle")
      stopLevelLoop()
    }
  }, [stopLevelLoop])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  return useMemo(
    () => ({
      state, entries, cards, tasks, level,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      ttsStatus, focus,
      startListening, stop,
    }),
    [state, entries, cards, tasks, level, gateway.connected, listening, stt.available, ttsStatus, focus, startListening, stop],
  )
}
