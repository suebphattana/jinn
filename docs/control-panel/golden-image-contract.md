# Jinn Run-Contract for the Golden Image (v7+)

> **Audience:** whoever builds the Jinn golden image + the cloud-init that
> provisions a tenant from it (control-panel / provisioning side).
>
> This is the **Jinn-side** half of the contract — how a Jinn instance must be
> installed and run on a droplet. It is complementary to the control-panel-side
> contract (in the control-panel repo). The Jinn app code is done; this doc tells
> you how to package and start it.

## The one invariant

**Exactly one Jinn gateway per droplet owns the configured port (default 7777).
Nothing else may bind or pre-bind it.**

Every failure traced in golden image v6 reduces to a violation of this: the image
baked a *second, already-running* Jinn (a lingering `--user` unit as a baked
`agent` user) that grabbed :7777 at boot, so the tenant's own Jinn couldn't bind
and health checks saw a 200 from the wrong process.

## Image = "ready-to-provision", NOT "pre-running"

At **bake time** the image MUST:

- ✅ Have Node + deps installed and **this repo built** (`dist/` present).
- ✅ Have the Jinn systemd unit file **in place but `disabled`** — it must NOT
  start at image boot.
- ❌ NO `loginctl enable-linger`, NO `--user` unit, NO auto-update service (e.g.
  `*-update.service`) that runs `jinn start` on boot.
- ❌ NO baked tenant/agent user that auto-runs Jinn. The run user is decided at
  provision time (or is a single fixed service user that only starts on provision).
- ❌ NO Hermes installed or running. (Hermes is a separate legacy product; it must
  not exist on a Jinn image — a leftover Hermes will answer connectors as the
  wrong model.)
- ❌ NO tenant-specific `config.yaml` baked in (no adminKey/authPassword/tokens in
  the snapshot). Ship at most a minimal placeholder, or none.

Net: a freshly-booted golden image has **nothing listening on :7777**.

## Provision time (cloud-init) MUST

1. Choose/confirm the single run user + `JINN_HOME`, and write the systemd unit
   (see contract below) — or `daemon-reload` if baked.
2. Write `config.yaml` with the tenant's settings **before first start**:
   - `gateway.adminKey` (fleet/admin key — enables remote password reset & the
     control-panel APIs). See [../remote-admin-api.md](../remote-admin-api.md).
   - `gateway.authPassword` (sha256 of the web-UI password) if the UI should
     require login.
   - `gateway.host` = `0.0.0.0` **if** the UI is served on the public IP (default
     is `127.0.0.1` → tunnel-only). Open firewall on the port if so.
   - `engines.default` + `engines.openrouter` (apiKey/model) for an OpenRouter
     tenant — **do not** leave it defaulting to another engine.
   - the connector block(s) (e.g. Telegram bot token + allowFrom).
3. `systemctl enable --now <service>` as the run user. Now exactly one Jinn owns
   the port.
4. **Verify identity, not just liveness.** A 200 on the port is NOT proof it's
   *your* Jinn (v6's bug). Confirm the listener is owned by the seat's own unit
   (you've built this guardrail — keep it) and/or `GET /api/status` matches the
   instance you just configured. Fail loud on a foreign holder.

## Systemd unit contract

The fields Jinn relies on (see also [../restart-and-resume.md](../restart-and-resume.md)):

```ini
[Service]
Type=simple
User=<run-user>
WorkingDirectory=<repo path>
Environment=JINN_HOME=/home/<run-user>/jinn-home
Environment=JINN_REJOIN_CHANNEL=<connector channel id>   # optional; for on-box safe-restart.sh
ExecStart=/opt/node24/bin/node <repo>/packages/jinn/dist/bin/jinn.js start
Restart=always          # REQUIRED — POST /api/restart exits; supervisor relaunches
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
```

- `Restart=always` is non-negotiable: the assistant restarts itself via
  `POST /api/restart` (process exits → supervisor brings it back). Without it the
  instance stays down.
- Port/host come from `config.yaml` (`gateway.port` default 7777, `gateway.host`
  default 127.0.0.1). The gateway records the live port/pid in
  `$JINN_HOME/gateway.json` on boot — a cheap way to confirm which process owns it.

## Config is hot-reloaded — most changes need no restart

The gateway watches `config.yaml`: connector tokens, engine selection, adminKey,
authPassword all take effect on write (no restart). Only a code/dist change needs
a restart. So provisioning can PUT config via the API or write the file directly.

## Out of scope for this repo

The image-build script and the cloud-init live on the provisioning side — they are
**not** in the Jinn repo. This doc is the contract they must satisfy; the snapshot
build itself is owned by whoever builds v7.
