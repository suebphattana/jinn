# Jinn — Restart & Auto-Resume

How a Jinn instance restarts itself and **picks up its work afterwards**, and
what a droplet must provision for it to work.

> Audience: the AI agent building the operator's external control panel (the
> Next.js fleet dashboard) **and** whoever writes the droplet provisioning
> (cloud-init / golden image). The Jinn side is done — implement the **caller**
> + the **systemd unit** described here.

## Why this exists

Restarting the gateway kills the process that runs the assistant's current
session. Without help, the assistant dies mid-turn and the operator has to
message it again to discover it's back. Jinn solves this in two layers:

1. **Rejoin notice** — before exiting, a marker file is written; on the next
   boot the gateway waits for the connector to come up and sends a "✅ Back
   online" message directly (no LLM turn). Deterministic.
2. **Auto-resume** — if the marker names the session that triggered the
   restart, the gateway also **re-engages that session**: it routes a resume
   turn (the engine resumes with full prior context) so the assistant continues
   any unfinished work and replies on its own — **no operator message needed**.

## Two ways to trigger a restart

### A. `POST /api/restart` — portable, no sudo (use this from the control panel)

The gateway records the marker, returns `{ status: "restarting" }`, then calls
`process.exit(0)`. The **process supervisor brings it back** — so the systemd
unit MUST set `Restart=always` (see provisioning below). No shell, no sudo.

```
POST /api/restart
Headers: X-Jinn-Admin-Key: <gateway.adminKey>      # same key as the reset-password API
         Content-Type: application/json
Body: {
  "channel": "<connector channel id>",   // where to post the rejoin notice
  "connector": "discord",                 // optional, default "discord"
  "message": "✅ Back online — <context>", // the rejoin notice text
  "sessionId": "<session uuid>",          // OPTIONAL — set to auto-resume this session
  "resumePrompt": "Continue your work…"   // OPTIONAL — what to tell the resumed session
}
```

- Omit `sessionId` → notice only (assistant stays idle until messaged).
- Include `sessionId` → after the notice, the named session is resumed with
  `resumePrompt` (a sensible default is used if omitted). The session resumes
  for **any status except `waiting`** (a session paused on a Claude usage limit
  is left alone).
- `adminKey` auth: same model as [remote-admin-api.md](./remote-admin-api.md) —
  send `X-Jinn-Admin-Key`. Never expose it to the browser; call server-side.

```ts
// Server-side only.
async function restartInstance(baseUrl: string, opts: {
  channel: string; message: string; sessionId?: string; resumePrompt?: string;
}) {
  const res = await fetch(`${baseUrl}/api/restart`, {
    method: "POST",
    headers: { "X-Jinn-Admin-Key": process.env.JINN_ADMIN_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ connector: "discord", ...opts }),
  })
  if (!res.ok) throw new Error(`restart failed: ${res.status}`)
  return res.json() as Promise<{ status: "restarting" }>
}
```

### B. `tools/safe-restart.sh` — local operator/agent convenience (needs sudo)

Ships in `~/.jinn/tools/safe-restart.sh`. Writes the same marker, then
`sudo systemctl restart <service>`. Used by the on-box assistant when it deploys
its own code changes.

```
safe-restart.sh "<context>" "<sessionId>" "<resumePrompt>"
```

- Arg 2 (`sessionId`) is what enables auto-resume — the assistant passes **its
  own** session id so it comes back working.
- Reads the announce channel from `JINN_REJOIN_CHANNEL` (env). Fails loudly if
  unset — there is no baked-in channel.

## Provisioning checklist (droplet / golden image)

For both paths to work, the instance's systemd unit and sudoers must be set up:

1. **`Restart=always`** (+ `RestartSec=5`) in the `[Service]` section — REQUIRED
   for `POST /api/restart` (the gateway exits; the supervisor must relaunch it).
2. **`Environment=JINN_HOME=…`** so the gateway and `safe-restart.sh` agree on
   where the marker file (`$JINN_HOME/tmp/rejoin.json`) lives.
3. **`Environment=JINN_REJOIN_CHANNEL=<channel id>`** — only needed if the box
   uses `safe-restart.sh`. The API path takes the channel in the request body
   instead, so a control-panel-only fleet can skip this.
4. **`gateway.adminKey`** provisioned in `config.yaml` at image build (same key
   the control panel sends). See [remote-admin-api.md](./remote-admin-api.md).
5. **sudoers** (only if the box uses `safe-restart.sh`): a NOPASSWD rule scoped
   to exactly `/bin/systemctl restart <service>` (plus `is-active`/`status` if
   you health-check). The control-panel `POST /api/restart` path needs **no**
   sudo at all — prefer it for fleet automation.

Reference unit (`[Service]` excerpt):

```ini
[Service]
Type=simple
Environment=JINN_HOME=/home/<user>/jinn-home
Environment=JINN_REJOIN_CHANNEL=<connector-channel-id>   # optional; for safe-restart.sh
ExecStart=/opt/node24/bin/node /path/to/jinn/dist/bin/jinn.js start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
```

## Notes / gotchas

- The marker is **cleared before** the resume runs, so a resume turn that itself
  restarts the gateway can't loop.
- Status drift is handled: boot marks the stale session `interrupted`, but the
  engine may settle a recovered transcript to `idle` before the connector is up.
  The resume honours the explicit marker regardless (except `waiting`).
- Implemented gateway-side in `packages/jinn/src/gateway/rejoin.ts`
  (`flushRejoinNotice`) + `POST /api/restart` in `gateway/api.ts`.
