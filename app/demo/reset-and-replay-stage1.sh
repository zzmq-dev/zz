#!/usr/bin/env bash
# Deletes the demo's mathkit repo (if it exists) and replays Stage 1
# ("By hand", site/content/docs/demos/by-hand/index.md) exactly as
# written there, ending at that page's own checkpoint: `sum` merged,
# repo/file Ladder rungs written. Stage 2 onward is manual -- this
# just gets you back to a clean, known-good starting point fast.
#
# Usage: demo/reset-and-replay-stage1.sh [clone-dir]
#   clone-dir defaults to ./mathkit-replay (never reuses a path you
#   might have other work in).
set -euo pipefail

CLONE_DIR="${1:-./mathkit-replay}"
REPO="@me/mathkit"

echo "==> Deleting existing $REPO (if any)..."
zz repo delete "$REPO" --yes 2>&1 | grep -v "no such repo" || true

echo "==> Creating $REPO..."
zz repo create mathkit --description "Small, dependency-free math utilities"

echo "==> Posting the work Ask..."
zz ask post "$REPO" --remote --description "implement sum(...numbers)"

ASK_ID=$(zz ask list "$REPO" | grep -oE '\[ASK ask-[a-f0-9]+\] \(work\)' | grep -oE 'ask-[a-f0-9]+' | head -1)
if [ -z "$ASK_ID" ]; then
  echo "Couldn't find the work ask id -- check 'zz ask list $REPO' by hand." >&2
  exit 1
fi
echo "    ask id: $ASK_ID"

echo "==> Claiming it..."
CLAIM_OUT=$(zz ask claim "$REPO" "$ASK_ID")
echo "$CLAIM_OUT"
LANE_ID=$(echo "$CLAIM_OUT" | grep -oE 'opened Lane [a-zA-Z0-9_-]+' | awk '{print $3}')
if [ -z "$LANE_ID" ]; then
  echo "Couldn't find the lane id in claim output." >&2
  exit 1
fi
echo "    lane id: $LANE_ID"

echo "==> Cloning into $CLONE_DIR..."
rm -rf "$CLONE_DIR"
zz repo clone "$REPO" "$CLONE_DIR"

cat > "$CLONE_DIR/index.js" <<'JS'
export function sum(...numbers) {
  return numbers.reduce((total, n) => total + n, 0);
}
JS

(cd "$CLONE_DIR" && git add -A && git commit -q -m "Add sum")

echo "==> Submitting the changeset..."
SUBMIT_OUT=$(cd "$CLONE_DIR" && zz repo submit "$REPO" "$LANE_ID" "$ASK_ID" --message "Add sum")
echo "$SUBMIT_OUT"
REVIEW_ASK_ID=$(echo "$SUBMIT_OUT" | grep -oE 'changeset_review ask-[a-f0-9]+' | grep -oE 'ask-[a-f0-9]+')
if [ -z "$REVIEW_ASK_ID" ]; then
  echo "Couldn't find the changeset_review ask id -- check 'zz ask list $REPO' by hand." >&2
  exit 1
fi
echo "    changeset_review ask id: $REVIEW_ASK_ID"

echo "==> Approving the review..."
echo "a" | zz review "$REPO" --ask "$REVIEW_ASK_ID"

echo "==> Running a one-shot coordinator to merge it..."
COORD_LOG=$(mktemp)
zz work "$REPO" --scope coordinator --provider groq --stdio > "$COORD_LOG" 2>&1 &
COORD_PID=$!
for _ in $(seq 1 30); do
  if grep -q "complete" "$COORD_LOG" 2>/dev/null; then
    break
  fi
  sleep 2
done
kill "$COORD_PID" 2>/dev/null || true
wait "$COORD_PID" 2>/dev/null || true
cat "$COORD_LOG"
rm -f "$COORD_LOG"

echo "==> Writing Ladder rungs..."
zz ladder edit "$REPO" index.js --kind file --summary "Numeric utility functions."
zz ladder edit "$REPO" _repo --kind repo --summary "mathkit: small, dependency-free math utilities."

echo "==> Checkpoint:"
zz lane log "$REPO"

echo ""
echo "Done -- $REPO is at Stage 1's checkpoint. Clone is at $CLONE_DIR."
