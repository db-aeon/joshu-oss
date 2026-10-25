#!/bin/sh
# Xvfb, then the Chromium supervisor (CDP :9222, health :9377).
set -eu

# Chromium is headed. Xvfb is :99; export it for the supervisor.
export DISPLAY="${DISPLAY:-:99}"

# Room for a portrait phone viewport and a wide jWeb pane. The screencast
# itself stays near 1024×768 pixels; this is only the X screen.
RES="${VNC_RESOLUTION:-1600x1600}"

# Hotpatch restarts only supervisor.mjs — skip a second Xvfb if one is already up.
if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  Xvfb :99 -screen 0 "${RES}x24" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fi
# Chromium exits immediately if it starts before the X socket exists.
i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "[browser] Xvfb :99 did not come up" >&2
    break
  fi
  sleep 0.1
done

# Live view is CDP screencast. Xvfb only gives Chromium a screen to draw on.

# Fleet boxes already have CONTROL_PLANE_URL. The relay path is stable across
# container restarts that do not reload instance.env.
if [ -z "${BROWSER_USE_LLM_URL:-}" ] && [ -n "${CONTROL_PLANE_URL:-}" ]; then
  export BROWSER_USE_LLM_URL="${CONTROL_PLANE_URL%/}/api/instances/browser-use"
fi

# Packages were installed with the 3.12 venv. `python` in that venv can be a
# later 3.13 symlink, which then cannot import browser-use.
if [ -x /opt/browser/venv/bin/python3.12 ]; then
  /opt/browser/venv/bin/python3.12 /opt/browser/agent-service.py >/tmp/browser-agent.log 2>&1 &
elif [ -x /opt/browser/venv/bin/python ]; then
  /opt/browser/venv/bin/python /opt/browser/agent-service.py >/tmp/browser-agent.log 2>&1 &
elif command -v python3 >/dev/null 2>&1; then
  python3 /opt/browser/agent-service.py >/tmp/browser-agent.log 2>&1 &
fi

exec node /opt/browser/supervisor.mjs
