# Jinn Golden Image — Provisioning Guide

For the team that builds the DigitalOcean droplet golden image. Everything here
is baked into the image so every customer instance boots the same. Per-customer
secrets (tokens, persona) are set later via the web UI / admin API, not baked.

Repo: `https://github.com/suebphattana/jinn` · branch `main`.

---

## 1. Build

```bash
git clone https://github.com/suebphattana/jinn /home/<user>/repos/jinn   # or pull
cd /home/<user>/repos/jinn
pnpm install
pnpm build        # builds gateway + web → packages/jinn/dist (incl. dist/web)
```

## 2. systemd unit (the important part)

```ini
[Unit]
Description=Jinn gateway
After=network-online.target

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/repos/jinn

# Self-heal a damaged install before every (re)start — see §3.
ExecStartPre=/home/<user>/repos/jinn/packages/jinn/template/tools/preflight.sh
ExecStart=/opt/node24/bin/node /home/<user>/repos/jinn/packages/jinn/dist/bin/jinn.js start

# REQUIRED — without these, Claude's Stop/SessionStart hooks don't fire on
# Claude Code 2.1.18x and every turn HANGS. (Gateway runs claude in --print mode.)
Environment=JINN_CLAUDE_PRINT_MODE=1
Environment=JINN_DISABLE_SSE_PROXY=1

# Auto-restart (transient crashes) — preflight (§3) handles the non-transient ones.
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

After editing the unit: `systemctl daemon-reload && systemctl restart jinn-pipe.service`.

> ⚠️ If `JINN_CLAUDE_PRINT_MODE=1` / `JINN_DISABLE_SSE_PROXY=1` are missing, the bot
> "connects but never replies". This is the #1 provisioning pitfall.

## 3. Self-heal: `ExecStartPre` preflight  ⭐ new

`Restart=always` only recovers a process that crashed on its own (deps still on
disk). It CANNOT recover a damaged install — e.g. `node_modules/` wiped by a
half-finished deploy → the gateway crash-loops forever ("Cannot find module
'commander'").

`packages/jinn/template/tools/preflight.sh` (committed) fixes this. Wired as
`ExecStartPre`, it runs before every start and, best-effort:
1. reinstalls deps (`pnpm install`) if `node_modules` / a core dep is missing,
2. rebuilds (`pnpm build`) if `dist/bin/jinn.js` is missing,
3. snapshots a healthy `config.yaml` to `config.yaml.bak`, and restores it if the
   live one goes missing/corrupt.

It always exits 0 (a non-zero ExecStartPre would block start) and is a fast
no-op when healthy. Combined with `Restart=always`, a damaged instance now heals
itself within one restart cycle instead of needing a human.

Make it executable in the image: `chmod +x packages/jinn/template/tools/*.sh`.
Override paths via env if your layout differs: `JINN_REPO`, `JINN_HOME`.

## 4. Remote password reset / web login

Set a master admin key in `config.yaml` at provisioning so the operator's
external app can remotely set/reset each instance's web-UI password:

```yaml
gateway:
  adminKey: "<strong-per-fleet-or-per-instance-secret>"
```

Full caller API + flow: **docs/remote-admin-api.md**. (Login is opt-in: no
`authPassword` set ⇒ web UI is open until the operator sets one via the admin API.)

## 5. Optional — voice (Whisper STT)

Only if voice transcription is wanted:
- install `ffmpeg`
- build whisper.cpp (static) → `$JINN_HOME/bin/whisper-cli`
- download a model → `$JINN_HOME/models/whisper/ggml-small.bin`
- enable in `config.yaml`: `stt: { enabled: true, model: small, languages: [...] }`

The gateway auto-finds `$JINN_HOME/bin/whisper-cli` (or set `JINN_WHISPER_CLI`).

## 6. Per-instance setup (NOT baked into the image)

Done by the operator after a droplet is up, via the web UI / config:
- Connector tokens + allowFrom (Discord/Telegram) — addable from Settings → Connectors.
- Persona / Portal Name / Operating instructions — Settings → Branding.
- Engine subscription login (ChatGPT / Claude) — Settings → Engine Configuration.
- Discord bots must be invited with the **`applications.commands`** scope for the
  slash-command picker to appear.
