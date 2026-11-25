#!/usr/bin/env bash
# Runner-side half of the st deployment, used by st-release.yml and st-rollback.yml.
#
#   ci-deploy.sh upload <commit> <archive> <manifest>     upload release archive to server
#   ci-deploy.sh deploy <commit>                           deploy uploaded or built release
#   ci-deploy.sh rollback <commit>                         rollback active release
#   ci-deploy.sh smoke <site-origin> <cms-origin> [<sha>] public checks + optional version check
#   ci-deploy.sh snapshot <file>                           anonymized production data for staging
#
# smoke sends SMOKE_BASIC_AUTH (user:password), when set, to the website (staging).
#
# Connection settings come from the environment: DEPLOY_SSH_HOST, DEPLOY_SSH_PORT (22),
# DEPLOY_SSH_USER (deploy), DEPLOY_KNOWN_HOSTS (pinned host key lines) and DEPLOY_SSH_KEY
# (private key). Host keys are never learned on first use. The server's output is printed
# with workflow commands disabled, so it cannot inject annotations or masks into the job.
set -Eeuo pipefail
umask 077

die() {
  # DEPLOY_ANNOTATE=false prints expected failures without error annotations.
  if [[ "${DEPLOY_ANNOTATE:-true}" == false ]]; then echo "Deployment: $1"; else echo "::error title=Deployment::$1"; fi
  exit "${2:-1}"
}

output() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  return 0
}

ssh_setup() {
  [[ -n "${DEPLOY_SSH_HOST:-}" && -n "${DEPLOY_KNOWN_HOSTS:-}" && -n "${DEPLOY_SSH_KEY:-}" ]] ||
    die "DEPLOY_SSH_HOST, DEPLOY_KNOWN_HOSTS and DEPLOY_SSH_KEY are required" 2
  [[ "${DEPLOY_SSH_PORT:-22}" =~ ^[0-9]{1,5}$ ]] || die "Invalid DEPLOY_SSH_PORT" 2
  [[ "${DEPLOY_SSH_USER:-deploy}" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid DEPLOY_SSH_USER" 2
  [[ "$DEPLOY_SSH_HOST" =~ ^[A-Za-z0-9.:-]+$ ]] || die "Invalid DEPLOY_SSH_HOST" 2
  ssh_directory="$(mktemp -d "${RUNNER_TEMP:-/tmp}/slk-deploy.XXXXXX")"
  trap 'rm -rf "$ssh_directory"' EXIT
  printf '%s\n' "$DEPLOY_SSH_KEY" > "$ssh_directory/key"
  printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$ssh_directory/known_hosts"
  ssh-keygen -l -f "$ssh_directory/known_hosts" > /dev/null 2>&1 || die "DEPLOY_KNOWN_HOSTS contains no valid host key" 2
  ssh_cmd=(ssh -F /dev/null -i "$ssh_directory/key" -p "${DEPLOY_SSH_PORT:-22}"
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$ssh_directory/known_hosts" -o GlobalKnownHostsFile=/dev/null
    -o UpdateHostKeys=no -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=10
    "${DEPLOY_SSH_USER:-deploy}@$DEPLOY_SSH_HOST")
}

upload() {
  local sha="$1" archive="$2" manifest="$3" size_bytes expected_sha256
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "A full lowercase 40-character commit SHA is required" 2
  [[ -f "$archive" && -f "$manifest" ]] || die "Archive and manifest files required" 2

  ssh_setup
  log="$ssh_directory/upload.log"

  size_bytes=$(stat -c %s "$archive")
  expected_sha256=$(sha256sum "$archive" | cut -d' ' -f1)

  echo "Uploading release archive: $(basename "$archive") ($((size_bytes / 1024 / 1024)) MB)"
  echo "SHA256: $expected_sha256"

  # Upload archive via stdin
  local token
  token="slk-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  echo "::stop-commands::$token"
  local status=0
  "${ssh_cmd[@]}" "upload $sha $expected_sha256" < "$archive" 2>&1 | tee "$log" || status="${PIPESTATUS[0]}"
  echo "::$token::"

  if ((status != 0)); then
    output result upload-failed
    die "Upload failed with status $status" "$status"
  fi

  output result uploaded
  echo "✓ Upload successful"
}

remote() {
  local action="$1" sha="$2" status attempt log
  [[ "$action" =~ ^(deploy|rollback)$ ]] || die "Unknown remote action" 2
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "A full lowercase 40-character commit SHA is required" 2

  ssh_setup
  log="$ssh_directory/remote.log"
  local token
  token="slk-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  echo "::stop-commands::$token"
  status=0
  "${ssh_cmd[@]}" "$action $sha" 2>&1 | tee "$log" || status="${PIPESTATUS[0]}"
  # 255 is an SSH transport failure. The release keeps running on the server; reattach.
  for ((attempt = 1; status == 255 && attempt <= 10; attempt++)); do
    echo "SSH connection lost (attempt $attempt); reattaching in 30 seconds"
    sleep 30
    status=0
    "${ssh_cmd[@]}" "wait $sha" 2>&1 | tee "$log" || status="${PIPESTATUS[0]}"
  done
  echo "::$token::"
  if grep -q "WARNING: Host-level files" "$log"; then
    echo "::warning title=Host files changed::Re-run deploy/st/bootstrap-ubuntu.sh as root on the server from this revision."
  fi
  if ((status == 0)); then
    if grep -q "RESULT: already active" "$log"; then
      output result already-active
    elif [[ "$action" == deploy ]]; then
      output result deployed
    else
      output result rolled-back
    fi
    return 0
  fi
  output result failed
  case "$status" in
    1) die "The release failed and the previous release was restored (see the log above)" 1 ;;
    3) die "The server refused the request (see the log above)" 3 ;;
    4) die "The server needs operator attention (see the log above)" 4 ;;
    75) die "Another deployment is running on the server" 75 ;;
    255) die "SSH connection failed (host, port, key or pinned host key)" 255 ;;
    *) die "Remote command failed with status $status" "$status" ;;
  esac
}

