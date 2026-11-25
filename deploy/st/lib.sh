# shellcheck shell=bash
# Shared helpers for the st deployment scripts. Installed root-owned in
# /usr/local/libexec/slk-st by bootstrap-ubuntu.sh and sourced, never executed.

SLK_ST_CONF=/etc/slk-st/deploy.conf
SLK_ST_LIBEXEC=/usr/local/libexec/slk-st

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { log "WARNING: $*" >&2; }
die() {
  local status="${2:-1}"
  log "ERROR: $1" >&2
  exit "$status"
}

# Read the root-owned st configuration as data: KEY=VALUE lines with a strict
# character set. Nothing in it is evaluated as shell code.
load_st_conf() {
  local path="${1:-$SLK_ST_CONF}" line key value
  [[ -f "$path" && ! -L "$path" ]] || die "Missing st configuration $path; run bootstrap-ubuntu.sh"
  [[ "$(stat -c '%u' "$path")" == 0 && "$(( 0$(stat -c '%a' "$path") & 022 ))" == 0 ]] ||
    die "$path must be root-owned and not group/world writable"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^(SLK_ST_[A-Z0-9_]+)=([A-Za-z0-9_.,/:@+-]*)$ ]] || die "Invalid line in $path"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    printf -v "$key" '%s' "$value"
  done < "$path"
  local required
  for required in SLK_ST_USER SLK_ST_CHECKOUT SLK_ST_HOST_CONFIG SLK_ST_BRANCH SLK_ST_REMOTE_URL \
    SLK_ST_SITE_ORIGIN SLK_ST_CMS_ORIGIN SLK_ST_PROJECT; do
    [[ -n "${!required:-}" ]] || die "$required is missing in $path"
  done
  SLK_ST_WEB_PORT="${SLK_ST_WEB_PORT:-9000}"
  SLK_ST_CMS_PORT="${SLK_ST_CMS_PORT:-9001}"
  SLK_ST_MIN_FREE_GB="${SLK_ST_MIN_FREE_GB:-12}"
}

# The deployment user's environment for rootless Podman and its user manager.
user_runtime_environment() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  export PATH="/usr/local/bin:/usr/bin:/bin"
  [[ -d "$XDG_RUNTIME_DIR" ]] || die "No user runtime directory; is lingering enabled for $(id -un)?"
}

# Every engine call enters the maintained inherited AppArmor policy, like the upstream CLI.
pm() {
  if [[ -f /etc/apparmor.d/slk-rootless ]]; then
    aa-exec -p slk-rootless -- podman --remote=false "$@"
  else
    podman --remote=false "$@"
  fi
}

# Upstream CLI with the private release host configuration loaded as dotenv data.
host_slk() {
  (cd "$SLK_ST_CHECKOUT" && node bin/cli/host-environment.ts "$SLK_ST_HOST_CONFIG" bin/slk "$@")
}

private_value() {
  node "$SLK_ST_LIBEXEC/private-config.mts" get "$1" "$2"
}

retry_url() {
  local url="$1" attempts="${2:-60}" i
  shift 2 || true
  for ((i = 1; i <= attempts; i++)); do
    if curl --fail --silent --show-error --output /dev/null --connect-timeout 3 --max-time 15 "$@" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 3
  done
  curl --fail --silent --show-error --output /dev/null --connect-timeout 3 --max-time 15 "$@" "$url"
}

# Like retry_url, but waits for one specific HTTP status.
retry_status() {
  local url="$1" expected="$2" attempts="$3" i
  shift 3
  for ((i = 1; i <= attempts; i++)); do
    [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 15 "$@" "$url" 2>/dev/null)" == "$expected" ]] &&
      return 0
    sleep 3
  done
  return 1
}

# Application readiness on loopback, then through the local public gateway with
# normal TLS verification (a private gateway CA is used only when configured).
check_health() {
  local web="http://127.0.0.1:$SLK_ST_WEB_PORT" cms="http://127.0.0.1:$SLK_ST_CMS_PORT" origin host
  local tls=()
  [[ -n "${SLK_ST_GATEWAY_CA:-}" ]] && tls=(--cacert "$SLK_ST_GATEWAY_CA")
  log "Health: CMS $cms/server/health"
  retry_url "$cms/server/health" 60 || return 1
  log "Health: website $web/ and CMS-backed layout data"
  retry_url "$web/" 60 || return 1
  retry_url "$web/api/public/site-layout" 30 || return 1
  if [[ "${SLK_ST_GATEWAY_CHECK:-true}" == true ]]; then
    for origin in "$SLK_ST_SITE_ORIGIN/" "$SLK_ST_CMS_ORIGIN/server/health"; do
      host="${origin#https://}"
      host="${host%%/*}"
      log "Health: gateway $origin"
      if [[ "$origin" == "$SLK_ST_SITE_ORIGIN/" && "${SLK_ST_SITE_PROTECTED:-false}" == true ]]; then
        # A password-protected website (staging) must refuse requests without it.
        retry_status "$origin" 401 40 --resolve "$host:443:127.0.0.1" "${tls[@]}" || return 1
      else
        retry_url "$origin" 40 --resolve "$host:443:127.0.0.1" "${tls[@]}" || return 1
      fi
    done
  fi
}
