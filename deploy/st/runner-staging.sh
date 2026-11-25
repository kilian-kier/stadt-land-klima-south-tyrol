#!/usr/bin/env bash
# Steps of the staging job in st-release.yml (docs/st/STAGING.md). The GitHub runner becomes a
# short-lived server: bootstrap-ubuntu.sh installs the release exactly as on production, with the
# anonymized production snapshot as data, the private gateway CA and a password-protected website.
# Two Cloudflare quick tunnels make the website and the CMS reachable under random
# https://*.trycloudflare.com names; nothing has to be configured at Cloudflare.
#
#   runner-staging.sh prepare <commit>          runner fixes, stand-in repository, review clone
#   runner-staging.sh tunnels                   start both tunnels; outputs site and cms origins
#   runner-staging.sh bootstrap <commit> <release dir> <snapshot>   install the staging server
#   runner-staging.sh publish <environment> <site>  show the address on this job's deployment
#   runner-staging.sh serve <hours>             keep serving until production finishes or <hours>
#   runner-staging.sh diagnostics               logs after a failure
#
# Environment: STAGING_PASSWORD (website password, user "staging"), GITHUB_TOKEN for serve.
set -Eeuo pipefail
trap 'slk_status=$?; echo "::error title=Staging command failed::line $LINENO: $BASH_COMMAND (status $slk_status)"' ERR

state="${RUNNER_TEMP:?}/staging"
origin=/srv/slk-staging/origin.git
cloudflared_version=2026.11.2
cloudflared_sha256=56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf
mkdir -p "$state"

say() { printf '\n--- %s\n' "$*"; }
fail() {
  echo "::error title=Staging::$*"
  exit 1
}
output() { [[ -z "${GITHUB_OUTPUT:-}" ]] || printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }

