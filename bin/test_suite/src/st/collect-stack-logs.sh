#!/usr/bin/env bash
# Save container state and logs of the local development stack for CI artifacts.
set -uo pipefail
root=$(git rev-parse --show-toplevel)
out="$root/.reports/st-e2e/containers"
mkdir -p "$out"
project=${SLK_PODMAN_PROJECT:-slk-podman-development}
podman ps --all --filter "label=io.podman.compose.project=$project" \
  --format '{{.Names}} {{.Status}} {{.Image}}' > "$out/ps.txt" 2>&1
for name in $(podman ps --all --filter "label=io.podman.compose.project=$project" --format '{{.Names}}'); do
  podman logs --timestamps "$name" > "$out/$name.log" 2>&1 || true
done
cat "$out/ps.txt"
