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
| [golden-image-contract.md](./golden-image-contract.md) | The **Jinn run-contract** for the golden image (v7+): one Jinn owns the port, image is *ready-to-provision* not *pre-running*, config-at-provision, no baked agent, no Hermes, identity-verified health. |

## Message log (newest first)

### 2026-06-19 — Golden image v7: ready-to-provision Jinn run-contract
The port-hijack / "Telegram answered as Claude" issue on golden-image droplets
was traced to image v6 being **pre-running** (a baked lingering agent runs
`jinn start` on :7777, so the seat's own Jinn can't bind and health saw a 200
from the wrong process). The control-panel-side fixes + guardrail are done (your
side). The remaining piece is a **golden image rebuild (v7)** per the Jinn-side
contract: [golden-image-contract.md](./golden-image-contract.md).

Decisions from the Jinn side:
1. **One Jinn per droplet owns the port; nothing pre-binds it.** Image must be
   *ready-to-provision* (unit present but disabled, no linger/auto-update, no
   baked agent, no Hermes). Config (adminKey, authPassword, host, engine,
   connectors) is written **at provision time**, never baked.
2. **One tenant per droplet for launch.** Multi-seat-per-box (multiple Jinn on
   one droplet) is later, and only with a distinct port per seat.
3. **Public-IP UI** folds into provisioning: `gateway.host=0.0.0.0` +
   `authPassword` + `adminKey` + firewall the port.

Building v7 (the snapshot) is owned by whoever owns the image build — it is not
code in the Jinn repo. The contract doc is the spec to build against.

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