prepare() {
  local sha="$1" file pattern
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "A full commit SHA is required"
  df -h / "$RUNNER_TEMP"
  say "The runner image's container engine settings would make the bootstrap refuse the host"
  sudo systemctl disable --now docker.service docker.socket containerd.service > /dev/null 2>&1 || true
  if [[ -e /etc/containers/containers.conf.d/99-fix-firewall.conf ]]; then
    sudo mv /etc/containers/containers.conf.d/99-fix-firewall.conf "$state/"
  fi
  if [[ -e /usr/share/containers/seccomp.json ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --reinstall \
      "$(dpkg -S /usr/share/containers/seccomp.json | cut -d: -f1)" > /dev/null
    sudo chmod 0644 /usr/share/containers/seccomp.json
  fi
  sudo setfacl -k /home 2> /dev/null || true
  pattern='^[[:space:]]*(export[[:space:]]+)?(XDG_[A-Z_]+|HOME)[[:space:]]*='
  for file in $(sudo grep -lsE "$pattern" /etc/environment /etc/environment.d/* /etc/security/pam_env.conf || true); do
    sudo sed -i -E "/$pattern/d" "$file"
  done

  say "A local stand-in for the repository, whose main is the released commit"
  sudo install -d -m 0755 /srv/slk-staging
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$origin"
  git init --quiet --bare --initial-branch=main "$origin"
  git -C "$GITHUB_WORKSPACE" push --quiet "$origin" "$sha:refs/heads/main"
  # The account exists before the bootstrap so that it may read the local repository.
  sudo useradd --create-home --user-group --shell /bin/bash deploy
  sudo setfacl -R -b /home/deploy 2> /dev/null || true
  printf '[safe]\n\tdirectory = %s\n' "$origin" | sudo -u deploy tee /home/deploy/.gitconfig > /dev/null
  say "A root-owned clone to run the bootstrap from, as on the server"
  git clone --quiet --no-hardlinks "$origin" "$state/slk-host"
  git -C "$state/slk-host" -c advice.detachedHead=false checkout --quiet --detach "$sha"
  sudo cp -a "$state/slk-host" /root/slk-host
  sudo chown -R root:root /root/slk-host
  rm -rf "$state/slk-host"
}

tunnels() {
  local name i url
  say "Cloudflare quick tunnels for the website and the CMS"
  curl --fail --silent --show-error --location --retry 5 --output "$state/cloudflared" \
    "https://github.com/cloudflare/cloudflared/releases/download/$cloudflared_version/cloudflared-linux-amd64"
  echo "$cloudflared_sha256  $state/cloudflared" | sha256sum --quiet --check || fail "cloudflared hash mismatch"
  sudo install -m 0755 "$state/cloudflared" /usr/local/bin/cloudflared
  for name in site cms; do
    # The gateway does not exist yet; the tunnel forwards to it once it does. Visitors' Host
    # headers pass through; the gateway's default_sni answers the connection without SNI.
    nohup /usr/local/bin/cloudflared tunnel --no-autoupdate --url https://127.0.0.1:443 --no-tls-verify \
      > "$state/tunnel-$name.log" 2>&1 &
    echo $! > "$state/tunnel-$name.pid"
  done
  for name in site cms; do
    url=""
    for ((i = 0; i < 60; i++)); do
      url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$state/tunnel-$name.log" | head -n 1 || true)"
      [[ -n "$url" ]] && break
      sleep 2
    done
    [[ -n "$url" ]] || { cat "$state/tunnel-$name.log"; fail "The $name tunnel did not start"; }
    echo "$name: $url"
    printf '%s\n' "$url" > "$state/$name-origin"
    output "$name" "$url"
  done
  [[ "$(cat "$state/site-origin")" != "$(cat "$state/cms-origin")" ]] || fail "Both tunnels got the same name"
}

bootstrap() {
  local sha="$1" release="$2" snapshot="$3" site cms password_file
  site="$(cat "$state/site-origin")"
  cms="$(cat "$state/cms-origin")"
  [[ -n "${STAGING_PASSWORD:-}" ]] || fail "The staging environment lacks the secret STAGING_PASSWORD"
  password_file="$(sudo mktemp /root/staging-password.XXXXXX)"
  printf '%s\n' "$STAGING_PASSWORD" | sudo tee "$password_file" > /dev/null
  say "Bootstrap with the release $sha and the anonymized snapshot"
  if ! sudo /root/slk-host/deploy/st/bootstrap-ubuntu.sh --site-host "${site#https://}" --cms-host "${cms#https://}" \
    --admin-email staging@example.invalid --tls-internal --repo-url "$origin" \
    --archive "$release/release-$sha.tar.zst" --manifest "$release/release-$sha.manifest.json" \
    --snapshot "$snapshot" --site-password-file "$password_file" > "$state/bootstrap.log" 2>&1; then
    sudo rm -f "$password_file"
    tail -n 150 "$state/bootstrap.log"
    fail "The bootstrap failed (log above)"
  fi
  sudo rm -f "$password_file"
  # The full log names the generated administrator only by its placeholder address.
  cat "$state/bootstrap.log"
  # Staging never sends backups anywhere and must not prune anything while it serves.
  sudo systemctl stop staedtechallenge-backup.timer 2> /dev/null || true
}

# The run summary and annotations only appear when the job has ended, so the address is also
# set on this job's deployment, which the run page and Deployments show right away.
publish() {
  local environment="$1" site="$2" api deployment
  api="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY"
  deployment="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${GITHUB_TOKEN:?}" \
    -H "Accept: application/vnd.github+json" "$api/deployments?environment=$environment&sha=$GITHUB_SHA&per_page=1" |
    jq -r '.[0].id // empty')" || true
  if [[ ! "$deployment" =~ ^[0-9]+$ ]]; then
    echo "::warning title=Staging::No deployment of the $environment environment found; the address is in this job's log"
    return 0
  fi
  jq -n --arg url "$site" --arg log "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
    '{state: "in_progress", environment_url: $url, log_url: $log, auto_inactive: false}' |
    curl --fail --silent --show-error --max-time 30 -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" --data @- "$api/deployments/$deployment/statuses" > /dev/null ||
    echo "::warning title=Staging::Setting the address on the deployment failed; it is in this job's log"
  echo "Website: $site"
}

serve() {
  local hours="$1" deadline jobs production name pid
  [[ "$hours" =~ ^[1-5]$ ]] || fail "Serve for 1 to 5 hours"
  deadline=$(($(date +%s) + hours * 3600))
  say "Serving until the production job of this run has finished, at most $hours h"
  while (($(date +%s) < deadline)); do
    for name in site cms; do
      pid="$(cat "$state/tunnel-$name.pid")"
      kill -0 "$pid" 2> /dev/null || { tail -n 30 "$state/tunnel-$name.log"; fail "The $name tunnel stopped"; }
    done
    jobs="$(curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer ${GITHUB_TOKEN:?}" \
      -H "Accept: application/vnd.github+json" \
      "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100" || true)"
    production=unknown
    [[ -z "$jobs" ]] ||
      production="$(jq -r '[.jobs[]? | select(.name == "production")][0].status // "absent"' <<< "$jobs" 2> /dev/null || echo unknown)"
    if [[ "$production" == completed ]]; then
      echo "The production job has finished; staging ends"
      return 0
    fi
    sleep 60
  done
  echo "Staging served for $hours h; it ends now"
}

diagnostics() {
  local name
  for name in site cms; do
    [[ -f "$state/tunnel-$name.log" ]] && tail -n 40 "$state/tunnel-$name.log"
  done
  [[ -f "$state/bootstrap.log" ]] && tail -n 200 "$state/bootstrap.log"
  sudo -u deploy env XDG_RUNTIME_DIR="/run/user/$(id -u deploy 2> /dev/null || echo 0)" \
    aa-exec -p slk-rootless -- podman --remote=false ps -a 2> /dev/null || true
  sudo journalctl -u caddy --no-pager -n 60 2> /dev/null || true
}

case "${1:-}" in
  prepare) prepare "${2:?}" ;;
  tunnels) tunnels ;;
  bootstrap) bootstrap "${2:?}" "${3:?}" "${4:?}" ;;
  publish) publish "${2:?}" "${3:?}" ;;
  serve) serve "${2:?}" ;;
  diagnostics) diagnostics ;;
  *) fail "Usage: runner-staging.sh prepare|tunnels|bootstrap|publish|serve|diagnostics" ;;
esac
