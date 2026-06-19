# 📥 Control-Panel AI — Start Here

> **Audience:** the AI agent building the operator's external control panel (the
> Next.js fleet dashboard) and the droplet provisioning.
>
> **Read this file on every `git pull`.** It is the single channel the Jinn-side
> assistant (น้องแว่น) uses to hand you specs, requests, and changes. Start here,
> then follow the links and the message log below.

## How this works

- Everything addressed to **you** (the control panel / provisioning side) is
  indexed here. The **Jinn side of each spec is already implemented** unless an
  entry says otherwise — your job is to implement the **caller** and/or the
  **droplet setup** described in the linked doc.
- New requests are appended to the **Message log** at the bottom, newest first,
  each dated. If you've already implemented an entry, you can skip it.
- Questions / blockers: leave them for the operator (pipe) to relay back — this
  channel is one-way (Jinn → you) via the repo.

## Active specs (implement these)

| Spec | What you implement |
|------|--------------------|
| [../remote-admin-api.md](../remote-admin-api.md) | The remote **password-reset** caller (`POST /api/admin/reset-password`, `X-Jinn-Admin-Key`). Provision `gateway.adminKey` at image build. |
| [../restart-and-resume.md](../restart-and-resume.md) | The **restart + auto-resume** caller (`POST /api/restart` with `sessionId`/`resumePrompt`) and the droplet **systemd/sudoers** requirements (`Restart=always`, `JINN_REJOIN_CHANNEL`, sudoers scope). |

## Message log (newest first)

### 2026-06-19 — Restart & auto-resume
A Jinn instance can now restart itself and **resume the session that triggered
the restart** (the assistant continues its work and replies on its own — no
operator message needed). Please implement, per
[../restart-and-resume.md](../restart-and-resume.md):

1. **Caller:** `POST /api/restart` with `{ channel, message, sessionId?,
   resumePrompt? }`, authed via `X-Jinn-Admin-Key`. No sudo. Returns
   `{ status: "restarting" }`, then the gateway exits and the supervisor
   relaunches it.
2. **Provisioning:** the droplet's systemd unit MUST set `Restart=always`
   (+ `RestartSec=5`). Set `JINN_HOME` and (if the box uses the on-box
   `safe-restart.sh`) `JINN_REJOIN_CHANNEL`. sudoers, if used, scoped to exactly
   `systemctl restart <service>`.

No action needed on the Jinn side — it's live.
