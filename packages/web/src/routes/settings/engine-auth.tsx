import { useCallback, useEffect, useState } from "react"

interface AuthState {
  status: string
  url?: string
  code?: string
  error?: string
}

/**
 * ChatGPT (Codex) device-auth row for the Engine Configuration section.
 * Polls /api/engines/:name/auth-status; on "Connect" it starts the device flow
 * and shows the verification URL + one-time code for the user to complete on any
 * browser. No API key, no terminal — works on a remote server.
 */
export function EngineAuthRow({ engine }: { engine: string }) {
  const [state, setState] = useState<AuthState>({ status: "unknown" })
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/engines/${engine}/auth-status`)
      setState(await r.json())
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

  const cancel = async () => {
    await fetch(`/api/engines/${engine}/login/cancel`, { method: "POST" }).catch(() => {})
    setState({ status: "not_connected" })
    void refresh()
  }

  const connected = state.status === "connected"
  const pending = state.status === "pending"
  const pill = connected
    ? { text: "🟢 Connected", color: "#22C55E" }
    : pending
    ? { text: "⏳ Waiting for code…", color: "var(--text-tertiary)" }
    : { text: "🔴 Not connected", color: "var(--text-tertiary)" }

  const btnBase = {
    padding: "4px 12px",
    borderRadius: "8px",
    fontSize: "var(--text-subheadline)",
    cursor: "pointer",
  } as const

  return (
    <div className="py-[var(--space-2)]">
      <div className="flex items-center justify-between gap-[var(--space-4)]">
        <label className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] shrink-0">
          ChatGPT Account
        </label>
        <div className="flex items-center gap-[var(--space-3)]">
          <span style={{ color: pill.color, fontSize: "var(--text-subheadline)" }}>{pill.text}</span>
          {!pending && (
            <button
              onClick={() => void connect()}
              disabled={busy}
              style={{
                ...btnBase,
                background: connected ? "transparent" : "var(--accent, #2E5BFF)",
                color: connected ? "var(--text-secondary)" : "#fff",
                border: connected ? "1px solid var(--separator)" : "none",
                opacity: busy ? 0.5 : 1,
              }}
            >
              {busy ? "…" : connected ? "Reconnect" : "Connect with ChatGPT"}
            </button>
          )}
        </div>
      </div>

      {pending && state.url && state.code && (
        <div
          className="mt-[var(--space-2)] p-[var(--space-3)]"
          style={{
            borderRadius: "10px",
            border: "1px solid var(--separator)",
            background: "rgba(127,127,127,0.06)",
          }}
        >
          <div className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] mb-[var(--space-2)]">
            ① เปิดลิงก์นี้แล้วล็อกอิน ChatGPT &nbsp;→&nbsp; ② ใส่โค้ดด้านล่าง
          </div>
          <a
            href={state.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent, #2E5BFF)", textDecoration: "underline", wordBreak: "break-all" }}
          >
            {state.url}
          </a>
          <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)]">
            <code
              style={{
                padding: "6px 14px",
                borderRadius: "8px",
                border: "1px solid var(--separator)",
                fontFamily: "monospace",
                fontSize: "20px",
                letterSpacing: "0.15em",
              }}
            >
              {state.code}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(state.code ?? "")
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              style={{ ...btnBase, border: "1px solid var(--separator)", color: "var(--text-secondary)", fontSize: "var(--text-caption1)" }}
            >
              {copied ? "คัดลอกแล้ว ✓" : "คัดลอกโค้ด"}
            </button>
            <button
              onClick={() => void cancel()}
              style={{ ...btnBase, background: "transparent", border: "none", color: "var(--text-tertiary)", fontSize: "var(--text-caption1)" }}
            >
              ยกเลิก
            </button>
          </div>
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[var(--space-2)]">
            โค้ดหมดอายุใน 15 นาที · หน้านี้จะอัปเดตเองเมื่อเชื่อมต่อสำเร็จ
          </div>
        </div>
      )}

      {state.status === "failed" && state.error && (
        <div className="mt-[var(--space-1)] text-[length:var(--text-caption1)]" style={{ color: "#EF4444" }}>
          {state.error}
        </div>
      )}
    </div>
  )
}
