#!/usr/bin/env bash
# First start of a fresh production stack, run by bootstrap-ubuntu.sh as the deployment user.
# Follows PODMAN.md, README.md (database application-role cutover) and DEPLOYMENT_CHECKLIST.md
# (private service identities) with upstream's CLI. Each completed step is recorded, so an
# interrupted bootstrap resumes where it stopped. An initialized stack is never re-initialized.
#
# Usage: first-start.sh [archive] [manifest] [snapshot]
#   If archive and manifest are provided, loads prebuilt images instead of building (2GB server).
#   A snapshot (deploy-command snapshot, staging only) replaces the empty database and uploads
#   before the configuration import, so the import migrates it like a release would.
set -Eeuo pipefail
# Name the failing command; the text is unexpanded, so no private values are printed.
trap 'slk_status=$?; echo "${BASH_SOURCE[0]##*/}: line $LINENO: \"$BASH_COMMAND\" failed with status $slk_status" >&2' ERR
umask 077
# shellcheck source=deploy/st/lib.sh
source /usr/local/libexec/slk-st/lib.sh
load_st_conf
user_runtime_environment
[[ "$(id -un)" == "$SLK_ST_USER" ]] || die "Run as $SLK_ST_USER"

# Optional prebuilt images
prebuilt_archive="${1:-}"
prebuilt_manifest="${2:-}"
snapshot="${3:-}"

state="$HOME/.local/state/slk-st"
private="$state/private"
mkdir -p "$state/init" "$private" "$state/releases"
chmod 700 "$state" "$private"
done_step() { [[ -f "$state/init/$1.done" ]]; }
mark_step() { : > "$state/init/$1.done"; }

if [[ -f "$state/initialized" ]]; then
  log "Stack already initialized at $(cat "$state/initialized"); nothing to do."
  exit 0
fi

cd "$SLK_ST_CHECKOUT"
[[ -z "$(git status --porcelain)" ]] || die "The deployment checkout must be clean"
revision="$(git rev-parse HEAD)"
tag="$(private_value "$SLK_ST_HOST_CONFIG" SLK_PODMAN_TAG)"
[[ "$tag" == "release-$revision" ]] || die "Host configuration tag $tag does not match checkout $revision"
export SLK_PODMAN_TAG="$tag"
project="$SLK_ST_PROJECT"
directus_env="$SLK_ST_CHECKOUT/src/directus/.env"
frontend_env="$SLK_ST_CHECKOUT/src/frontend/.env"

wait_healthy() {
  local container="$1" i status
  for ((i = 0; i < 100; i++)); do
    status="$(pm inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$status" == healthy ]] && return 0
    sleep 3
  done
  die "$container did not become healthy"
}

log "Preflight and image build/load for $tag"
host_slk stack doctor --env production
if ! done_step build; then
  if [[ -n "$prebuilt_archive" && -n "$prebuilt_manifest" ]]; then
    log "Loading prebuilt images from archive (2GB server never builds)"
    [[ -f "$prebuilt_archive" && -f "$prebuilt_manifest" ]] || die "Prebuilt archive or manifest not found"

    # Extract archive to temp directory
    extract_dir="$(mktemp -d "$state/extract.XXXXXX")"
    log "Extracting archive to $extract_dir..."
    tar --zstd -xf "$prebuilt_archive" -C "$extract_dir" || die "Failed to extract archive"

    # Load each image tar
    log "Loading runtime images..."
    for tar_file in "$extract_dir"/slk-*.tar; do
      [[ -f "$tar_file" ]] || continue
      log "Loading $(basename "$tar_file")..."
      aa-exec -p slk-rootless -- podman --remote=false load -i "$tar_file" || die "Failed to load $(basename "$tar_file")"
    done

    log "Loading application images..."
    for service in database meilisearch directus frontend maintenance; do
      tar_file="$extract_dir/$service.tar"
      [[ -f "$tar_file" ]] || die "Missing $service.tar"
      log "Loading $service..."
      aa-exec -p slk-rootless -- podman --remote=false load -i "$tar_file" || die "Failed to load $service"
    done

    # The production stack serves the frontend from the "<project>_frontend-output" volume and
    # rebuilds it (nuxt build, several GB of RAM) when that volume fails verification. Import the
    # prebuilt output there so the server never builds it.
    frontend_output="$extract_dir/frontend-output.tar"
    [[ -f "$frontend_output" ]] || die "Missing frontend-output.tar"
    log "Importing the prebuilt frontend output into ${project}_frontend-output"
    aa-exec -p slk-rootless -- podman --remote=false volume exists "${project}_frontend-output" ||
      aa-exec -p slk-rootless -- podman --remote=false volume create "${project}_frontend-output" > /dev/null
    aa-exec -p slk-rootless -- podman --remote=false volume import "${project}_frontend-output" "$frontend_output" ||
      die "Failed to import the frontend output"

    rm -rf "$extract_dir"
    log "Prebuilt images loaded successfully"
  else
    die "No prebuilt release archive was given. This server never builds images or the frontend
