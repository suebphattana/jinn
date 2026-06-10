#!/usr/bin/env bash
# Talk Mission Control smoke: boots an ISOLATED gateway (throwaway JINN_HOME,
# non-7777 port), builds a 2-level delegation tree via the talk APIs, and
# asserts the graph snapshot + delegate validation behave. Engine turns may
# error in the throwaway home — irrelevant; this tests session/graph plumbing.
set -euo pipefail

PORT="${PORT:-7878}"
HOME_DIR="$(mktemp -d /tmp/jinn-mc-smoke.XXXXXX)"
DIST="$(cd "$(dirname "$0")/.." && pwd)/dist/bin/jinn.js"
BASE="http://127.0.0.1:${PORT}"

# Minimal config — loadConfig() requires the file to exist; the port can only
# come from here (no env override).
cat > "${HOME_DIR}/config.yaml" <<EOF
gateway:
  port: ${PORT}
  host: 127.0.0.1
engines:
  default: claude
  claude:
    bin: claude
    model: haiku
  codex:
    bin: codex
    model: gpt-5.5
connectors: {}
logging:
  level: info
EOF

echo "JINN_HOME=${HOME_DIR} port=${PORT}"
JINN_HOME="${HOME_DIR}" node "${DIST}" start &
GW_PID=$!
trap 'kill ${GW_PID} 2>/dev/null || true; sleep 1; rm -rf "${HOME_DIR}"' EXIT

for i in $(seq 1 40); do
  curl -fsS "${BASE}/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "${BASE}/api/status" >/dev/null

TALK=$(curl -fsS -X POST "${BASE}/api/talk/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
echo "talk session: ${TALK}"

D1=$(curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread A\",\"brief\":\"Reply with the single word ok.\"}")
COO1=$(echo "${D1}" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["created"] is True;print(d["threadId"])')
echo "coo1: ${COO1}"

curl -fsS -X POST "${BASE}/api/talk/delegate" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"new\",\"label\":\"Thread B\",\"brief\":\"Reply with the single word ok.\"}" >/dev/null

# grandchild under COO1 (what a COO delegating to an employee does)
curl -fsS -X POST "${BASE}/api/sessions" -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Reply ok.\",\"parentSessionId\":\"${COO1}\"}" >/dev/null

GRAPH=$(curl -fsS "${BASE}/api/talk/graph?root=${TALK}")
echo "${GRAPH}" | python3 -c '
import sys, json
g = json.load(sys.stdin)
nodes = g["nodes"]
assert len(nodes) == 3, f"expected 3 nodes, got {len(nodes)}: {nodes}"
depths = sorted(n["depth"] for n in nodes)
assert depths == [1, 1, 2], f"bad depths: {depths}"
labels = {n["label"] for n in nodes if n["depth"] == 1}
assert labels == {"Thread A", "Thread B"}, f"bad labels: {labels}"
print("graph snapshot OK:", [(n["label"], n["depth"], n["status"]) for n in nodes])
'

# bad thread id -> 400 with roster
CODE=$(curl -s -o /tmp/delegate-err.json -w '%{http_code}' -X POST "${BASE}/api/talk/delegate" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"${TALK}\",\"thread\":\"bogus\",\"brief\":\"x\"}")
test "${CODE}" = "400"
python3 -c 'import json;d=json.load(open("/tmp/delegate-err.json"));assert d.get("threads"),d;print("delegate roster error OK:",[t["label"] for t in d["threads"]])'

# graph root validation: non-talk root -> 400
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/talk/graph?root=${COO1}")
test "${CODE}" = "400"
echo "graph root validation OK"

echo "SMOKE PASSED"
