#!/usr/bin/env bash
# Run one CI step with a complete log under .reports/st-e2e/.
# On failure the log tail is emitted as GitHub error annotations right away (each
# step has its own annotation budget) and the log is kept in failed/. A killed step
# (timeout/cancellation) leaves its log linked from pending/ for the job's final
# annotation step.
# Usage: bin/test_suite/src/st/ci-step.sh <name> <command> [args...]
set -uo pipefail
name=$1
shift
root=$(git rev-parse --show-toplevel)
reports="$root/.reports/st-e2e"
mkdir -p "$reports/failed" "$reports/pending"
log="$reports/$name.log"
ln -sfn "../$name.log" "$reports/pending/$name.log"
started=$(date +%s)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
echo "[$name] exit $status after $(($(date +%s) - started))s" | tee -a "$log"
rm -f "$reports/pending/$name.log"
# Explicitly registered known application failures (st/knownFailures.ts) turn a
# matching failure into a warning; a registered failure that no longer occurs fails.
node "$root/bin/test_suite/src/st/knownFailures.ts" step "$name" "$log" "$status"
status=$?
if [ "$status" -ne 0 ]; then
  cp "$log" "$reports/failed/$name.log"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    node "$root/bin/test_suite/src/st/annotateFailure.ts" "$name" "$log" || true
  fi
fi
exit "$status"
