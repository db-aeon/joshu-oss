#!/usr/bin/env bash
# Restart of the box in place, and the desktop password reset that runs in it, for
# single-container mode (change sandbox-box-commands). The start script sources this file.
#
# A box on a sandbox has no Docker,
# so the instance agent cannot recreate a container for restart, rotate_secrets, or
# set_aroz_password. It sends SIGUSR1 to process 1 instead. Process 1 stops every other process
# of the box, and starts this script again with the environment that the container started
# with, so the new start reads the instance config again. The data root stays.
JOSHU_RESTART_READY="${JOSHU_RESTART_READY:-/run/joshu-restart-ready}"
JOSHU_SECRETS_DIR="${JOSHU_SECRETS_DIR:-/etc/joshu/secrets}"

# The process ids under a process, on one line. Call it as "$(descendant_pids <pid>)": the
# function then runs in the subshell of the command substitution, and the walk leaves out that
# subshell and the processes under it (ps and awk), so a walk never lists itself. A zombie is
# not listed: it has ended, and only its parent can remove it.
descendant_pids() {
  local self="${BASHPID}"
  ps -eo pid=,ppid=,stat= | awk -v root="$1" -v self="${self}" '
    $3 !~ /^Z/ { kids[$2] = kids[$2] " " $1 }
    END {
      n = split(kids[root], queue, " ")
      head = 1
      while (head <= n) {
        p = queue[head++]
        if (p == self) continue
        printf "%s ", p
        m = split(kids[p], more, " ")
        for (i = 1; i <= m; i++) queue[++n] = more[i]
      }
    }'
}

restart_in_place() {
  # The agent removes the pending command when it gave up waiting, so a late signal does nothing.
  if [[ ! -f "${JOSHU_SECRETS_DIR}/pending-restart-command.json" ]]; then
    echo "[vps-start] restart in place: no pending command; ignored" >&2
    return 0
  fi
  trap - USR1
  rm -f "${JOSHU_RESTART_READY}"
  # The log process of this script stops below, so write to the output of the container.
  if [[ -e /proc/$$/fd/3 ]]; then
    exec 1>&3 2>&3
  fi
  echo "[vps-start] restart in place: stopping the processes of the box" >&2
  local pids
  pids="$(descendant_pids $$)"
  # shellcheck disable=SC2086
  [[ -n "${pids// /}" ]] && kill -TERM ${pids} 2>/dev/null || true
  # Postgres and Hermes need some seconds to stop. Postgres gets SIGTERM in each of its processes,
  # so its next start runs crash recovery, which is safe.
  for _ in $(seq 1 30); do
    pids="$(descendant_pids $$)"
    [[ -z "${pids// /}" ]] && break
    sleep 1
  done
  pids="$(descendant_pids $$)"
  # shellcheck disable=SC2086
  [[ -n "${pids// /}" ]] && kill -KILL ${pids} 2>/dev/null || true
  local -a boot_env=() boot_cmd=()
  # The environment and the command line that this process started with (process 1 in a sandbox).
  mapfile -d '' -t boot_env < "/proc/$$/environ"
  mapfile -d '' -t boot_cmd < "/proc/$$/cmdline"
  echo "[vps-start] restart in place: starting the box again" >&2
  exec env -i "${boot_env[@]}" "${boot_cmd[@]}"
}


# Single-container mode: a desktop password reset of the control plane (set_aroz_password)
# leaves the user and the new password hash in a pending file before the restart in place.
# The helper writes them into the ArozOS database here, before ArozOS starts, because ArozOS
# holds the database while it runs. The helper also rotates the session key, so the old
# desktop sessions end. The instance agent reads the result after the start.
apply_pending_aroz_password() {
  local pending="${JOSHU_SECRETS_DIR}/pending-aroz-password.json"
  local result="${JOSHU_SECRETS_DIR}/aroz-password-result.json"
  local helper="${JOSHU_AROZ_RESET_PASSWORD_BIN:-/opt/joshu-tools/arozos-reset-password}"
  [[ -f "${pending}" ]] || return 0
  local user hash error=""
  user="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("user",""))' "${pending}" 2>/dev/null || true)"
  hash="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("hash",""))' "${pending}" 2>/dev/null || true)"
  rm -f "${pending}"
  if [[ -z "${user}" || -z "${hash}" ]]; then
    error="the pending password file has no user or no hash"
  elif [[ ! -x "${helper}" ]]; then
    error="the password helper ${helper} is missing"
  elif ! error="$(AO_PW_HASH="${hash}" "${helper}" -db "${AROZ_DATA}/system/ao.db" -user "${user}" 2>&1 >/dev/null)"; then
    error="${error:-the password helper failed}"
  else
    error=""
  fi
  # A failed write of the result must not stop process 1; the agent then reports no result.
  python3 -c 'import json,os,sys; fd=os.open(sys.argv[1], os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600); os.write(fd, json.dumps({"ok": not sys.argv[2], "error": sys.argv[2][-300:]}).encode()); os.close(fd)' "${result}" "${error}" || true
  if [[ -n "${error}" ]]; then
    echo "[vps-start] WARN: desktop password reset failed: ${error}" >&2
  else
    echo "[vps-start] desktop password reset for ${user}" >&2
  fi
}
