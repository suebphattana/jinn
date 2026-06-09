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
 *          — another session:delta + spoken turn.
 *
 * Mic control is plain tap-to-talk: tap the mic to start listening, tap again to
 * send. After a reply is spoken the loop returns to idle and waits for the next tap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt, type SttState } from "@/hooks/use-stt"
import { useSpeak, splitSentences } from "./use-speak"
import { stripMarkdown } from "@/lib/strip-markdown"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  type TalkAudioEvent,
  type TalkFocusEvent,
  type TalkThreadLabelEvent,
  type TalkCardEvent,
  type TalkCardUpdateEvent,
  type TalkCardDismissEvent,
  type TalkEngineEvent,
  type SessionDeltaEvent,
  type SessionCompletedEvent,
} from "./protocol"
import type { TranscriptEntry } from "./transcript"
import type { AvatarState, Card } from "./types"
import { threadReducer, type TalkThread, type ThreadAction } from "./thread-store"
import { messagesToEntries, childrenToThreads } from "./rehydrate"
import {
  loadTargetThread,
  saveTargetThread,
  loadThreadLabels,
  saveThreadLabel,
  removeThreadLabel,
  loadDismissedThreads,
  addDismissedThread,
} from "./talk-storage"

export type { TalkThread } from "./thread-store"

/** Most recent cards kept on the surface at once (older ones drift out). */
const MAX_CARDS = 4

/** How long a finished COO thread keeps orbiting (as a satellite) before parking. */
const THREAD_PARK_MS = 4500

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/** Which voice actually produced the most recent spoken turn. `neural` = the
 *  gateway streamed Kokoro audio (talk:audio) and it played; `fallback` = the
 *  browser Web-Speech synth (or caption-only). null → nothing spoken yet. This
 *  makes a silent Kokoro break visible instead of degrading unnoticed. */
export type VoiceMode = "neural" | "fallback" | null

/** Active orchestrator engine/model + the available set, for the picker. */
export interface TalkEngineInfo {
  engine: string | null
  model: string | null
  fallback: boolean
  reason: string | null
  available: string[]
  /** False until GET /api/talk/engine has resolved — so an empty `available`
   *  before the first fetch isn't mistaken for "no engine installed". */
  loaded: boolean
}

export interface UseTalkReturn {
  state: AvatarState
  entries: TranscriptEntry[]
  /** Persistent COO threads (satellite orbs + the thread panel). */
  threads: TalkThread[]
  /** The thread the next dispatch is routed to continue (null → new thread). */
  targetThreadId: string | null
  /** Detail cards the orchestrator pushed for the current answer(s). */
  cards: Card[]
  /** 0..1 while listening/speaking (server audio), undefined → orb self-animates. */
  level: number | undefined
  connected: boolean
  listening: boolean
  sttAvailable: boolean | null
  /** Last speech-to-text failure (null when none). Surfaced so a failed turn
   * isn't silent; tapping the mic again clears it and retries. */
  sttError: string | null
  ttsStatus: TtsStatus
  /** Voice that produced the last spoken turn (neural Kokoro vs Web-Speech). */
  voiceMode: VoiceMode
  /** Silent/text mode: when true AURA doesn't speak; replies are read. */
  muted: boolean
  /** Toggle silent/text mode (persisted; silences any in-flight speech). */
  toggleMute: () => void
  /** Type-to-talk: send a typed message via the same path as a voice turn. */
  sendText: (text: string) => void
  /** Raw STT lifecycle state — drives the whisper-model-download modal. */
  sttState: SttState
  /** 0..100 while the whisper model downloads (null otherwise). */
  sttDownloadProgress: number | null
  /** Kick off the local whisper model download (progress streams over WS). */
  startSttDownload: () => void
  /** Dismiss the download modal and return the avatar to idle. */
  dismissSttDownload: () => void
  /** Active orchestrator engine/model + available engines (for the picker). */
  engineInfo: TalkEngineInfo
  /** Switch the orchestrator ENGINE — persists then RE-BOOTSTRAPS the session so
   *  the new engine is adopted immediately (a live PTY can't swap mid-turn). */
  switchEngine: (engine: string) => void
  /** Switch the orchestrator MODEL — applies on the live session's next turn. */
  switchModel: (model: string) => void
  /** Route the next dispatch to continue an existing thread (null → new). */
  selectThread: (id: string | null) => void
  /** Rename a thread's topic label (UI-only). */
  renameThread: (id: string, label: string) => void
  /** Remove a thread chip (does not kill the gateway session). */
  dismissThread: (id: string) => void
  /**
   * Begin the heavy bootstrap (create/reuse the orchestrator session, probe TTS,
   * rehydrate). Idempotent. TalkPage calls this on mount; the provider is
   * globally mounted but stays dormant until a page activates it.
   */
  activate: () => void
  /**
   * Action channel: a decision-card button sends a synthetic user message back
   * to the orchestrator (reuses the same sendMessage path as the mic). The
   * message carries a machine `[card-action …]` tag the orchestrator interprets.
   */
  cardAction: (message: string) => void
  startListening: () => void
  stop: () => void
  /**
   * Interrupt the current spoken reply: stops Web-Speech / server audio
   * playback and returns the avatar to idle. Playback-stop only — it does not
   * re-open the mic or cancel the (already-finished) backend turn.
   */
  stopSpeaking: () => void
}

