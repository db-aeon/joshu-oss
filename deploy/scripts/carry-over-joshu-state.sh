#!/bin/sh
# Copy the Joshu state of a running stack container from its writable layer into the
# Joshu state folder in volume joshu_arozos (change joshu-state-volume). Run it in the
# OLD stack container, before a recreate:
#
#   docker exec -i deploy-joshu-stack-1 sh -s < /opt/joshu/deploy/scripts/carry-over-joshu-state.sh
#
# The instance agent (packages/instance-agent/src/stateCarryOver.ts) and
# scripts/lib/upgrade-box-remote.sh run it before each recreate of joshu-stack.
#
# Releases before the change kept this state in /opt/joshu/.joshu, which a recreate
# throws away. The script copies each entry that the Joshu state folder does not have
# yet (or has only as an empty folder). It never overwrites state that is already in
# the volume, so it is safe on every recreate. POSIX sh: the old image runs it.
# Keep the list the same as JOSHU_STATE_ENTRIES in src/joshuStateDir.ts (a test checks it).
# JOSHU_CARRY_SRC and JOSHU_CARRY_DST exist for the tests. One output line per entry.
set -u
src="${JOSHU_CARRY_SRC:-/opt/joshu/.joshu}"
dst="${JOSHU_CARRY_DST:-/var/lib/arozos/joshu-state}"
[ -d "$src" ] || { echo "no $src"; exit 0; }
for name in teams proactive browser-handoff sms connectors-providers.env; do
  [ -e "$src/$name" ] || continue
  if [ -d "$dst/$name" ] && [ -z "$(ls -A "$dst/$name" 2>/dev/null)" ]; then
    rmdir "$dst/$name"
  fi
  if [ -e "$dst/$name" ]; then
    echo "kept $name"
    continue
  fi
  if ! { mkdir -p "$dst" && chmod 700 "$dst"; }; then
    echo "failed $name"
    continue
  fi
  tmp="$dst/.$name.carry-$$"
  rm -rf "$tmp"
  if cp -a "$src/$name" "$tmp" && mv "$tmp" "$dst/$name"; then
    echo "copied $name"
  else
    rm -rf "$tmp"
    echo "failed $name"
  fi
done
