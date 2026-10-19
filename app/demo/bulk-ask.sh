#!/bin/bash
# Stage 6 ("bulk ASK posting"): a shell loop driving the real `zz`
# CLI, one `zz ask post` call per task -- deliberately not a dedicated
# bulk-post command. `zz ask post` already does the one-ask case
# correctly, and for a demo narrating "I'm posting a batch of tasks,"
# a sequence of visible, real commands reads better than one opaque
# bulk call hiding what's actually happening.
#
# Usage: demo/bulk-ask.sh <owner/repo> <tasks-file>
#   <tasks-file>: one task description per line. Blank lines and lines
#   starting with # are skipped. See demo/mathkit-tasks.txt for an
#   example/starting point -- edit it (or point at your own file) with
#   the real task list before recording.
set -euo pipefail

repo="${1:?usage: demo/bulk-ask.sh <owner/repo> <tasks-file>}"
tasks_file="${2:?usage: demo/bulk-ask.sh <owner/repo> <tasks-file>}"

if [ ! -f "$tasks_file" ]; then
  echo "no such file: $tasks_file" >&2
  exit 1
fi

count=0
while IFS= read -r line || [ -n "$line" ]; do
  # trim leading/trailing whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  [ "${line:0:1}" = "#" ] && continue

  echo "-> $line"
  zz ask post "$repo" --remote --description "$line"
  count=$((count + 1))
done < "$tasks_file"

echo "Posted $count ask(s) to $repo's origin Lane."
