#!/usr/bin/env bash
# Forced SSH command of the CI deployment key, installed root-owned as
# /usr/local/libexec/slk-st/deploy-command. It runs as the deployment user and
# accepts exactly one request from SSH_ORIGINAL_COMMAND (or its arguments locally):
#
#   upload <commit> <sha256>  receive and verify a prebuilt release archive on stdin
#   deploy <commit>    deploy a full 40-hex commit contained in origin/<branch>
#   rollback <commit>  roll the active release <commit> back to its recorded predecessor
#   wait <commit>      reattach to the latest run for <commit> and return its result
#   snapshot           stream an anonymized copy of the data for staging (snapshot.sh); the
#                      staging key runs "deploy-command --snapshot-only", which allows only this
#   status             print the active release and recent runs
#
# Releases use upstream's protocol (bin/slk release backup|stage|activate|rollback).
# Exit status: 0 success, 1 failed and previous release restored, 2 usage,
# 3 refused, 4 operator attention required, 75 another operation is running.
set -Eeuo pipefail
# Name the failing command; the text is unexpanded, so no private values are printed.
trap 'slk_status=$?; echo "${BASH_SOURCE[0]##*/}: line $LINENO: \"$BASH_COMMAND\" failed with status $slk_status" >&2' ERR
umask 077
# shellcheck source=deploy/st/lib.sh
source /usr/local/libexec/slk-st/lib.sh
load_st_conf
[[ "$(id -u)" != 0 && "$(id -un)" == "$SLK_ST_USER" ]] || die "Run as $SLK_ST_USER" 2
user_runtime_environment

self="$SLK_ST_LIBEXEC/deploy-command"
state="$HOME/.local/state/slk-st"
runs="$state/runs"
releases="$HOME/.local/state/slk-releases"
project="$SLK_ST_PROJECT"
mkdir -p "$runs" "$state/releases"
chmod 700 "$state" "$runs"

usage() {
  echo "Usage: upload <40-hex commit> <64-hex sha256> | deploy <40-hex commit> | rollback <40-hex commit> | wait <40-hex commit> | snapshot | status" >&2
  exit 2
}

npm_dependencies() {
  (
    cd "$SLK_ST_CHECKOUT"
    npm ci --prefix bin --ignore-scripts --no-audit --no-fund --loglevel=error
    npm ci --prefix src/directus/cli --ignore-scripts --no-audit --no-fund --loglevel=error
  )
}

checkout() {
  git -C "$SLK_ST_CHECKOUT" -c advice.detachedHead=false checkout --quiet --detach "$1" && npm_dependencies
}

release_step() {
  local action="$1" next="$2" previous="$3"
  log "Release protocol: $action $next (previous $previous)"
  (cd "$SLK_ST_CHECKOUT" && bin/slk release "$action" "$SLK_ST_HOST_CONFIG" "$next" "$previous" --env production)
}

record_value() {
  local file="$1" key="$2" line
  while IFS= read -r line; do
    [[ "$line" == "$key="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done < "$file"
  return 1
}

# The release protocol requires an off-host verified checkpoint before activation.
# Local verification always runs; an optional restic repository adds an off-host copy.
verify_backup() {
  local directory="$releases/$1" method=local
  log "Verifying release checkpoint $1"
  (cd "$directory" && sha256sum --quiet --check backups.sha256) || return 1
  grep -q "TABLE DATA" "$directory/database.before.list" || return 1
  tar -tf "$directory/uploads.before.tar" > /dev/null || return 1
  tar -tf "$directory/frontend-output.before.tar" > /dev/null || return 1
  tar -tzf "$directory/source.before.tar.gz" > /dev/null || return 1
  tar -tzf "$directory/config.before.tar.gz" > /dev/null || return 1
  if [[ "${SLK_ST_OFFSITE:-none}" == restic ]]; then
    offsite_backup "$directory" "$1" || return 1
    method=restic
  fi
  printf 'verified=%s method=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$method" > "$directory/backup.verified"
}

offsite_backup() (
  local directory="$1" tag="$2" settings="$HOME/.config/slk/release-offsite.env" line key restore
  [[ -f "$settings" && ! -L "$settings" && "$(stat -c '%a:%u' "$settings")" == "600:$(id -u)" ]] ||
    die "SLK_ST_OFFSITE=restic needs an owner-only $settings"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^((RESTIC|AWS|B2|AZURE|GOOGLE|OS|ST)_[A-Z0-9_]+)=(.*)$ ]] || die "Unsupported line in $settings"
    key="${BASH_REMATCH[1]}"
    export "$key=${BASH_REMATCH[3]}"
  done < "$settings"
  log "Copying the checkpoint off-host with restic"
  restic backup --quiet --tag slk-release --tag "$tag" "$directory"
  restore="$(mktemp -d)"
  trap 'rm -rf "$restore"' EXIT
  # Read back the database dump and compare it with the manifest.
  restic restore latest --tag "$tag" --target "$restore" --include "$directory/database.before.dump" \
    --include "$directory/backups.sha256" --quiet
  (cd "$restore$directory" && grep ' database.before.dump$' backups.sha256 | sha256sum --quiet --check)
)

