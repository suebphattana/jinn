import { useEffect, useState } from "react"

/**
 * Gates the whole app behind a shared-password login when the gateway has one
 * configured (GET /api/auth/status → { required, authed }). When no password is
 * set, or the session cookie is valid, it renders the app untouched.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "login">("loading")

  const check = async () => {
    try {
      const r = await fetch("/api/auth/status")
      const d = await r.json()
      setState(!d.required || d.authed ? "ok" : "login")
    } catch {
      // Fail open on a transient status error — never hard-lock the UI.
      setState("ok")
    }
  }

  useEffect(() => {
    void check()
  }, [])

  if (state === "loading") return null
  if (state === "login") return <LoginScreen onSuccess={() => setState("ok")} />
  return <>{children}</>
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pw, setPw] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      })
      const d = await r.json()
      if (d.ok) onSuccess()
      else setErr(d.error || "Incorrect password")
    } catch {
      setErr("Login failed — please try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg, #0f1b3d)",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 320,
          padding: 28,
          borderRadius: 14,
          background: "var(--bg-secondary, rgba(255,255,255,0.06))",
          border: "1px solid var(--separator, rgba(255,255,255,0.12))",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary, #fff)" }}>Sign in</div>
        <div style={{ fontSize: 13, color: "var(--text-tertiary, #96a2be)" }}>
          This Jinn instance is password-protected.
        </div>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--separator, rgba(255,255,255,0.15))",
            background: "var(--bg, rgba(0,0,0,0.2))",
            color: "var(--text-primary, #fff)",
            fontSize: 14,
          }}
        />
        {err && <div style={{ color: "#EF4444", fontSize: 13 }}>{err}</div>}
        <button
          type="submit"
          disabled={busy || !pw}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent, #2E5BFF)",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            opacity: busy || !pw ? 0.5 : 1,
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  )
}
