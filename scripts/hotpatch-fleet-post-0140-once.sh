#!/usr/bin/env bash
# One-shot laptop→box overlay: EA owner-reply, EA no-autodecompose board set,
# voice Langfuse User said: backfill, jChat SSE + Caddy flush.
# Surgical dist overlay (no rsync --delete). Does not git pull.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:?usage: hotpatch-fleet-post-0140-once.sh <slug>}"
TARGET="root@${SLUG}.box.joshu.me"

echo "========== ${SLUG} rsync =========="
ssh -n -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" 'true'

rsync -az \
  "$ROOT/dist/ea/ownerReplyCron.js" \
  "$ROOT/dist/ea/ownerReplyEligibility.js" \
  "$ROOT/dist/ea/ownerReplyTypes.js" \
  "$ROOT/dist/ea/triageRoutes.js" \
  "$ROOT/dist/ea/mailCron.js" \
  "$ROOT/dist/ea/mailDedup.js" \
  "$ROOT/dist/ea/ingest.js" \
  "$ROOT/dist/ea/agentAuthorization.js" \
  "$TARGET:/opt/joshu/dist/ea/"
rsync -az \
  "$ROOT/dist/hermesKanbanBridge.js" \
  "$ROOT/dist/hermesApi.js" \
  "$ROOT/dist/hermesMessagingSessionReset.js" \
  "$ROOT/dist/composioApi.js" \
  "$ROOT/dist/server.js" \
  "$ROOT/dist/agUiApi.js" \
  "$ROOT/dist/httpSse.js" \
  "$TARGET:/opt/joshu/dist/"
rsync -az \
  "$ROOT/scripts/joshu-connectors-mcp-http-server.mjs" \
  "$ROOT/scripts/hermes-kanban-bridge.py" \
  "$ROOT/scripts/patch-hermes-ea-kanban-no-autodecompose.py" \
  "$ROOT/scripts/apply-hermes-ea-kanban-no-autodecompose.sh" \
  "$TARGET:/opt/joshu/scripts/"
rsync -az "$ROOT/deploy/scripts/render-caddyfile.sh" "$TARGET:/opt/joshu/deploy/scripts/render-caddyfile.sh"
rsync -az "$ROOT/deploy/Caddyfile.template" "$TARGET:/opt/joshu/deploy/Caddyfile.template"
rsync -az "$ROOT/integrations/hermes/skills-enabled.yaml" \
  "$TARGET:/opt/joshu/integrations/hermes/skills-enabled.yaml"
rsync -az "$ROOT/integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md" \
  "$TARGET:/opt/joshu/integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md"
rsync -az "$ROOT/integrations/hermes/skills/executive-assistant/ea-owner-reply/" \
  "$TARGET:/opt/joshu/integrations/hermes/skills/executive-assistant/ea-owner-reply/"
rsync -az "$ROOT/packages/voice-realtime/dist/" "$TARGET:/tmp/vr-dist-post0140/"
rsync -az "$ROOT/dist/hermes-chat/" "$TARGET:/tmp/hermes-chat-post0140/"

echo "========== ${SLUG} apply =========="
# Do not use ssh -n here: bash -s must receive the heredoc on stdin.
ssh -o BatchMode=yes "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/joshu/deploy
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate joshu-stack
docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env up -d --force-recreate caddy

CID=""
for i in $(seq 1 45); do
  CID="$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q joshu-stack | head -1)"
  if [[ -n "${CID}" ]] && docker exec "${CID}" true 2>/dev/null; then
    break
  fi
  sleep 2
done
[[ -n "${CID}" ]] || { echo "no joshu-stack"; exit 1; }

docker exec "$CID" mkdir -p /root/.hermes/skills/joshu/executive-assistant/ea-owner-reply
docker cp /opt/joshu/integrations/hermes/skills/executive-assistant/ea-owner-reply/SKILL.md \
  "$CID":/root/.hermes/skills/joshu/executive-assistant/ea-owner-reply/SKILL.md
docker cp /opt/joshu/integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md \
  "$CID":/root/.hermes/skills/joshu/executive-assistant/ea-playbook/SKILL.md

# Inject ea-owner-reply into already-applied no-autodecompose sets
docker exec "$CID" python3 - <<'PY'
from pathlib import Path
files = [
    Path("/opt/hermes-agent/gateway/kanban_watchers.py"),
    Path("/opt/hermes-agent/hermes_cli/kanban_db.py"),
]
for p in files:
    if not p.is_file():
        print(f"missing {p}")
        continue
    text = p.read_text()
    if "ea-owner-reply" in text:
        print(f"{p.name}: already has ea-owner-reply")
        continue
    old = '"ea-sched-ingress"}'
    new = '"ea-sched-ingress", "ea-owner-reply"}'
    if old not in text:
        print(f"{p.name}: PATTERN_MISSING")
        continue
    p.write_text(text.replace(old, new, 1))
    print(f"{p.name}: added ea-owner-reply")
