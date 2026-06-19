import { useCallback, useEffect, useState } from "react"

interface AuthState {
  status: string
  mode?: "device" | "paste-code" | null
  url?: string
  code?: string
  error?: string
}

/**
 * Subscription auth row for the Engine Configuration section.
 * - Codex (device): shows a one-time code + link; auto-polls until connected.
 * - Claude (paste-code): shows a sign-in link, then a field to paste the code
 *   the user copies from the OAuth page.
 * No API key, no terminal — works on a remote server.
 */
export function EngineAuthRow({ engine, provider }: { engine: string; provider: string }) {
  const [state, setState] = useState<AuthState>({ status: "unknown" })
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [codeInput, setCodeInput] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/engines/${engine}/auth-status`)
      const d = await r.json()
      // Don't clobber an active paste-code dialog with a poll that lacks the url.
      setState((prev) =>
        prev.status === "pending" && d.status === "pending" && !d.url ? prev : d,
      )
    } catch {
      /* non-fatal */
    }
  }, [engine])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 4000)
    return () => clearInterval(t)
  }, [refresh])

  const connect = async () => {
    setBusy(true)
    try {
      const r = await fetch(`/api/engines/${engine}/login`, { method: "POST" })
      setState(await r.json())
    } catch (e) {
      setState({ status: "failed", error: String(e) })
    } finally {
      setBusy(false)
    }
  }

  const submitCode = async () => {
    if (!codeInput.trim()) return
    setSubmitting(true)
    try {
      const r = await fetch(`/api/engines/${engine}/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeInput.trim() }),
      })
      const d = await r.json()
      if (d.status === "connected") {
        setState({ status: "connected" })
        setCodeInput("")
      } else {
        setState((prev) => ({ ...prev, error: d.error || "Code rejected" }))
      }
    } catch (e) {
      setState((prev) => ({ ...prev, error: String(e) }))
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async () => {
    await fetch(`/api/engines/${engine}/login/cancel`, { method: "POST" }).catch(() => {})
    setState({ status: "not_connected" })
    setCodeInput("")
    void refresh()
  }

  const connected = state.status === "connected"
  const pending = state.status === "pending"
  const pasteMode = state.mode === "paste-code"
  const pill = connected
    ? { text: "🟢 Connected", color: "#22C55E" }
    : pending
    ? { text: "⏳ Waiting…", color: "var(--text-tertiary)" }
    : { text: "🔴 Not connected", color: "var(--text-tertiary)" }

  const btn = { padding: "4px 12px", borderRadius: "8px", fontSize: "var(--text-subheadline)", cursor: "pointer" } as const

  return (
    <div className="py-[var(--space-2)]">
      <div className="flex items-center justify-between gap-[var(--space-4)]">
        <label className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0">
          {provider} Account
        </label>
        <div className="flex items-center gap-[var(--space-3)]">
          <span style={{ color: pill.color, fontSize: "var(--text-subheadline)" }}>{pill.text}</span>
          {!pending && (
            <button
              onClick={() => void connect()}
              disabled={busy}
              style={{
                ...btn,
                background: connected ? "transparent" : "var(--accent, #2E5BFF)",
                color: connected ? "var(--text-secondary)" : "#fff",
                border: connected ? "1px solid var(--separator)" : "none",
                opacity: busy ? 0.5 : 1,
              }}
            >
              {busy ? "…" : connected ? "Reconnect" : `Connect with ${provider}`}
            </button>
          )}
        </div>
      </div>

      {pending && state.url && (
        <div
          className="mt-[var(--space-2)] p-[var(--space-3)]"
          style={{ borderRadius: "10px", border: "1px solid var(--separator)", background: "rgba(127,127,127,0.06)" }}
        >
          <div className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] mb-[var(--space-2)]">
            ① เปิดลิงก์นี้แล้วล็อกอิน {provider}
          </div>
          <a href={state.url} target="_blank" rel="noreferrer"
             style={{ color: "var(--accent, #2E5BFF)", textDecoration: "underline", wordBreak: "break-all" }}>
            {state.url}
          </a>

          {/* Codex: device code shown here. Claude: paste-code input. */}
          {!pasteMode && state.code && (
            <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)]">
              <span className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">② ใส่โค้ดนี้:</span>
              <code style={{ padding: "6px 14px", borderRadius: "8px", border: "1px solid var(--separator)", fontFamily: "monospace", fontSize: "20px", letterSpacing: "0.15em" }}>
                {state.code}
              </code>
              <button onClick={() => { void navigator.clipboard?.writeText(state.code ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                style={{ ...btn, border: "1px solid var(--separator)", color: "var(--text-secondary)", fontSize: "var(--text-caption1)" }}>
                {copied ? "คัดลอกแล้ว ✓" : "คัดลอก"}
              </button>
            </div>
          )}

          {pasteMode && (
            <div className="mt-[var(--space-2)]">
              <div className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] mb-[var(--space-1)]">
                ② คัดลอกโค้ดจากหน้าเว็บแล้ววางที่นี่:
              </div>
              <div className="flex items-center gap-[var(--space-2)]">
                <input
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="วางโค้ดที่นี่"
                  style={{ flex: 1, padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--separator)", background: "var(--surface, transparent)", color: "var(--text-primary)", fontFamily: "monospace" }}
                />
                <button onClick={() => void submitCode()} disabled={submitting || !codeInput.trim()}
                  style={{ ...btn, background: "var(--accent, #2E5BFF)", color: "#fff", border: "none", opacity: submitting || !codeInput.trim() ? 0.5 : 1 }}>
                  {submitting ? "กำลังเชื่อม…" : "ยืนยัน"}
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-[var(--space-3)] mt-[var(--space-2)]">
            <button onClick={() => void cancel()}
              style={{ ...btn, background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--text-caption1)" }}>
              ยกเลิก
            </button>
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              โค้ดหมดอายุใน ~15 นาที
            </span>
          </div>
        </div>
      )}

      {state.status === "failed" && state.error && (
        <div className="mt-[var(--space-1)] text-[length:var(--text-caption1)]" style={{ color: "#EF4444" }}>{state.error}</div>
      )}
    </div>
  )
}