export function useTalk(): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [threads, setThreads] = useState<TalkThread[]>([])
  // Lazy-init from localStorage so a routed-thread selection survives a reload.
  const [targetThreadId, setTargetThreadId] = useState<string | null>(() => loadTargetThread())
  const [cards, setCards] = useState<Card[]>([])
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(null)
  // Silent/text mode: when muted, AURA does not speak (Kokoro audio is discarded
  // client-side + Web-Speech is cancelled) and replies are read in the transcript.
  // Persisted so the preference survives reloads.
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return localStorage.getItem("talk-muted") === "1"
  })
  const [engineInfo, setEngineInfo] = useState<TalkEngineInfo>({
    engine: null,
    model: null,
    fallback: false,
    reason: null,
    available: [],
    loaded: false,
  })

  // Heavy bootstrap is gated on activation (TalkPage calls activate() on mount),
  // so the globally-mounted provider doesn't create a talk session until used.
  const [activated, setActivated] = useState(false)
  const activate = useCallback(() => setActivated(true), [])

  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)
  const orchestratorIdRef = useRef<string | null>(null)
  orchestratorIdRef.current = orchestratorId

  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  const speak = useSpeak()
  const speakRef = useRef(speak)
  speakRef.current = speak

  const levelRafRef = useRef<number>(0)
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  // Throttle state for the level loop: last committed value + timestamp, so the
  // rAF can sample every frame but only re-render the orb tree ~25fps.
  const levelLastValRef = useRef<number | undefined>(undefined)
  const levelLastCommitRef = useRef(0)
  const turnSeqRef = useRef(0)

  // Per-turn assistant bubble + accumulated text (for Web Speech on completion).
  const asstIdRef = useRef<string | null>(null)
  const turnTextRef = useRef("")
  const turnCounterRef = useRef(0)
  // Did the gateway stream Kokoro audio this turn? If so we DON'T also Web-Speak.
  const audioThisTurnRef = useRef(false)
  // Live mirror so the WS audio handler + speak path read the current mute
  // without re-subscribing.
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  // Known COO thread (child) session ids so we can route their stream events.
  // Synced from `threads` each render AND added immediately on focus (so a child
  // delta arriving the same tick as focus still routes).
  const threadIdsRef = useRef<Set<string>>(new Set())
  threadIdsRef.current = new Set(threads.map((t) => t.id))
  // Pending park timers (finished thread keeps orbiting briefly, then parks).
  const parkTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Live mirrors for WS-callback / send closures.
  const threadsRef = useRef<TalkThread[]>(threads)
  threadsRef.current = threads
  const targetThreadIdRef = useRef<string | null>(targetThreadId)
  targetThreadIdRef.current = targetThreadId

  // Pass the gateway's `stt:*` event stream so the whisper-model download
  // progress/completion lands here too (same source ChatInput's useStt uses).
  const stt = useStt(gateway.events)
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop (mic listening OR server-audio output) ---------------
  const stopLevelLoop = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = 0
    }
    levelModeRef.current = null
    levelLastValRef.current = undefined
    levelLastCommitRef.current = 0
    setLevel(undefined)
  }, [])

  const startLevelLoop = useCallback((mode: "mic" | "output") => {
    if (levelRafRef.current && levelModeRef.current === mode) return
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelModeRef.current = mode
    // The rAF samples every frame (smooth source for the orb springs) but
    // setLevel — which re-renders the orb tree — is gated: at most ~25fps and
    // only when the value moved a perceptible amount. Edge transitions to/from
    // undefined always commit so listening/idle handoffs are never dropped.
    const MIN_COMMIT_MS = 40
    const MIN_DELTA = 0.01
    const commit = (next: number | undefined) => {
      const prev = levelLastValRef.current
      const edge = (next === undefined) !== (prev === undefined)
      const changed =
        next !== undefined && prev !== undefined && Math.abs(next - prev) >= MIN_DELTA
      if (!edge && !changed) return
      const now = performance.now()
      if (!edge && now - levelLastCommitRef.current < MIN_COMMIT_MS) return
      levelLastCommitRef.current = now
      levelLastValRef.current = next
      setLevel(next)
    }
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
          commit(Math.min(1, rms * 3.2))
        } else commit(undefined)
      } else {
        const player = playerRef.current
        commit(player && player.playing ? player.level : undefined)
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Transcript helpers --------------------------------------------------
  // Streaming display invariant: the caption shows only the CURRENT sentence,
  // never the whole accumulated reply. We keep the full raw text in
  // turnTextRef (for the spoken pass), but the entry's display `text` is the
  // LAST sentence of the markdown-stripped accumulation, tagged with its `seg`
  // index so transcript.tsx re-keys (switches) as sentences complete.
  const appendAssistantText = useCallback((fragment: string) => {
    setEntries((prev) => {
      if (!asstIdRef.current) {
        turnCounterRef.current += 1
        asstIdRef.current = `a${turnCounterRef.current}`
        turnTextRef.current = ""
      }
      const id = asstIdRef.current
      turnTextRef.current += fragment
      const stripped = stripMarkdown(turnTextRef.current)
      const sentences = splitSentences(stripped)
      const lastIdx = Math.max(0, sentences.length - 1)
      const display = sentences.length ? sentences[lastIdx] : stripped
      return [
        ...prev.filter((e) => e.id !== id),
        { id, role: "assistant", text: display, seg: lastIdx, partial: true },
      ]
    })
  }, [])

  // ---- COO thread bookkeeping ----------------------------------------------
  // Threads persist (the panel + switching surface). A finished thread keeps
  // orbiting as a satellite for THREAD_PARK_MS, then parks (drops from the orb
  // constellation but STAYS in the thread list).
  const dispatchThread = useCallback((a: ThreadAction) => {
    setThreads((prev) => threadReducer(prev, a))
  }, [])

  const schedulePark = useCallback((id: string) => {
    const existing = parkTimers.current.get(id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      parkTimers.current.delete(id)
      setThreads((prev) => threadReducer(prev, { type: "park", id }))
    }, THREAD_PARK_MS)
    parkTimers.current.set(id, t)
  }, [])

  // ---- Thread controls (panel) ---------------------------------------------
  const selectThread = useCallback((id: string | null) => setTargetThreadId(id), [])
  const renameThread = useCallback((id: string, label: string) => {
    if (label.trim()) {
      dispatchThread({ type: "label", id, label })
      saveThreadLabel(id, label.trim()) // persist override so it survives reload
    }
  }, [dispatchThread])
  const dismissThread = useCallback((id: string) => {
    const tmr = parkTimers.current.get(id)
    if (tmr) { clearTimeout(tmr); parkTimers.current.delete(id) }
    dispatchThread({ type: "dismiss", id })
    setTargetThreadId((cur) => (cur === id ? null : cur))
    // Tombstone it (so rehydrate won't resurrect the chip from the still-alive
    // gateway child) and prune its now-dead label override.
    addDismissedThread(id)
    removeThreadLabel(id)
  }, [dispatchThread])

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

  // ---- Action channel (decision-card buttons) ------------------------------
  // A card button sends a SYNTHETIC user message back to the orchestrator —
  // the same sendMessage path the mic uses. No new WS event / route. The human
  // tail (after the machine `[card-action …]` tag) is shown as a user line.
  const cardAction = useCallback((message: string) => {
    const orch = orchestratorIdRef.current
    const msg = message.trim()
    if (!orch || !msg) return
    const display = stripMarkdown(msg.replace(/^\[card-action[^\]]*\]\s*/, "")).trim()
    if (display) {
      setEntries((prev) => [...prev, { id: `u${Date.now()}`, role: "user", text: display }])
    }
    setState("thinking")
    api.sendMessage(orch, { message: msg }).catch(() => { setState("idle"); stopLevelLoop() })
  }, [stopLevelLoop])

  // ---- WS subscription -----------------------------------------------------
  useEffect(() => {
    const player = playerRef.current!
    player.onIdle(() => {
      setState((s) => (s === "speaking" ? "idle" : s))
      stopLevelLoop()
    })

    const sid = (p: unknown): string | undefined =>
      typeof p === "object" && p !== null ? (p as { sessionId?: string }).sessionId : undefined

    const GLOBAL_TTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    // Speak the completed reply. The transcript is driven SENTENCE-BY-SENTENCE
    // across ALL paths: each sentence REPLACES the caption (tagged with its
    // index) so it switches in sync with the voice instead of showing one
    // concatenated blob. We always route through speak() — it picks Web Speech,
    // or the estimated-timer fallback (no synth), or caption-only timers
    // (`mute`, when Kokoro audio is already playing). Markdown is stripped so
    // the TTS never reads syntax aloud.
    const speakReplyIfNeeded = (asstId: string | null) => {
      const finalize = () => {
        if (!asstId) return
        setEntries((prev) => prev.map((e) => (e.id === asstId ? { ...e, partial: false } : e)))
      }
      const captionSentence = ({ text: sentence, index }: { text: string; index: number }) => {
        if (!asstId) return
        setEntries((prev) =>
          prev.map((e) =>
            e.id === asstId ? { ...e, text: sentence, seg: index, partial: true } : e,
          ),
        )
      }
      const mutedNow = mutedRef.current
      const kokoro = audioThisTurnRef.current && !mutedNow
      audioThisTurnRef.current = false
      const text = stripMarkdown(turnTextRef.current).trim()
      if (!text) {
        finalize()
        setState("idle")
        stopLevelLoop()
        return
      }
      // Record which voice is producing this turn so the UI can show neural vs
      // fallback. `kokoro` is true only when server talk:audio actually arrived
      // and played — so a silent Kokoro break surfaces here as "fallback". When
      // muted there is no voice at all → null (the UI shows a "Muted" badge).
      setVoiceMode(mutedNow ? null : kokoro ? "neural" : "fallback")
      setState("speaking")
      // When kokoro is true, server audio owns the speaking/idle transition via
      // player.onIdle — speak() runs caption-only timers and we only finalize.
      const onDone = () => {
        if (!kokoro) {
          setState((s) => (s === "speaking" ? "idle" : s))
          stopLevelLoop()
        }
        finalize()
      }
      // mute the synth when Kokoro audio owns playback OR the user muted: both
      // run caption-only timers so the transcript advances without any sound.
      speakRef.current
        .speak(text, { mute: mutedNow || kokoro, onSentence: captionSentence })
        .then(onDone)
        .catch(onDone)
    }

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      if (GLOBAL_TTS.has(event)) {
        if (event === TALK_EVENTS.ttsDownloadProgress) setTtsStatus({ kind: "downloading", progress: (payload as { progress?: number }).progress ?? 0 })
        else if (event === TALK_EVENTS.ttsDownloadComplete) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "error", message: (payload as { error?: string }).error ?? "TTS error" })
        return
      }

      if (event === TALK_EVENTS.engine) {
        const ev = payload as TalkEngineEvent
        setEngineInfo((prev) => ({
          ...prev,
          engine: ev.engine,
          model: ev.model,
          fallback: ev.fallback,
        }))
        return
      }

      if (event === TALK_EVENTS.focus) {
        const ev = payload as TalkFocusEvent
        if (ev.parentId === orchestratorIdRef.current) {
          threadIdsRef.current.add(ev.cooId) // route this child's stream immediately
          const t = parkTimers.current.get(ev.cooId)
          if (t) { clearTimeout(t); parkTimers.current.delete(ev.cooId) }
          dispatchThread({ type: "focus", id: ev.cooId, label: ev.label, ts: Date.now() })
        }
        return
      }

      if (event === TALK_EVENTS.threadLabel) {
        const ev = payload as TalkThreadLabelEvent
        if (ev.sessionId === orchestratorIdRef.current) {
          dispatchThread({ type: "label", id: ev.threadId, label: ev.label })
        }
        return
      }

      const s = sid(payload)
      const isOrch = s === orchestratorIdRef.current
      const isChild = s !== undefined && threadIdsRef.current.has(s)

      switch (event) {
        case "session:delta": {
          const ev = payload as SessionDeltaEvent
          if (isOrch) {
            if (ev.type === "text" && typeof ev.content === "string" && ev.content) {
              appendAssistantText(ev.content)
              setState((st) => (st === "speaking" ? st : "thinking"))
            }
          } else if (isChild && s) {
            dispatchThread({ type: "activity", id: s, ts: Date.now() }) // keep alive/working
          }
          break
        }
        case TALK_EVENTS.audio: {
          if (!isOrch) break
          // Muted = silent/read mode: discard server (Kokoro) audio entirely.
          // The caption still advances via speakReplyIfNeeded's mute path.
          if (mutedRef.current) break
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
            // Hand the finished assistant entry id to the speaker so it can swap
            // the caption per spoken sentence; the speaker finalizes `partial`.
            const finishedId = asstIdRef.current
            asstIdRef.current = null
            speakReplyIfNeeded(finishedId)
          } else if (isChild && s) {
            dispatchThread({ type: "done", id: s, ts: Date.now() })
            schedulePark(s)
          }
          break
        }
      }
    })

    return () => { unsub() }
  }, [gateway, appendAssistantText, dispatchThread, schedulePark, startLevelLoop, stopLevelLoop, upsertCard, patchCard, dismissCard, clearCards])

  // ---- Server rehydration --------------------------------------------------
  // Replay the reused orchestrator session so the transcript + COO thread chips
  // survive a full reload / mobile tab-discard. Non-clobbering: a live transcript
  // is never overwritten, and thread rebuilds MERGE (additive) so a reconnect
  // can pick up threads created while the socket was down without dropping live
  // ones. Cards are intentionally NOT rehydrated — they are transient; the
  // orchestrator re-pushes any decision card it still wants on screen.
  const rehydrate = useCallback(async (orchId: string) => {
    try {
      const [session, children] = await Promise.all([
        api.getSession(orchId).catch(() => undefined),
        api.getSessionChildren(orchId).catch(() => [] as Record<string, unknown>[]),
      ])
      if (orchestratorIdRef.current !== orchId) return // superseded
      const mapped = messagesToEntries(session as Record<string, unknown> | undefined)
      if (mapped.length) setEntries((cur) => (cur.length ? cur : mapped))

      const rebuilt = childrenToThreads(
        children as Record<string, unknown>[],
        loadThreadLabels(),
        loadDismissedThreads(),
      )
      if (rebuilt.length) {
        setThreads((cur) => {
          if (!cur.length) return rebuilt
          const known = new Set(cur.map((t) => t.id))
          const adds = rebuilt.filter((t) => !known.has(t.id))
          return adds.length ? [...cur, ...adds] : cur
        })
      }
      // Drop a persisted target selection that no longer maps to any thread.
      setTargetThreadId((cur) => {
        if (!cur) return cur
        const exists =
          rebuilt.some((t) => t.id === cur) || threadsRef.current.some((t) => t.id === cur)
        return exists ? cur : null
      })
    } catch {
      /* best-effort; a later reconnect rehydrate will retry */
    }
  }, [])

  // Marks that the bootstrap has kicked off the INITIAL rehydrate, so the
  // reconnect effect below only gates on it (never consumes it) — otherwise the
  // first genuine reconnect (the first firing where orch is non-null) would be
  // swallowed and a mobile tab-resume right after load wouldn't re-pull.
  const didInitialReconnectRef = useRef(false)

  // Create (or reuse) the orchestrator session and rehydrate it. Extracted so an
  // ENGINE switch can RE-BOOTSTRAP: the POST /api/talk/session reuse-guard refuses
  // to reuse a session whose engine differs from the freshly-resolved one, so a
  // plain re-create lands the new engine on a fresh session id.
  const bootstrapSession = useCallback(async () => {
    try {
      const r = await api.talkCreateSession()
      setOrchestratorId(r.sessionId)
      void rehydrate(r.sessionId)
      didInitialReconnectRef.current = true
    } catch { /* surfaced via connection hint */ }
  }, [rehydrate])

  // Refresh the active orchestrator engine/model + the available engine set.
  const refreshEngineInfo = useCallback(async () => {
    try {
      const e = await api.talkEngineGet()
      setEngineInfo({
        engine: e.engine, model: e.model, fallback: e.fallback, reason: e.reason, available: e.available, loaded: true,
      })
    } catch { /* keep prior info */ }
  }, [])

  // ---- Bootstrap orchestrator + probe TTS/engine (gated on activation) ------
  useEffect(() => {
    if (!activated) return
    let alive = true
    void bootstrapSession()
    void refreshEngineInfo()
    api.talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.ttsDownloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [activated, bootstrapSession, refreshEngineInfo])

  // ---- Engine / model switching --------------------------------------------
  // Engine: persist then re-bootstrap (new-chat-only). Model: persist only
  // (applies on the live session's next turn — the backend mutates it for us).
  const switchEngine = useCallback((engine: string) => {
    void (async () => {
      try {
        const r = await api.talkEngineSet({ engine })
        setEngineInfo((prev) => ({
          ...prev, engine: r.engine, model: r.model, fallback: r.fallback, reason: r.reason, available: r.available,
        }))
        await bootstrapSession()
      } catch { /* leave prior engine; fallback surfaced in the picker */ }
    })()
  }, [bootstrapSession])

  const switchModel = useCallback((model: string) => {
    void (async () => {
      try {
        const r = await api.talkEngineSet({ model })
        setEngineInfo((prev) => ({
          ...prev, engine: r.engine, model: r.model, fallback: r.fallback, reason: r.reason, available: r.available,
        }))
      } catch { /* keep prior */ }
    })()
  }, [])

  // ---- Persist the routed-thread selection ---------------------------------
  useEffect(() => { saveTargetThread(targetThreadId) }, [targetThreadId])

  // ---- Re-rehydrate after a WS reconnect (mobile tab-resume) ----------------
  // Only GATES on the bootstrap's initial-rehydrate flag (set in the bootstrap
  // effect, not consumed here), so the first real reconnect after load re-pulls.
  useEffect(() => {
    if (!activated) return
    const orch = orchestratorIdRef.current
    if (!orch) return
    if (!didInitialReconnectRef.current) return // bootstrap hasn't rehydrated yet
    void rehydrate(orch)
  }, [activated, gateway.connectionSeq, rehydrate])

  // ---- Whisper model download (mic tap on a fresh install) -----------------
  // When the mic tap finds no local STT model, useStt flips to "no-model"; drop
  // the optimistic "listening" state back to idle so the download modal reads
  // cleanly. dismiss returns to idle; startDownload streams progress over WS.
  useEffect(() => {
    if (stt.state === "no-model") {
      setState((s) => (s === "listening" ? "idle" : s))
      stopLevelLoop()
    }
  }, [stt.state, stopLevelLoop])

  const dismissSttDownload = useCallback(() => {
    sttRef.current.dismissDownload()
    setState((s) => (s === "listening" ? "idle" : s))
    stopLevelLoop()
  }, [stopLevelLoop])

  // ---- Mic control (plain tap-to-talk) -------------------------------------
  const startListening = useCallback(() => {
    playerRef.current?.resume()
    // Unlock browser TTS within the user gesture (iOS Safari requires this, or
    // the post-network reply is silently blocked).
    try { speakRef.current.prime() } catch { /* noop */ }
    setState("listening")
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop])

  // ---- Shared send path (voice + typed) ------------------------------------
  // The single way a user message reaches the orchestrator: shows the clean text
  // as a user line, applies the thread route-hint override, and POSTs. Reused by
  // BOTH the mic (stop()) and the typed-text input so they never diverge.
  const sendToOrchestrator = useCallback((rawText: string) => {
    const orch = orchestratorIdRef.current
    const text = rawText.trim()
    if (!orch || !text) return
    setEntries((prev) => [
      ...prev,
      { id: `u${Date.now()}`, role: "user", text: stripMarkdown(text) },
    ])
    // Switch override: if a thread is selected, prepend a machine route hint so
    // the orchestrator CONTINUES that COO session instead of spawning a new one.
    // The transcript keeps the clean text; only the engine sees the hint.
    const target = targetThreadIdRef.current
      ? threadsRef.current.find((t) => t.id === targetThreadIdRef.current)
      : null
    const outbound = target
      ? `[Route this to the existing "${target.label}" COO thread: session ${target.id}. Continue that thread instead of spawning a new one.]\n${text}`
      : text
    setState("thinking")
    api.sendMessage(orch, { message: outbound }).catch(() => {
      setState("idle"); stopLevelLoop()
    })
  }, [stopLevelLoop])

  /** Type-to-talk: send a typed message exactly like a transcribed voice turn.
   *  Works even when STT is unavailable — the graceful fallback for the mic. */
  const sendText = useCallback((text: string) => {
    sendToOrchestrator(text)
  }, [sendToOrchestrator])

  /** Toggle silent/text mode. Turning it ON silences any in-flight speech now. */
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      try { localStorage.setItem("talk-muted", next ? "1" : "0") } catch { /* noop */ }
      if (next) {
        try { speakRef.current.cancel() } catch { /* noop */ }
        playerRef.current?.reset()
        setState((st) => (st === "speaking" ? "idle" : st))
        stopLevelLoop()
      }
      return next
    })
  }, [stopLevelLoop])

  const stop = useCallback(async () => {
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return
      if (text && text.trim()) {
        sendToOrchestrator(text)
      } else {
        // Empty/failed transcription — return to idle and wait for the next tap.
        setState("idle"); stopLevelLoop()
      }
    } else {
      s.cancelRecording()
      playerRef.current?.reset()
      setState("idle"); stopLevelLoop()
    }
  }, [stopLevelLoop, sendToOrchestrator])

  // ---- Interrupt playback (Stop button while speaking) ---------------------
  // Cancels the in-flight Web-Speech sentence chain (and its caption timers) and
  // resets the server-audio player in case Kokoro audio is playing, then drops
  // to idle. The backend turn already completed by the time we're speaking, so
  // there's nothing to cancel server-side; this is pure playback-stop.
  const stopSpeaking = useCallback(() => {
    try { speakRef.current.cancel() } catch { /* noop */ }
    playerRef.current?.reset()
    setState((s) => (s === "speaking" ? "idle" : s))
    stopLevelLoop()
  }, [stopLevelLoop])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      for (const t of parkTimers.current.values()) clearTimeout(t)
      parkTimers.current.clear()
      try { speakRef.current.cancel() } catch { /* noop */ }
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  return useMemo(
    () => ({
      state, entries, threads, targetThreadId, cards, level,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      sttError: stt.error,
      ttsStatus,
      voiceMode,
      muted, toggleMute, sendText,
      sttState: stt.state,
      sttDownloadProgress: stt.downloadProgress,
      startSttDownload: stt.startDownload,
      dismissSttDownload,
      engineInfo,
      switchEngine, switchModel,
      selectThread, renameThread, dismissThread,
      activate, cardAction,
      startListening, stop, stopSpeaking,
    }),
    [state, entries, threads, targetThreadId, cards, level, gateway.connected, listening, stt.available, stt.error, stt.state, stt.downloadProgress, stt.startDownload, ttsStatus, voiceMode, muted, toggleMute, sendText, dismissSttDownload, engineInfo, switchEngine, switchModel, selectThread, renameThread, dismissThread, activate, cardAction, startListening, stop, stopSpeaking],
  )
}