PY

# If patch never applied, try apply script
docker exec "$CID" bash -lc 'HERMES_DIR=/opt/hermes-agent bash /opt/joshu/scripts/apply-hermes-ea-kanban-no-autodecompose.sh' || true

# jChat UI into ArozOS volumes
docker exec "$CID" mkdir -p /var/lib/arozos/subservice/hermes-chat/app /opt/arozos-template/subservice/hermes-chat/app
if [[ -d /tmp/hermes-chat-post0140 ]]; then
  docker cp /tmp/hermes-chat-post0140/. "$CID":/var/lib/arozos/subservice/hermes-chat/app/
  docker cp /tmp/hermes-chat-post0140/. "$CID":/opt/arozos-template/subservice/hermes-chat/app/
fi

# Voice Langfuse backfill overlay
VCID="$(docker compose -f docker-compose.yml --env-file /etc/joshu/instance.env ps -q voice-realtime | head -1 || true)"
if [[ -n "${VCID}" ]] && [[ -d /tmp/vr-dist-post0140 ]]; then
  docker cp /tmp/vr-dist-post0140/. "${VCID}:/app/dist/"
  docker restart "${VCID}" >/dev/null
  echo "voice-realtime overlaid"
else
  echo "voice-realtime skip (no container)"
fi
rm -rf /tmp/vr-dist-post0140 /tmp/hermes-chat-post0140

# Caddyfile should include flush after recreate
if grep -q 'flush_interval -1' /etc/caddy/Caddyfile 2>/dev/null; then
  echo "caddy flush_interval ok"
else
  echo "caddy flush_interval MISSING (check /etc/caddy/Caddyfile)"
fi

ok=0
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8788/joshu/api/ea/owner-reply/tasks >/tmp/or.json 2>/dev/null; then
    ok=1
    break
  fi
  sleep 3
done
if [[ "$ok" != 1 ]]; then
  echo "owner-reply API never came up"
  exit 1
fi
python3 -c "import json; d=json.load(open('/tmp/or.json')); print('owner-reply', d.get('ok'), 'board', d.get('board'), 'count', d.get('count'))"
curl -fsS http://127.0.0.1:8795/health >/dev/null && echo "connectors-mcp ok"
docker exec "$CID" grep -m1 'version:' /root/.hermes/skills/joshu/executive-assistant/ea-playbook/SKILL.md
docker exec "$CID" test -f /root/.hermes/skills/joshu/executive-assistant/ea-owner-reply/SKILL.md && echo ea-owner-reply-skill-ok
# Stop gateway so next Joshu nudge reloads skills/MCP (best-effort)
pid=$(docker exec "$CID" python3 -c "import json,pathlib; p=pathlib.Path('/root/.hermes/gateway.pid');
pid=str(json.loads(p.read_text()).get('pid','')) if p.is_file() else ''
c=pathlib.Path('/proc/'+pid+'/cmdline')
print(pid if pid and c.is_file() and b'gateway run' in c.read_bytes() else '')" 2>/dev/null || true)
if [[ -n "${pid}" ]]; then
  docker exec "$CID" kill "$pid" 2>/dev/null || true
fi
sleep 2
curl -fsS --max-time 120 "http://127.0.0.1:8788/joshu/api/hermes-chat/status?after_mcp_boot=1" >/dev/null || true
docker exec "$CID" python3 - <<'PY'
import json, pathlib, yaml
gj = pathlib.Path("/root/.hermes/gateway.json")
cy = pathlib.Path("/root/.hermes/config.yaml")
ok = False
if gj.is_file():
    data = json.loads(gj.read_text())
    slack = (data.get("reset_by_platform") or {}).get("slack") or {}
    print("gateway.json slack", slack)
    ok = slack.get("mode") == "idle" and slack.get("idle_minutes") == 30
if cy.is_file():
    cfg = yaml.safe_load(cy.read_text()) or {}
    slack = (cfg.get("reset_by_platform") or {}).get("slack") or {}
    print("config.yaml slack", slack)
    ok = ok or (slack.get("mode") == "idle" and slack.get("idle_minutes") == 30)
print("slack-idle-30-ok" if ok else "slack-idle-30-MISSING")
PY
echo HOTPATCH_OK
REMOTE
echo "========== ${SLUG} done =========="
