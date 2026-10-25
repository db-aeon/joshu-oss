#!/usr/bin/env bash
# Helpers for the PID files of the services that the box scripts start.
#
# A PID file can be older than the process that it names. For example, /root/.gbrain is a
# persistent volume, so a PID file there stays after a restart of the stack container, and the
# same PID can then belong to a different process (on 2026-10-10 it was hindsight-api).
# Before a box script stops the process of a PID file, the script checks the command line of the
# process. When the command line does not match, the script removes only the PID file.
#
# Usage: source "<scripts dir>/lib/pid-file.sh"

# Print the command line of process <pid>, with a space between the arguments.
# Prints nothing when the process does not exist.
pid_command_line() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  if [[ -r "/proc/${pid}/cmdline" ]]; then
    tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true
  else
    # macOS (local development) has no /proc.
    ps -ww -p "${pid}" -o command= 2>/dev/null || true
  fi
}

# Return 0 when process <pid> runs and its command line contains <pattern>.
# <pattern> is a shell glob, for example "gbrain-mcp-http-server.mjs" or "hermes*gateway run".
pid_runs_command() {
  local pid="$1" pattern="$2" cmdline
  [[ "${pid}" =~ ^[0-9]+$ && -n "${pattern}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  cmdline="$(pid_command_line "${pid}")"
  # shellcheck disable=SC2053 # <pattern> is a glob on purpose.
  [[ -n "${cmdline}" && "${cmdline}" == *${pattern}* ]]
}

# Stop the process that <pid_file> names, and remove <pid_file>.
#   <pid_file>  A file whose first line is a PID.
#   <pattern>   The expected command line (see pid_runs_command).
#   <prefix>    The log prefix, for example "[gbrain]".
#   <grace>     Seconds to wait after SIGTERM before SIGKILL. Default: 0.5.
# The function sends a signal only when the command line of the process matches <pattern>.
# Otherwise it logs the PID and the command line, and removes only <pid_file>.
stop_pid_file_process() {
  local pid_file="$1" pattern="$2" prefix="$3" grace="${4:-0.5}"
  [[ -f "${pid_file}" ]] || return 0
  local pid=""
  read -r pid <"${pid_file}" 2>/dev/null || true
  pid="${pid//[[:space:]]/}"
  if pid_runs_command "${pid}" "${pattern}"; then
    echo "${prefix} stopping ${pattern} (pid ${pid}, PID file ${pid_file})"
    kill "${pid}" 2>/dev/null || true
    local tenths
    tenths="$(awk -v s="${grace}" 'BEGIN { printf "%d", s * 10 }')"
    while ((tenths > 0)) && kill -0 "${pid}" 2>/dev/null; do
      sleep 0.1
      tenths=$((tenths - 1))
    done
    if pid_runs_command "${pid}" "${pattern}"; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  elif [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
    echo "${prefix} PID file ${pid_file} names pid ${pid}, which does not run ${pattern} (command: $(pid_command_line "${pid}" | cut -c1-160)); removing only the PID file" >&2
  fi
  rm -f "${pid_file}"
}
