#!/usr/bin/env bash
# safe-restart.sh — restart the jinn gateway and have it announce when it's back
# (and optionally RESUME the session that triggered the restart).
#
# Restarting kills the session that issued the restart, so the operator would
# otherwise have to message first to discover it's back. Before restarting we
# drop a marker file; on the next startup the gateway reads it and, once the
# connector is up, sends a "back online" notice DIRECTLY through the connector —
# and, when a sessionId is given, resumes that session so the assistant picks up
# any unfinished work on its own. See docs/restart-and-resume.md.
#
# Usage:  tools/safe-restart.sh "<context>" [sessionId] [resumePrompt]
#
# Requires:
#   - JINN_REJOIN_CHANNEL  env: the connector channel id for the rejoin notice.
#   - JINN_SERVICE         env (optional): systemd unit name. Default: jinn.service
#   - a sudoers NOPASSWD rule for `systemctl restart <service>`.

set -euo pipefail

CTX="${1:-Code updated}"
SESSION_ID="${2:-}"
RESUME_PROMPT="${3:-}"
JINN_HOME="${JINN_HOME:-$HOME/.jinn}"
SERVICE="${JINN_SERVICE:-jinn.service}"
CHANNEL="${JINN_REJOIN_CHANNEL:-}"
MARKER="$JINN_HOME/tmp/rejoin.json"

if [ -z "$CHANNEL" ]; then
  echo "error: set JINN_REJOIN_CHANNEL to the connector channel id for the rejoin notice" >&2
  exit 1
fi

mkdir -p "$JINN_HOME/tmp"
python3 - "$MARKER" "$CHANNEL" "$CTX" "$SESSION_ID" "$RESUME_PROMPT" <<'PY'
import json, sys
marker, channel, ctx, session_id, resume_prompt = sys.argv[1:6]
notice = {
    "connector": "discord",
    "channel": channel,
    "text": f"✅ Back online after restart — {ctx}",
}
if session_id:
    notice["sessionId"] = session_id
    if resume_prompt:
        notice["resumePrompt"] = resume_prompt
with open(marker, "w") as f:
    json.dump(notice, f, ensure_ascii=False)
print("rejoin marker written" + (f" (resume {session_id})" if session_id else ""))
PY

echo "restarting gateway — it will announce when it's back…"
sudo /bin/systemctl restart "$SERVICE"
