import { useCallback, useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { useSessionChat } from '@/routes/talk/use-session-chat'
import { ChatMessages } from '@/components/chat/chat-messages'
import { api } from '@/lib/api'
import { useTalkContext } from './talk-provider'
import type { AttachedState } from './session-search'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Peek popup for any session (a COO child, an employee, or a soft-linked
 * attachment), reusing the main chat's <ChatMessages> renderer so bubbles, tool
 * groups, markdown, file links and media look identical to the primary chat.
 *
 * Beyond read-only viewing it now carries the attach controls: Attach (observe)
 * / Attach (engage) / Detach in the header, derived from this session's state in
 * the live talk graph, plus an engage composer (visible only while attached in
 * engage mode) for sending follow-ups.
 *
 * Self-contained: pass a sessionId + open flag. Wiring (which session to show,
 * when to open) is the caller's job. Orchestrator id + graph come from context.
 */

interface SessionPeekProps {
  sessionId: string | null
  open: boolean
  onClose: () => void
}

/** Human label for the modal header: session title → employee → short id. */
function headerLabel(
  session: Record<string, unknown> | undefined,
  sessionId: string | null,
): string {
  const title = typeof session?.title === 'string' ? session.title.trim() : ''
  if (title) return title
  const employee = typeof session?.employee === 'string' ? session.employee.trim() : ''
  if (employee) return employee
  if (sessionId) return `Session ${sessionId.slice(0, 8)}`
  return 'Conversation'
}

export function SessionPeek({ sessionId, open, onClose }: SessionPeekProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {open && sessionId ? (
          <SessionPeekBody sessionId={sessionId} />
        ) : (
          // Keep a title mounted for a11y even before a session is selected.
          <DialogHeader className="border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-3)] text-left">
            <DialogTitle className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">
              Conversation
            </DialogTitle>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Body is split out so useSessionChat only runs while the modal is open. */
function SessionPeekBody({ sessionId }: { sessionId: string }) {
  const { messages, streamingText, loading, session, isInitialLoading, error } =
    useSessionChat(sessionId)
  const label = headerLabel(session, sessionId)
  const hasContent = messages.length > 0 || !!streamingText

  // Attach-state comes from the live talk graph (self-updates on talk:graph WS
  // deltas). null → not attached → show plain Attach buttons.
  const { orchestratorId, graph } = useTalkContext()
  const attachedState: AttachedState = useMemo(() => {
    const node = graph.find((n) => n.id === sessionId)
    if (node?.attached && (node.mode === 'observe' || node.mode === 'engage')) {
      return `attached-${node.mode}` as AttachedState
    }
    return null
  }, [graph, sessionId])

  return (
    <>
      <DialogHeader className="border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-3)] pr-[var(--space-10)] text-left">
        <DialogTitle className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          {label}
        </DialogTitle>
        <AttachControls
          orchestratorId={orchestratorId}
          targetId={sessionId}
          attachedState={attachedState}
        />
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
        {isInitialLoading ? (
          <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            Loading conversation…
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            Couldn’t load this conversation.
          </div>
        ) : !hasContent ? (
          <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            No messages yet
          </div>
        ) : (
          // Reuse the main chat renderer verbatim — groupMessages + per-message
          // bubbles + markdown/file-links live inside ChatMessages. Now driven by
          // the shared live pipeline so it streams tokens + media in real time.
          <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
        )}
      </div>

      {/* Engage composer — only when attached in engage mode. A follow-up to an
          already-attached engage session can't go through talkDelegate (the
          attach path 400s "already attached", and the continue path 400s "not
          one of your COO threads" — attachments aren't owned children), so we
          post straight to the session message API, exactly as the backend's own
          continueThread relay does. */}
      {attachedState === 'attached-engage' && <EngageComposer targetId={sessionId} />}
    </>
  )
}

const btnBase =
  'inline-flex h-7 items-center rounded-full border px-3 text-[length:var(--text-caption1)] transition-colors disabled:opacity-50'
const btnIdle =
  'border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]'
const btnAccent =
  'border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)] active:opacity-80'

/** Attach / detach controls reflecting the target's live talk-graph state. */
function AttachControls({
  orchestratorId,
  targetId,
  attachedState,
}: {
  orchestratorId: string | null
  targetId: string
  attachedState: AttachedState
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!orchestratorId) return
      setBusy(true)
      setErr(null)
      try {
        await action()
        // No optimistic write — the talk:graph WS delta updates attachedState.
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusy(false)
      }
    },
    [orchestratorId],
  )

  if (!orchestratorId) return null

  const attach = (mode: 'observe' | 'engage') =>
    run(() => api.talkDelegate({ sessionId: orchestratorId, thread: targetId, attach: true, mode }))
  const detach = () =>
    run(() => api.talkDelegate({ sessionId: orchestratorId, thread: targetId, detach: true }))

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {attachedState === null ? (
        <>
          <button className={`${btnBase} ${btnIdle}`} disabled={busy} onClick={() => attach('observe')}>
            Attach
          </button>
          <button className={`${btnBase} ${btnAccent}`} disabled={busy} onClick={() => attach('engage')}>
            Attach + engage
          </button>
        </>
      ) : (
        <>
          <span className="inline-flex h-7 items-center gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            ⇄ {attachedState === 'attached-engage' ? 'engaged' : 'observing'}
          </span>
          <button className={`${btnBase} ${btnIdle}`} disabled={busy} onClick={detach}>
            Detach
          </button>
        </>
      )}
      {err && (
        <span className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{err}</span>
      )}
    </div>
  )
}

/** One-line composer that relays a follow-up to an attached engage session. */
function EngageComposer({ targetId }: { targetId: string }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || busy) return
    setBusy(true)
    setErr(null)
    try {
      // Plain session message API — NOT talkDelegate (see the comment at the
      // call site above for why both delegate paths 400 here).
      await api.sendMessage(targetId, { message })
      setDraft('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }, [draft, busy, targetId])

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void send() }}
      className="flex items-center gap-2 border-t border-[var(--separator)] bg-[var(--bg)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Message this session…"
        aria-label="Message this session"
        disabled={busy}
        className="h-9 flex-1 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-4 text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={busy || !draft.trim()}
        className="inline-flex size-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)] transition-opacity disabled:opacity-50"
      >
        <Send size={16} />
      </button>
      {err && (
        <span className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{err}</span>
      )}
    </form>
  )
}
