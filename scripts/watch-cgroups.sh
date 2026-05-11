#!/bin/bash
# Sample any libpod-*.scope cgroups under the dev-agent user slice every 0.2s,
# logging pids and subtree_control. Run this in one tmux pane on the HOST as
# the dev-agent user while reproducing the crun ENOSPC failure in another.
#
# When the failure logs in the journal, correlate the timestamp here to see
# which (if any) cgroup counter spiked.

set -u

UID_TO_WATCH="${UID_TO_WATCH:-$(id -u)}"
ROOT="/sys/fs/cgroup/user.slice/user-${UID_TO_WATCH}.slice"
OUT="${OUT:-/tmp/cgroup-watch.log}"

echo "watching $ROOT (uid=$UID_TO_WATCH) → $OUT"
echo "ctrl-c to stop"

: > "$OUT"

while :; do
  ts=$(date +%H:%M:%S.%N | cut -c1-12)
  # Find every libpod scope cgroup under the user slice.
  find "$ROOT" -maxdepth 6 -name 'libpod-*.scope' 2>/dev/null | \
    while read -r d; do
      pids_cur=$(cat "$d/pids.current" 2>/dev/null)
      pids_max=$(cat "$d/pids.max" 2>/dev/null)
      subtree=$(cat "$d/cgroup.subtree_control" 2>/dev/null)
      mem_cur=$(cat "$d/memory.current" 2>/dev/null)
      mem_max=$(cat "$d/memory.max" 2>/dev/null)
      printf '%s %s pids=%s/%s mem=%s/%s subtree=[%s]\n' \
        "$ts" "$d" "$pids_cur" "$pids_max" "$mem_cur" "$mem_max" "$subtree"
    done >> "$OUT"
  sleep 0.2
done
