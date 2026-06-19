# Jinn Web UI — Auth & Remote Password Reset

This documents the simple shared-password login for the Jinn web UI and the
**remote password-reset API** an operator's external app (e.g. a Next.js fleet
dashboard) calls to set/reset/clear a customer instance's web password.

> Audience: the AI agent building the operator's external Next.js app. Implement
> the **caller** side described under "Remote reset API" — the Jinn side is done.

## Model

Two secrets live in each instance's `config.yaml` under `gateway:`:

| Field                  | What it is                                                                 | Who holds it |
|------------------------|---------------------------------------------------------------------------|--------------|
| `gateway.authPassword` | sha256 hash of the **web-UI login password**. Unset ⇒ no login required.   | the operator (sets per customer); customers never get it |
| `gateway.adminKey`     | **master admin key** (plaintext). Authenticates the reset API + automation. | the operator's external app only — never given to customers |

- Customers are **not** meant to log into the web UI. The operator sets up each
  instance and holds the login password.
- `adminKey` is **provisioned** (cloud-init / config.yaml at image build) — it is
  NOT settable via the API (chicken-and-egg). Use a strong, per-fleet or
  per-instance secret. Same value the external app will send.
- Opt-in: if `authPassword` is unset, the UI is open (so fresh/golden images
  aren't accidentally locked).

## Remote reset API (implement the caller for this)

```
POST /api/admin/reset-password
Headers: X-Jinn-Admin-Key: <gateway.adminKey>
         Content-Type: application/json
Body:    { "password": "new-web-password" }   // empty/omitted ⇒ clears (disables login)
```

Responses:
- `200 { "ok": true, "loginRequired": true }`  — password set
- `200 { "ok": true, "loginRequired": false }` — password cleared (login disabled)
- `403 { "ok": false, "error": "forbidden" }`  — missing/wrong admin key, or no adminKey configured

The change persists to `config.yaml` and takes effect immediately (no restart).
Setting a new password invalidates existing browser sessions.

### Example (Next.js route handler / server action)

```ts
// Server-side only — never expose JINN_ADMIN_KEY to the browser.
async function resetJinnPassword(instanceBaseUrl: string, newPassword: string) {
  const res = await fetch(`${instanceBaseUrl}/api/admin/reset-password`, {
    method: "POST",
    headers: {
      "X-Jinn-Admin-Key": process.env.JINN_ADMIN_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: newPassword }),
  })
  if (!res.ok) throw new Error(`reset failed: ${res.status}`)
  return res.json() as Promise<{ ok: boolean; loginRequired: boolean }>
}
```

- `instanceBaseUrl` = the customer instance's public URL, e.g.
  `https://jinn.<ip>.sslip.io`.
- Always call from the server (the admin key is a secret). Use HTTPS.

## Login endpoints (for reference — the web UI already uses these)

- `GET /api/auth/status` → `{ required: boolean, authed: boolean }` (public).
- `POST /api/login` `{ password }` → on success sets an httpOnly `jinn_session`
  cookie; `{ ok: true }` / `401 { ok:false, error }`.
- `POST /api/logout` → clears the cookie.

## Automation / API access when login is enabled

The gateway can't distinguish nginx-proxied from local traffic by IP, so trusted
automation authenticates with the admin key header instead of a cookie:

```
X-Jinn-Admin-Key: <gateway.adminKey>
```

Any API call carrying a valid `X-Jinn-Admin-Key` bypasses the login gate (same
header used for the reset endpoint). The browser uses the cookie.

## Security notes

- Serve over HTTPS (nginx TLS). The admin key and password travel in headers/body.
- Keep `adminKey` strong and secret (server-side env in the external app).
- `authPassword`/`adminKey` are redacted from `GET /api/config`.
- Login is rate-limited only lightly; put the admin endpoint behind your own app's
  auth too.
