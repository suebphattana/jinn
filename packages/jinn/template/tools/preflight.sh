#!/usr/bin/env bash
# preflight.sh — self-heal critical on-disk state BEFORE the gateway starts.
#
# Why: the systemd unit uses Restart=always, which recovers a process that
# crashes on its own (deps still on disk). It CANNOT recover when the install is
# damaged — e.g. node_modules/ was wiped by a half-finished deploy → the gateway
# crashes at the same spot every 5s ("Cannot find module 'commander'") forever.
#
# Wire this as `ExecStartPre=` so every (auto-)restart first repairs a damaged
# install. On a healthy box it's a fast no-op; on a damaged one it reinstalls /
# rebuilds / restores config, so the Restart=always loop heals itself instead of
# crash-looping until a human intervenes.
#
# IMPORTANT: this script always exits 0 — a non-zero ExecStartPre would BLOCK the
# service from starting. We repair best-effort, then let the gateway start; if
# it's still broken, the restart loop runs preflight again.
#
# Env (all optional; defaults match the standard layout):
#   JINN_REPO   repo root           (default /home/suebphatt/repos/jinn)
#   JINN_HOME   instance home dir    (default /home/suebphatt/jinn-home)

set -uo pipefail

REPO="${JINN_REPO:-/home/suebphatt/repos/jinn}"
JINN_HOME="${JINN_HOME:-/home/suebphatt/jinn-home}"
PKG="$REPO/packages/jinn"

log() { echo "[preflight] $*"; }

if ! cd "$REPO" 2>/dev/null; then
  log "repo $REPO not found — cannot self-heal (nothing to do)"
  exit 0
fi

# 1) Dependencies — node_modules wiped / incomplete is the classic crash-loop.
if [ ! -d "$REPO/node_modules" ] || ! node -e "require('commander')" >/dev/null 2>&1; then
  log "dependencies missing/incomplete — running pnpm install"
  pnpm install --frozen-lockfile || pnpm install || log "pnpm install failed (will retry next restart)"
fi

# 2) Build output — dist must exist for the gateway to boot.
if [ ! -f "$PKG/dist/bin/jinn.js" ]; then
  log "dist missing — running pnpm build"
  pnpm build || log "pnpm build failed (will retry next restart)"
fi

# 3) config.yaml — snapshot a good one, restore a corrupt/missing one.
CFG="$JINN_HOME/config.yaml"
BAK="$JINN_HOME/config.yaml.bak"
if [ -f "$CFG" ] && python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$CFG" >/dev/null 2>&1; then
  cp -f "$CFG" "$BAK" 2>/dev/null || true        # healthy → keep a known-good copy
elif [ -f "$BAK" ]; then
  log "config.yaml missing/corrupt — restoring from last-known-good backup"
  cp -f "$BAK" "$CFG" 2>/dev/null || true
fi

log "preflight done"
exit 0