(2 GB RAM). Build a release on a runner (deploy/st/build-release.sh) and pass it to the bootstrap with
--archive and --manifest (docs/st/DEPLOYMENT.md)."
  fi
  mark_step build
fi

if ! done_step data; then
  log "Starting data services"
  host_slk stack compose --env production -- up -d --no-build db cache meilisearch
  mark_step data
fi
wait_healthy "${project}_db_1"

if [[ -n "$snapshot" ]] && ! done_step snapshot; then
  log "Restoring the anonymized snapshot"
  [[ -f "$snapshot" ]] || die "Snapshot $snapshot not found"
  snapshot_dir="$(mktemp -d "$state/snapshot.XXXXXX")"
  tar -xf "$snapshot" -C "$snapshot_dir" manifest.json database.dump uploads.tar
  log "Snapshot: $(cat "$snapshot_dir/manifest.json")"
  database="$(private_value "$directus_env" DB_DATABASE)"
  [[ "$database" =~ ^[A-Za-z0-9_]{1,63}$ ]] || die "Unexpected database name"
  in_db() {
    pm exec -i "${project}_db_1" sh -ec 'if command -v slk-env >/dev/null 2>&1; then exec slk-env sh -ec "$1" st-restore "$2"; fi; exec sh -ec "$1" st-restore "$2"' \
      st-restore "$1" "$database"
  }
  # The new database only holds what the image created on initialization; start from template0.
  in_db 'exec psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:?}" -d postgres -c "DROP DATABASE IF EXISTS \"$1\"" -c "CREATE DATABASE \"$1\" TEMPLATE template0"'
  in_db 'exec pg_restore -U "${POSTGRES_USER:?}" -d "$1" --no-owner --no-acl --exit-on-error' < "$snapshot_dir/database.dump"
  # Every account of the snapshot is anonymized. The configuration import and the service
  # identities authenticate as this stack's own administrator, as on a fresh stack.
  admin_email="$(private_value "$directus_env" ADMIN_EMAIL)"
  admin_token="$(private_value "$directus_env" CLI_DIRECTUS_STATIC_TOKEN)"
  [[ "$admin_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ && "$admin_token" =~ ^[A-Za-z0-9_-]{32,255}$ ]] ||
    die "Unexpected administrator settings"
  admin="$(printf "INSERT INTO directus_users (id, email, status, role, token)
    SELECT gen_random_uuid(), '%s', 'active', a.role, '%s' FROM directus_access a
    JOIN directus_policies p ON p.id = a.policy WHERE p.admin_access AND a.role IS NOT NULL
    ORDER BY a.role LIMIT 1 RETURNING id;\n" "$admin_email" "$admin_token" |
    in_db 'exec psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:?}" -d "$1" -f -')"
  unset admin_token
  [[ "$admin" =~ ^[0-9a-f-]{36}$ ]] || die "The snapshot has no administrator role"
  log "Staging administrator $admin_email added"
  pm volume exists "${project}_uploads" || pm volume create "${project}_uploads" > /dev/null
  pm volume import "${project}_uploads" "$snapshot_dir/uploads.tar"
  rm -rf "$snapshot_dir"
  mark_step snapshot
fi

if ! done_step schema; then
  log "Importing the code-first configuration through the unpublished core-only helper"
  host_slk stack compose --env production -- run --rm --no-deps --entrypoint /usr/local/bin/slk-env \
    directus node /directus/cli/bootstrapConfiguration.ts
  mark_step schema
fi

if ! done_step role; then
  # Production startup checks refuse a superuser application role (README.md).
  log "Creating the restricted database application role"
  rm -f "$private/database-role.json" "$private/database-role.json.env"
  host_slk stack compose --env production -- stop directus frontend >/dev/null 2>&1 || true
  host_slk database role --env production -- plan "$private/database-role.json" slk_app
  host_slk database role --env production -- apply "$private/database-role.json"
  node "$SLK_ST_LIBEXEC/private-config.mts" merge "$directus_env" "$private/database-role.json.env"
  mark_step role
fi

if ! done_step cms; then
  log "Starting the CMS with startup security checks (frontend stays stopped)"
  host_slk stack start --env production --import --prepare-only
  mark_step cms
fi

if ! done_step identities; then
  log "Provisioning private website service identities"
  identities="$private/service-users.env"
  rm -f "$identities"
  host_slk stack compose --env production -- exec -T -e DIRECTUS_URL=http://127.0.0.1:8055 directus \
    node /directus/cli/tasks/provisionServiceUsers.ts > "$identities"
  chmod 600 "$identities"
  admin_snippet="$private/admin-token.env"
  printf 'DIRECTUS_ADMIN_TOKEN=%s\n' "$(private_value "$directus_env" CLI_DIRECTUS_STATIC_TOKEN)" > "$admin_snippet"
  node "$SLK_ST_LIBEXEC/private-config.mts" merge "$frontend_env" "$identities" --nuxt-aliases
  node "$SLK_ST_LIBEXEC/private-config.mts" merge "$frontend_env" "$admin_snippet" --nuxt-aliases
  rm -f "$admin_snippet"
  # Mail webhook URLs need the imported flow UUIDs (src/frontend/.env.example).
  token="$(private_value "$directus_env" CLI_DIRECTUS_STATIC_TOKEN)"
  flows="$private/flows.env"
  : > "$flows"
  curl --fail --silent --show-error --max-time 20 -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$SLK_ST_CMS_PORT/flows?fields=id,name&limit=-1" |
    node --input-type=module -e '
      let body = ""; for await (const chunk of process.stdin) body += chunk;
      const flows = JSON.parse(body).data ?? [];
      const id = (name) => flows.find((flow) => flow.name === name)?.id;
      const lines = [];
      for (const [key, name] of [["DIRECTUS_FLOW_NOTIFY_ADMIN", "notifyAdminNewLocalteam"], ["DIRECTUS_FLOW_WELCOME_EMAIL", "sendWelcomeNewLocalteam"]]) {
        const value = id(name);
        if (value && /^[0-9a-f-]{36}$/.test(value)) lines.push(`${key}=http://directus:8055/flows/trigger/${value}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
    ' > "$flows" || warn "Looking up the mail flows failed"
  unset token
  if [[ -s "$flows" ]] && grep -q = "$flows"; then
    node "$SLK_ST_LIBEXEC/private-config.mts" merge "$frontend_env" "$flows" --nuxt-aliases
  else
    warn "Mail flows were not found; set DIRECTUS_FLOW_* in $frontend_env later"
  fi
  rm -f "$flows"
  mark_step identities
fi

if ! done_step homepage; then
  # The code-first import and seeds only extend an existing homepage, and `slk release activate`
  # snapshots it before every release. A fresh database therefore gets an empty published one.
  # The CMS derives the slug from the name, so the name must be "Index".
  log "Creating the published homepage (slug index) if it is missing"
  token="$(private_value "$directus_env" CLI_DIRECTUS_STATIC_TOKEN)"
  cms="http://127.0.0.1:$SLK_ST_CMS_PORT"
  existing="$(curl --fail --silent --show-error --max-time 20 -H "Authorization: Bearer $token" \
    "$cms/items/pages?filter%5Bslug%5D%5B_eq%5D=index&fields=id&limit=1")"
  if [[ "$existing" =~ ^\{\"data\":\[\]\}$ ]]; then
    created="$(curl --fail --silent --show-error --max-time 20 -X POST -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" --data '{"slug":"index","name":"Index","status":"published"}' \
      "$cms/items/pages?fields=id,slug,status")"
    log "Created homepage: $created"
  else
    log "Homepage already present: ${existing:0:200}"
  fi
  unset token
  mark_step homepage
fi

log "Starting the complete production stack"
host_slk stack start --env production
# The gateway is installed by root after this first start.
SLK_ST_GATEWAY_CHECK=false check_health
printf '%s %s\n' "$revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$state/initialized"
printf 'tag=%s\nprevious_tag=\nprevious_revision=\n' "$tag" > "$state/releases/$revision"
printf '%s\n' "$revision" > "$state/active"
log "Initial release $tag is running."
