#!/usr/bin/env bash
# Build a production release archive on a GitHub runner: all images and frontend output.
# Called by st-release.yml with a clean checkout at <sha>.
#
#   deploy/st/build-release.sh <40-hex sha> <output-directory>
#
# Writes <output-directory>/release-<sha>.tar.zst and release-<sha>.manifest.json.
# The archive contains all images the server would otherwise build, so the server builds nothing.
set -Eeuo pipefail
trap 'status=$?; echo "${BASH_SOURCE[0]##*/}: line $LINENO: \"$BASH_COMMAND\" failed with status $status" >&2; exit "$status"' ERR

[[ $# == 2 && "$1" =~ ^[0-9a-f]{40}$ && -d "$2" ]] || {
  echo "Usage: deploy/st/build-release.sh <40-hex sha> <output-directory>" >&2
  exit 2
}

sha="$1"
outdir="$(cd "$2" && pwd)"
tag="release-$sha"
archive="$outdir/$tag.tar.zst"
manifest="$outdir/$tag.manifest.json"

[[ "$(git rev-parse HEAD)" == "$sha" ]] || {
  echo "ERROR: HEAD is not $sha" >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || {
  echo "ERROR: working tree is not clean" >&2
  exit 1
}

# Use the same hash-pinned Compose provider as the server bootstrap (podman-compose.requirements.txt).
# Runners and fresh build hosts do not ship it; install it into a private venv when missing.
ensure_podman_compose() {
  if podman-compose --version 2> /dev/null | grep -q 'version 1.6.0'; then
    return
  fi
  local venv="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/st-podman-compose"
  if ! python3 -c 'import dotenv, yaml' 2> /dev/null || ! python3 -c 'import venv' 2> /dev/null; then
    sudo apt-get install -y --no-install-recommends python3-venv python3-yaml python3-dotenv > /dev/null
  fi
  if ! "$venv/bin/podman-compose" --version 2> /dev/null | grep -q 'version 1.6.0'; then
    rm -rf "$venv"
    python3 -m venv --system-site-packages "$venv"
    "$venv/bin/pip" install --quiet --disable-pip-version-check --no-deps --require-hashes \
      -r "$(dirname "${BASH_SOURCE[0]}")/podman-compose.requirements.txt"
  fi
  export PATH="$venv/bin:$PATH"
  podman-compose --version | grep -q 'version 1.6.0' || {
    echo "ERROR: podman-compose 1.6.0 is not available" >&2
    exit 1
  }
}
ensure_podman_compose

echo "Building release $tag for commit $sha"
echo "Target: $archive"

# Build runtime base images (these rarely change, but we ship them so the server builds nothing)
export SLK_PODMAN_TAG="$tag"

# The compose files require the seccomp profile that bin/slk normally selects. Use a private,
# regular, non-writable copy of the engine default (runner images ship it world-writable).
seccomp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/st-build-seccomp.json"
install -m 0644 "$(readlink -f /usr/share/containers/seccomp.json)" "$seccomp"
export SLK_PODMAN_SECCOMP="$seccomp"
# Production overlay: the frontend output must be built with the production environment.
# A private compose project per build: its frontend-output volume receives the release output.
build_project="st-build-${sha:0:12}"
output_volume="${build_project}_frontend-output"
compose=(podman-compose -p "$build_project" -f podman-compose.yaml -f podman-compose.prod.yaml)
release_name="${RELEASE_TAG:-$tag}"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Building slk-runtime-env:local..."
podman --remote=false build --pull=missing \
  -t localhost/slk-runtime-env:local \
  -f podman/environment/Containerfile \
  podman/environment

echo "Building slk-caddy:2.11.9..."
podman --remote=false build --pull=missing \
  -t localhost/slk-caddy:2.11.9 \
  -f caddy/Containerfile \
  caddy

echo "Building slk-podman-directus-runtime:local..."
podman --remote=false build --pull=missing \
  --build-arg UID=1000 --build-arg GID=1000 \
  -t localhost/slk-podman-directus-runtime:local \
  -f podman/directus/RuntimeContainerfile \
  podman/directus

echo "Building slk-podman-frontend-runtime:local..."
podman --remote=false build --pull=missing \
  --build-arg UID=1000 --build-arg GID=1000 \
  -t localhost/slk-podman-frontend-runtime:local \
  -f podman/frontend/RuntimeContainerfile \
  podman/frontend

echo "Building application images with tag $tag..."
"${compose[@]}" build db meilisearch directus frontend
"${compose[@]}" --profile maintenance build maintenance

# Add revision labels to application images via wrapper builds (non-invasive, no Containerfile changes)
echo "Adding org.opencontainers.image.revision labels..."
for service in directus frontend; do
  built="localhost/slk-podman-$service:$tag"
  printf 'FROM %s\n' "$built" | podman --remote=false build \
    --label "org.opencontainers.image.revision=$sha" \
    -t "$built" \
    -f - .

  # Verify label matches what run.sh:171 expects
  revision=$(podman --remote=false image inspect "$built" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  [[ "$revision" == "$sha" ]] || {
    echo "ERROR: $built has revision label '$revision', expected '$sha'" >&2
    exit 1
  }
  echo "✓ $built has revision $sha"
done

# Build frontend output
echo "Building frontend output..."
podman volume rm "$output_volume" > /dev/null 2>&1 || true
# The release identity is baked into the output as the /api/version defaults.
"${compose[@]}" --profile build run --rm --no-deps -T \
  -e NUXT_PUBLIC_RELEASE_COMMIT="$sha" \
  -e NUXT_PUBLIC_RELEASE_TAG="$release_name" \
  -e NUXT_PUBLIC_RELEASE_BUILT_AT="$built_at" \
  frontend-build

# Verify the output with the same check upstream's stage step runs (podman/release/run.sh).
# The image entrypoint is the slk-env loader, so call node directly.
echo "Verifying frontend output..."
podman --remote=false run --rm --entrypoint node --user 1000:1000 --userns keep-id:uid=1000,gid=1000 -v "$output_volume:/frontend/.output:ro,U" \
  "localhost/slk-podman-frontend:$tag" scripts/productionOutput.mts verify

# Save all images and output
echo "Packaging images and output..."
temp="$outdir/release-build-$$"
mkdir -p "$temp"

# Runtime base images
for image in \
  "slk-runtime-env:local" \
  "slk-caddy:2.11.9" \
  "slk-podman-directus-runtime:local" \
  "slk-podman-frontend-runtime:local"
do
  name="${image/:/-}"
  echo "Saving localhost/$image..."
  podman --remote=false save "localhost/$image" -o "$temp/${name}.tar"
done

# Application images
for service in database meilisearch directus frontend maintenance; do
  image="localhost/slk-podman-$service:$tag"
  echo "Saving $image..."
  podman --remote=false save "$image" -o "$temp/$service.tar"
done

echo "Exporting frontend output..."
podman --remote=false volume export "$output_volume" --output "$temp/frontend-output.tar"

# Create manifest with image IDs and sizes
echo "Creating manifest..."
declare -A image_ids
for service in database meilisearch directus frontend maintenance; do
  image_ids[$service]=$(podman --remote=false image inspect "localhost/slk-podman-$service:$tag" --format '{{.Id}}')
done

cat > "$manifest" <<EOF
{
  "sha": "$sha",
  "tag": "$tag",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "images": {
    "runtime": {
      "slk-runtime-env": {"file": "slk-runtime-env-local.tar"},
      "slk-caddy": {"file": "slk-caddy-2.11.9.tar"},
      "slk-podman-directus-runtime": {"file": "slk-podman-directus-runtime-local.tar"},
      "slk-podman-frontend-runtime": {"file": "slk-podman-frontend-runtime-local.tar"}
    },
    "application": {
      "database": {"id": "${image_ids[database]}", "file": "database.tar"},
      "meilisearch": {"id": "${image_ids[meilisearch]}", "file": "meilisearch.tar"},
      "directus": {"id": "${image_ids[directus]}", "file": "directus.tar", "revision": "$sha"},
      "frontend": {"id": "${image_ids[frontend]}", "file": "frontend.tar", "revision": "$sha"},
      "maintenance": {"id": "${image_ids[maintenance]}", "file": "maintenance.tar"}
    }
  },
  "frontend_output": {
    "file": "frontend-output.tar"
  }
}
EOF

echo "Creating archive..."
tar -C "$temp" -cf - . | zstd -19 -T0 -o "$archive"

# Compute checksums
echo "Computing checksums..."
sha256sum "$archive" | sed "s|$outdir/||" > "$archive.sha256"

# Cleanup
rm -rf "$temp"
podman volume rm "$output_volume" >/dev/null 2>&1 || true

size_mb=$(($(stat -c %s "$archive") / 1024 / 1024))
echo "✓ Release archive: $archive ($size_mb MB)"
echo "✓ Manifest: $manifest"
echo "size_mb=$size_mb" > "$outdir/$tag.size"