host_file_drift() {
  local manifest=/etc/slk-st/host-files.sha256
  [[ -f "$manifest" ]] || return 0
  if ! (cd "$SLK_ST_CHECKOUT" && sha256sum --quiet --check --strict "$manifest" > /dev/null 2>&1); then
    warn "Host-level files in this revision differ from the installed copies. Re-run deploy/st/bootstrap-ubuntu.sh as root from this revision to update them."
  fi
}

# After a failed activation: restore the previous checkout and make sure the
# previous release serves, using upstream's rollback where the protocol did not.
recover() {
  local tag="$1" previous_tag="$2" previous_revision="$3"
  log "Restoring checkout $previous_revision"
  checkout "$previous_revision" || return 1
  if [[ -f "$releases/$tag/rollback.ok" ]]; then
    log "The release protocol already restored the previous application release"
  elif pm volume exists "${project}_frontend-output_before_${tag#release-}"; then
    release_step rollback "$tag" "$previous_tag" || return 1
  else
    log "Activation stopped before the application changed; leaving maintenance mode"
    host_slk stack compose --env production -- --profile maintenance stop maintenance || return 1
  fi
  check_health
}

do_upload() {
  local sha="$1" expected_sha256="$2" tag actual_sha256 temp upload_dir
  cd "$SLK_ST_CHECKOUT"
  [[ -f "$state/initialized" ]] || die "The stack was not initialized by bootstrap-ubuntu.sh" 4
  [[ "$(git remote get-url origin)" == "$SLK_ST_REMOTE_URL" ]] || die "The origin remote differs from $SLK_ST_REMOTE_URL" 4

  log "Fetching $SLK_ST_BRANCH from $SLK_ST_REMOTE_URL"
  git fetch --quiet --no-tags --prune origin "+refs/heads/$SLK_ST_BRANCH:refs/remotes/origin/$SLK_ST_BRANCH" ||
    die "Fetching origin failed"
  git cat-file -e "$sha^{commit}" 2> /dev/null || die "Commit $sha does not exist in origin" 3
  git merge-base --is-ancestor "$sha" "refs/remotes/origin/$SLK_ST_BRANCH" ||
    die "Commit $sha is not contained in origin/$SLK_ST_BRANCH; refusing upload" 3

  tag="release-$sha"
  upload_dir="$state/uploads/$tag"
  # A new upload replaces any earlier one of the same commit.
  rm -rf "$upload_dir"
  mkdir -p "$upload_dir"

  log "Receiving release archive on stdin (max 4 GB)"
  temp="$upload_dir/archive.tmp"
  # Read stdin with size cap (4 GB = 4294967296 bytes)
  if ! head -c 4294967296 > "$temp"; then
    rm -f "$temp"
    die "Archive receive failed" 3
  fi

  # Check if more data remains (would exceed cap)
  if read -t 0.1 -n 1; then
    rm -f "$temp"
    die "Archive exceeds 4 GB size limit" 3
  fi

  # Verify sha256
  log "Verifying archive checksum"
  actual_sha256=$(sha256sum "$temp" | cut -d' ' -f1)
  [[ "$actual_sha256" == "$expected_sha256" ]] || {
    rm -f "$temp"
    die "Archive sha256 mismatch: got $actual_sha256, expected $expected_sha256" 3
  }

  log "Extracting archive"
  mkdir -p "$upload_dir/images"
  if ! zstd -dc "$temp" | tar -C "$upload_dir/images" -xf -; then
    rm -rf "$upload_dir"
    die "Archive extraction failed" 3
  fi
  rm "$temp"

  log "Loading and verifying images"
  # Load all images
  for image_tar in "$upload_dir/images"/*.tar; do
    [[ -f "$image_tar" ]] || continue
    # The frontend output is a volume export, imported below.
    [[ "$(basename "$image_tar")" == frontend-output.tar ]] && continue
    log "Loading $(basename "$image_tar")"
    pm load -i "$image_tar" || {
      rm -rf "$upload_dir"
      die "Failed to load $(basename "$image_tar")" 3
    }
  done

  # Verify application images have correct revision labels
  for service in directus frontend; do
    image="localhost/slk-podman-$service:$tag"
    if ! pm image exists "$image"; then
      rm -rf "$upload_dir"
      die "Missing required image: $image" 3
    fi
    image_revision=$(pm image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    if [[ "$image_revision" != "$sha" ]]; then
      rm -rf "$upload_dir"
      die "Image $image has revision $image_revision, expected $sha" 3
    fi
  done

  # Store frontend output
  if [[ -f "$upload_dir/images/frontend-output.tar" ]]; then
    log "Loading frontend output"
    pm volume rm -f "${project}_frontend-output_$sha" > /dev/null 2>&1 || true
    pm volume create "${project}_frontend-output_$sha" >/dev/null || {
      rm -rf "$upload_dir"
      die "Failed to create output volume" 3
    }
    pm volume import "${project}_frontend-output_$sha" "$upload_dir/images/frontend-output.tar" || {
      pm volume rm "${project}_frontend-output_$sha" 2>/dev/null || true
      rm -rf "$upload_dir"
      die "Failed to extract frontend output" 3
    }
    # Upstream's stage step rebuilds the output (nuxt build, several GB) when this check fails.
    # Run the same check now so an unusable upload is refused instead of built on the server.
    pm run --rm --entrypoint node --user 1000:1000 --userns keep-id:uid=1000,gid=1000 -v "${project}_frontend-output_$sha:/frontend/.output:ro,U" \
      "localhost/slk-podman-frontend:$tag" scripts/productionOutput.mts verify > /dev/null || {
      pm volume rm "${project}_frontend-output_$sha" 2>/dev/null || true
      rm -rf "$upload_dir"
      die "The uploaded frontend output fails verification; refusing to build it on the server" 3
    }
  else
    rm -rf "$upload_dir"
    die "The upload contains no frontend output" 3
  fi

  # The loaded images live in Podman's storage now; keep only the output for retried tags.
  find "$upload_dir/images" -maxdepth 1 -name '*.tar' ! -name frontend-output.tar -delete
  touch "$upload_dir/upload.ok"
  log "RESULT: uploaded $tag"
}

do_deploy() {
  local sha="$1" current active previous_tag tag n available upload_dir staged
  cd "$SLK_ST_CHECKOUT"
  [[ -f "$state/initialized" && -f "$state/active" ]] || die "The stack was not initialized by bootstrap-ubuntu.sh" 4
  [[ "$(git remote get-url origin)" == "$SLK_ST_REMOTE_URL" ]] || die "The origin remote differs from $SLK_ST_REMOTE_URL" 4
  [[ -z "$(git status --porcelain)" ]] || die "The deployment checkout has local changes; operator attention required" 4
  log "Fetching $SLK_ST_BRANCH from $SLK_ST_REMOTE_URL"
  git fetch --quiet --no-tags --prune origin "+refs/heads/$SLK_ST_BRANCH:refs/remotes/origin/$SLK_ST_BRANCH" ||
    die "Fetching origin failed"
  git cat-file -e "$sha^{commit}" 2> /dev/null || die "Commit $sha does not exist in origin" 3
  git merge-base --is-ancestor "$sha" "refs/remotes/origin/$SLK_ST_BRANCH" ||
    die "Commit $sha is not contained in origin/$SLK_ST_BRANCH; refusing to deploy" 3
  current="$(git rev-parse HEAD)"
  active="$(< "$state/active")"
  [[ "$current" == "$active" ]] || die "Checkout $current differs from the active release $active" 4
  previous_tag="$(private_value "$SLK_ST_HOST_CONFIG" SLK_PODMAN_TAG)"
  [[ "$previous_tag" =~ ^release-[0-9a-f]{8,40}$ && "$current" == "${previous_tag#release-}"* ]] ||
    die "The active tag $previous_tag does not identify $current" 4
  if [[ "$sha" == "$current" ]]; then
    log "Commit $sha is already active; checking health"
    check_health || die "The active release is unhealthy" 4
    log "RESULT: already active"
    return 0
  fi
  if git merge-base --is-ancestor "$sha" "$current"; then
    die "Commit $sha is older than the active release $current; use rollback instead" 3
  fi
  # A retried commit gets a shorter, still unambiguous tag so that every attempt keeps its own checkpoint.
  tag=""
  for ((n = 40; n >= 12; n--)); do
    if [[ ! -e "$releases/release-${sha:0:n}" ]]; then
      tag="release-${sha:0:n}"
      break
    fi
  done
  [[ -n "$tag" && "$tag" != "$previous_tag" ]] || die "No unused release tag remains for $sha" 4
  available="$(df --output=avail -BG "$HOME" | tail -n 1 | tr -dc 0-9)"
  ((available >= SLK_ST_MIN_FREE_GB)) ||
    die "Only ${available}G free in $HOME (need ${SLK_ST_MIN_FREE_GB}G); run image/backup retention first" 4

  # The upload is stored under the full commit. A retried commit's shorter tag needs the same images
  # under that tag and the staged output volume named after it (podman/release/run.sh).
  upload_dir="$state/uploads/release-$sha"
  [[ -f "$upload_dir/upload.ok" ]] ||
    die "No prebuilt release archive uploaded for $sha. The server never builds application images (2 GB RAM). Upload it first." 3
  staged="${project}_frontend-output_${tag#release-}"
  if [[ "$tag" != "release-$sha" ]]; then
    for service in database meilisearch directus frontend maintenance; do
      pm tag "localhost/slk-podman-$service:release-$sha" "localhost/slk-podman-$service:$tag" ||
        die "Tagging the uploaded $service image as $tag failed; the active release is unchanged" 4
    done
    pm volume rm -f "$staged" > /dev/null 2>&1 || true
    { pm volume create "$staged" > /dev/null && pm volume import "$staged" "$upload_dir/images/frontend-output.tar"; } ||
      die "Preparing the staged output $staged failed; the active release is unchanged" 4
  fi
  pm volume exists "$staged" || die "The uploaded frontend output volume $staged is missing; upload again" 4

  log "Deploying $sha as $tag (active $current as $previous_tag)"
  if ! checkout "$sha"; then
    checkout "$current" || die "Restoring checkout $current failed" 4
    die "Checking out $sha failed; the active release is unchanged"
  fi
  host_file_drift

  log "Using the uploaded images and frontend output"
  if ! release_step backup "$tag" "$previous_tag" || ! verify_backup "$tag"; then
    checkout "$current" || die "Restoring checkout $current failed" 4
    die "The release checkpoint failed; the active release is unchanged"
  fi

  if ! release_step stage-prebuilt "$tag" "$previous_tag"; then
    checkout "$current" || die "Restoring checkout $current failed" 4
    die "Staging prebuilt release failed; the active release is unchanged"
  fi
  if ! release_step activate "$tag" "$previous_tag"; then
    warn "Activation failed; restoring the previous release"
    recover "$tag" "$previous_tag" "$current" ||
      die "ROLLBACK FAILED: the previous release is not healthy; maintenance may be active. Operator attention required." 4
    die "Activation of $sha failed; previous release $current is serving again" 1
  fi
  if ! check_health; then
    warn "Post-activation health check failed; rolling back"
    checkout "$current" && release_step rollback "$tag" "$previous_tag" && check_health ||
      die "ROLLBACK FAILED after a failed health check. Operator attention required." 4
    die "Release $sha failed its health check; previous release $current is serving again" 1
  fi
  printf 'tag=%s\nprevious_tag=%s\nprevious_revision=%s\n' "$tag" "$previous_tag" "$current" > "$state/releases/$sha"
  printf '%s\n' "$sha" > "$state/active"
  if [[ -f "$releases/$previous_tag/activate.ok" ]]; then
    (cd "$SLK_ST_CHECKOUT" && bin/slk images retain --project "$project" --apply > /dev/null) ||
      warn "Image retention failed; check disk usage"
  fi
  log "RESULT: deployed $sha"
}

do_rollback() {
  local sha="$1" active record tag previous_tag previous_revision service
  cd "$SLK_ST_CHECKOUT"
  active="$(< "$state/active")"
  [[ "$sha" == "$active" ]] || die "Only the active release ($active) can be rolled back" 3
  record="$state/releases/$sha"
  [[ -f "$record" ]] || die "No release record for $sha" 3
  tag="$(record_value "$record" tag)" || die "Invalid release record" 4
  previous_tag="$(record_value "$record" previous_tag)" || die "Invalid release record" 4
  previous_revision="$(record_value "$record" previous_revision)" || die "Invalid release record" 4
  [[ -n "$previous_tag" && "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || die "No previous release is recorded for $sha" 3
  for service in directus frontend; do
    pm image exists "localhost/slk-podman-$service:$previous_tag" || die "Images of $previous_tag are no longer available" 3
  done
  [[ -z "$(git status --porcelain)" && "$(git rev-parse HEAD)" == "$sha" ]] || die "Checkout differs from $sha" 4
  log "Rolling back $sha ($tag) to $previous_revision ($previous_tag)"
  checkout "$previous_revision" || die "Checking out $previous_revision failed" 4
  release_step rollback "$tag" "$previous_tag" && check_health ||
    die "ROLLBACK FAILED; operator attention required" 4
  printf '%s\n' "$previous_revision" > "$state/active"
  log "RESULT: rolled back to $previous_revision"
}

# flock --close keeps the lock descriptor out of every container the release starts.
worker() {
  local id="$1" action="$2" sha="$3" status=0
  flock --nonblock --close --conflict-exit-code 75 "$state/deploy.lock" "$self" --locked "$action" "$sha" ||
    status=$?
  ((status != 75)) || log "ERROR: Another deployment or rollback is running"
  printf '%s\n' "$status" > "$runs/$id.exit"
  log "Finished with exit status $status"
  exit "$status"
}

# Print a run's log until its worker exits, then return the worker's exit status.
follow() {
  local id="$1" pid
  pid="$(< "$runs/$id.pid")"
  if [[ -f "$runs/$id.exit" ]]; then
    cat "$runs/$id.log"
  else
    tail -n +1 --follow --pid="$pid" "$runs/$id.log"
  fi
  [[ -f "$runs/$id.exit" ]] || { log "The run $id ended without a result"; return 1; }
  return "$(< "$runs/$id.exit")"
}

# Anonymized copy of the production data for a staging environment (docs/st/STAGING.md), as a
# tar stream on stdout. Production is only read; snapshot.sh anonymizes a temporary copy.
do_snapshot() {
  local db database
  cd "$SLK_ST_CHECKOUT"
  [[ -f "$state/initialized" ]] || die "The stack was not initialized by bootstrap-ubuntu.sh" 4
  db="$(pm ps -q --filter "label=io.podman.compose.project=$project" --filter label=io.podman.compose.service=db)"
  [[ "$db" =~ ^[0-9a-f]{12,64}$ ]] || die "Expected one running database container" 4
  database="$(private_value "$SLK_ST_CHECKOUT/src/directus/.env" DB_DATABASE)"
  bash "$SLK_ST_LIBEXEC/snapshot.sh" "$db" "$database" "${project}_uploads" "$state" < /dev/null
}

status() {
  local active
  active="$(cat "$state/active" 2> /dev/null || echo none)"
  echo "active=$active"
  [[ -f "$state/releases/$active" ]] && sed 's/^/  /' "$state/releases/$active"
  echo "recent runs:"
  find "$runs" -maxdepth 1 -name '*.log' -printf '%f\n' | sort | tail -n 10 | while read -r name; do
    echo "  ${name%.log} exit=$(cat "$runs/${name%.log}.exit" 2> /dev/null || echo running)"
  done
}

if [[ "${1:-}" == --worker && $# == 4 ]]; then
  worker "$2" "$3" "$4"
fi
if [[ "${1:-}" == --snapshot-locked && $# == 1 ]]; then
  do_snapshot
  exit
fi
if [[ "${1:-}" == --upload-locked && $# == 3 && "$2" =~ ^[0-9a-f]{40}$ && "$3" =~ ^[0-9a-f]{64}$ ]]; then
  do_upload "$2" "$3"
  exit
fi
if [[ "${1:-}" == --locked && $# == 3 ]]; then
  case "$2" in
    deploy) do_deploy "$3" ;;
    rollback) do_rollback "$3" ;;
    upload) do_upload "$3" ;;
    *) die "Unknown action" 2 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == --snapshot-only && $# == 1 ]]; then
  # The staging key's forced command: snapshots and nothing else.
  [[ "${SSH_ORIGINAL_COMMAND:-}" == snapshot ]] || { log "ERROR: This key may only request a snapshot" >&2; exit 3; }
  request=snapshot
elif [[ -n "${SSH_ORIGINAL_COMMAND+set}" ]]; then
  request="$SSH_ORIGINAL_COMMAND"
else
  request="$*"
fi
((${#request} <= 120)) || usage
if [[ "$request" == status ]]; then
  status
  exit 0
fi
# snapshot streams the anonymized copy on stdout and holds the deployment lock while it runs.
if [[ "$request" == snapshot ]]; then
  status=0
  flock --nonblock --close --conflict-exit-code 75 "$state/deploy.lock" "$self" --snapshot-locked || status=$?
  ((status != 75)) || log "ERROR: A deployment, rollback or upload is running; try again later" >&2
  exit "$status"
fi
# upload is synchronous: stdin carries the archive, the request names its sha256. It holds the
# deployment lock so that it cannot change images or volumes while a release runs.
if [[ "$request" =~ ^upload\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  status=0
  flock --nonblock --close --conflict-exit-code 75 "$state/deploy.lock" \
    "$self" --upload-locked "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" || status=$?
  ((status != 75)) || log "ERROR: Another deployment, rollback or upload is running"
  exit "$status"
fi
[[ "$request" =~ ^(deploy|rollback|wait)\ ([0-9a-f]{40})$ ]] || usage
action="${BASH_REMATCH[1]}"
sha="${BASH_REMATCH[2]}"


if [[ "$action" == wait ]]; then
  id="$(find "$runs" -maxdepth 1 -name "*-$sha.log" -printf '%f\n' | sort | tail -n 1)"
  [[ -n "$id" ]] || die "No run for $sha" 3
  follow "${id%.log}"
  exit
fi

id="$(date -u +%Y%m%dT%H%M%SZ)-$action-$sha"
: > "$runs/$id.log"
# A new session keeps the release running if the SSH connection drops; reattach with wait.
setsid "$self" --worker "$id" "$action" "$sha" < /dev/null >> "$runs/$id.log" 2>&1 &
printf '%s\n' "$!" > "$runs/$id.pid"
log "Run $id started"
follow "$id"