snapshot() {
  local file="$1" status attempt token
  [[ -n "$file" && ! -e "$file" ]] || die "The snapshot file must not exist yet" 2
  ssh_setup
  token="slk-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  echo "::stop-commands::$token"
  for ((attempt = 1; attempt <= 6; attempt++)); do
    status=0
    "${ssh_cmd[@]}" snapshot > "$file" || status=$?
    ((status == 75)) || break
    echo "A deployment is running on the server; retrying in 60 seconds"
    sleep 60
  done
  echo "::$token::"
  if ((status != 0)); then
    rm -f "$file"
    case "$status" in
      3) die "The server refused the snapshot request (see the log above)" 3 ;;
      4) die "The snapshot failed on the server (see the log above)" 4 ;;
      75) die "Deployments kept the server busy; no snapshot" 75 ;;
      255) die "SSH connection failed (host, port, key or pinned host key)" 255 ;;
      *) die "The snapshot failed with status $status (see the log above)" "$status" ;;
    esac
  fi
  [[ "$(tar -tf "$file" | sort | tr '\n' ' ')" == "database.dump manifest.json uploads.tar " ]] ||
    die "The snapshot is incomplete"
  echo "Snapshot of $(($(stat -c %s "$file") / 1024 / 1024)) MB: $(tar -xOf "$file" manifest.json)"
}

smoke() {
  local site="$1" cms="$2" expected_sha="${3:-}" url response actual_sha
  [[ "$site" =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ && "$cms" =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ ]] ||
    die "Public origins must be https://host origins" 2

  # The website of a staging environment is password protected; the CMS keeps its own login.
  local site_auth=()
  [[ -z "${SMOKE_BASIC_AUTH:-}" ]] || site_auth=(--user "$SMOKE_BASIC_AUTH")
  for url in "$site/" "$site/api/public/site-layout" "$cms/server/health"; do
    echo "GET $url"
    local auth=()
    [[ "$url" != "$site/"* ]] || auth=("${site_auth[@]}")
    curl --fail --silent --show-error --output /dev/null --retry 10 --retry-all-errors --retry-delay 6 \
      --connect-timeout 10 --max-time 30 --proto '=https' "${auth[@]}" "$url" || die "Public check failed: $url"
  done

  if [[ -n "$expected_sha" ]]; then
    echo "GET $site/api/version"
    response=$(curl --fail --silent --show-error --retry 5 --retry-delay 3 \
      --connect-timeout 10 --max-time 20 --proto '=https' "${site_auth[@]}" "$site/api/version")
    actual_sha=$(echo "$response" | grep -oP '"commit"\s*:\s*"\K[0-9a-f]{40}')
    if [[ "$actual_sha" != "$expected_sha" ]]; then
      die "Version mismatch: expected $expected_sha, got $actual_sha" 1
    fi
    echo "✓ Version endpoint reports commit $actual_sha"
  fi
}

case "${1:-}" in
  upload) [[ $# == 4 ]] || die "Usage: upload <commit> <archive> <manifest>" 2; upload "$2" "$3" "$4" ;;
  deploy) [[ $# == 2 ]] || die "Usage: deploy <commit>" 2; remote deploy "$2" ;;
  rollback) [[ $# == 2 ]] || die "Usage: rollback <commit>" 2; remote rollback "$2" ;;
  smoke)
    if [[ $# == 3 ]]; then
      smoke "$2" "$3"
    elif [[ $# == 4 ]]; then
      smoke "$2" "$3" "$4"
    else
      die "Usage: smoke <site-origin> <cms-origin> [<expected-sha>]" 2
    fi
    ;;
  snapshot) [[ $# == 2 ]] || die "Usage: snapshot <file>" 2; snapshot "$2" ;;
  *) die "Usage: ci-deploy.sh upload|deploy|rollback|smoke|snapshot ..." 2 ;;
esac
