#!/usr/bin/env bash
# Build the frontend for production and serve the output on the CI host against the
# running development CMS, so the public checks also cover production SSR, bundling and
# the nonce CSP. The build loads no private configuration (like the image builder);
# runtime settings come from the stack's private frontend env file at start, as with
# slk-env. Redis runs as a disposable container because the stack does not publish its
# own; the search index is not published either, so search requests degrade.
# Usage: bin/test_suite/src/st/productionFrontend.sh <port>
set -euo pipefail
port=${1:-3100}
root=$(git rev-parse --show-toplevel)
reports="$root/.reports/st-e2e"
mkdir -p "$reports"
cd "$root/src/frontend"
npx nuxt build --dotenv /dev/null
podman run -d --rm --name ci-production-redis -p 127.0.0.1:6390:6379 \
  docker.io/library/redis:8.10.3-alpine > /dev/null
# Explicit process variables take precedence over --env-file values.
NODE_ENV=production APP_ENV=production SLK_DEPLOYMENT_TARGET=staging \
  HOST=127.0.0.1 PORT="$port" PUBLIC_URL="http://localhost:$port" \
  SERVER_DIRECTUS_URL=http://127.0.0.1:8081 \
  STADTLANDZAHL_SERVER_BASE_URL=http://127.0.0.1:18090 \
  MEILISEARCH_URL=http://127.0.0.1:9 REDIS_URL=redis://127.0.0.1:6390 \
  nohup node --env-file=.env --env-file="$root/podman/meilisearch/.env" \
  scripts/runtimeEnvironment.mts node .output/server/index.mjs > "$reports/production-frontend.log" 2>&1 &
for _ in $(seq 1 90); do
  if curl --fail --silent --output /dev/null "http://127.0.0.1:$port/api/public/site-layout" &&
    curl --fail --silent --output /dev/null "http://127.0.0.1:$port/"; then
    echo "Production frontend ready on port $port"
    exit 0
  fi
  sleep 2
done
echo "Production frontend did not become ready" >&2
tail -50 "$reports/production-frontend.log" >&2
exit 1
