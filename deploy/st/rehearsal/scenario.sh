#!/usr/bin/env bash
# Steps of .github/workflows/st-deploy-rehearsal.yml. The GitHub runner plays a fresh
# Ubuntu server: a local bare repository stands in for the st on GitHub, and the CI
# side talks to the server only through ssh 127.0.0.1 with the restricted key, exactly
# as st-deploy.yml does (deploy/st/ci-deploy.sh).
set -Eeuo pipefail
# Failing commands become annotations: job logs are not readable without authentication.
trap 'slk_status=$?; echo "::error title=Rehearsal command failed::line $LINENO: $BASH_COMMAND (status $slk_status)"' ERR

site=www.slk-rehearsal.test
cms=cms.slk-rehearsal.test
origin=/srv/slk-rehearsal/origin.git
work="$RUNNER_TEMP/rehearsal-work"
keys="$RUNNER_TEMP/rehearsal-keys"
state="$RUNNER_TEMP/rehearsal-state"
workspace="${GITHUB_WORKSPACE:?}"
mkdir -p "$state"

say() { printf '\n--- %s\n' "$*"; }
# Print a log and emit its tail as an annotation (newlines encoded for workflow commands).
annotate() {
  local title="$1" file="$2"
  sudo cat "$file" 2> /dev/null || true
  echo "::error title=$title::$(sudo tail -n 45 "$file" 2> /dev/null | encode)"
}
# Annotation text: printable characters only, bounded lines, encoded newlines.
encode() {
  tr -d '\000-\010\013-\037' | cut -c 1-240 | sed -e 's/%/%25/g' | sed -e ':a;N;$!ba;s/\n/%0A/g'
}
fail() {
  echo "::error title=Rehearsal::$*"
  exit 1
}
# Podman as the deployment account, the way its own services run it: its runtime
# directory and the inherited slk-rootless AppArmor profile.
deploy_podman() {
  (cd / && sudo -u deploy env XDG_RUNTIME_DIR="/run/user/$(id -u deploy)"     aa-exec -p slk-rootless -- podman --remote=false "$@")
}

remember() { printf '%s\n' "$2" > "$state/$1"; }
recall() { cat "$state/$1"; }

connection() {
  export DEPLOY_SSH_HOST=127.0.0.1 DEPLOY_SSH_PORT=22 DEPLOY_SSH_USER=deploy
  DEPLOY_KNOWN_HOSTS="$(cat "$keys/known_hosts")"
  DEPLOY_SSH_KEY="$(cat "$keys/ci_key")"
  export DEPLOY_KNOWN_HOSTS DEPLOY_SSH_KEY
}

# Run a ci-deploy.sh action and require a specific exit status.
expect() {
  local expected="$1" status=0
  shift
  connection
  bash "$workspace/deploy/st/ci-deploy.sh" "$@" || status=$?
  ((status == expected)) || fail "Expected exit status $expected from '$*', got $status"
  echo "Exit status $status as expected"
}

served() {
  local path="$1" expected="$2" body
  body="$(curl --fail --silent --show-error --max-time 30 "https://$site$path")" || fail "GET https://$site$path failed"
  [[ "$body" == "$expected" ]] || fail "https://$site$path served '$body', expected '$expected'"
  echo "https://$site$path serves '$expected'"
}

not_served() {
  local code
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 30 "https://$site$1")"
  [[ "$code" == 404 ]] || fail "https://$site$1 returned $code, expected 404"
  echo "https://$site$1 is absent (404)"
}

active() {
  local result
  connection
  result="$(ssh -F /dev/null -i "$keys/ci_key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$keys/known_hosts" deploy@127.0.0.1 status | sed -n 's/^active=//p')"
  [[ "$result" == "$1" ]] || fail "Server reports active release '$result', expected $1"
  echo "Server reports active release $1"
}

commit_on_main() {
  local name="$1" message="$2"
  shift 2
  git -C "$work" fetch --quiet origin main
  git -C "$work" checkout --quiet --detach origin/main
  "$@"
  git -C "$work" add -A
  git -C "$work" -c user.name="Deployment rehearsal" -c user.email=rehearsal@example.invalid commit --quiet -m "$message"
  git -C "$work" push --quiet origin HEAD:refs/heads/main
  remember "$name" "$(git -C "$work" rev-parse HEAD)"
  echo "Commit $name = $(recall "$name") is now origin/main"
}

# Build and upload a release for a commit (cached by SHA to avoid rebuilding).
# Every deploy now requires a prior upload since the 2GB server never builds.
# Build a release the way CI does: a clean tree of exactly <sha>, built on the runner side.
# A throwaway worktree keeps $workspace (and this running script) on the branch head.
build_at() {
  local sha="$1" log="$2" tree="$state/tree-$1" status=0
  git -C "$workspace" worktree remove --force "$tree" 2> /dev/null || true
  # Release commits are created in the stand-in repository; make them available here.
  git -C "$workspace" fetch --quiet "$origin" "+refs/heads/*:refs/rehearsal/*"
  git -C "$workspace" worktree add --quiet --detach "$tree" "$sha"
  if (cd "$tree" && bash "$workspace/deploy/st/build-release.sh" "$sha" "$state") > "$log" 2>&1; then
    status=0
  else
    status=$?
  fi
  git -C "$workspace" worktree remove --force "$tree"
  return "$status"
}

release() {
  local name="$1" sha
  sha="$(recall "$name")"
  local tag="release-$sha"
  local archive="$state/$tag.tar.zst"
  local manifest="$state/$tag.manifest.json"

  # Build if not cached
  if [[ ! -f "$archive" || ! -f "$manifest" ]]; then
    say "Building release $name ($sha) on runner..."
    build_at "$sha" "$state/build-$name.log" || {
      annotate "Build log for $name" "$state/build-$name.log"
      fail "Build failed for $name"
    }
    [[ -f "$archive" && -f "$manifest" ]] || fail "Archive or manifest not created for $name"
  else
    echo "Using cached build for $name ($sha)"
  fi

  # Upload to server
  connection
  bash "$workspace/deploy/st/ci-deploy.sh" upload "$sha" "$archive" "$manifest" ||
    fail "Upload failed for $name"
  echo "Released $name ($sha) to server"
}

prepare() {
  say "Runner disk space (the VM has enough for several release image sets)"
  df -h /
  say "Local stand-in for the GitHub st: a bare repository whose main is commit A"
  remember A "$(git -C "$workspace" rev-parse HEAD)"
  sudo install -d -m 0755 /srv/slk-rehearsal
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$origin"
  git init --quiet --bare --initial-branch=main "$origin"
  git -C "$workspace" push --quiet "$origin" "$(recall A):refs/heads/main"
  git clone --quiet "$origin" "$work"
  # The account exists before bootstrap (bootstrap accepts it) so it may read this local repository.
  sudo useradd --create-home --user-group --shell /bin/bash deploy
  printf '[safe]\n\tdirectory = %s\n' "$origin" | sudo -u deploy tee /home/deploy/.gitconfig > /dev/null
  say "A root-owned review clone, as the owner would create it"
  # It lives in /root: the runner image makes /opt group-writable, which the bootstrap refuses.
  # Git refuses repositories owned by another account, so copy a clone and hand it to root.
  git clone --quiet --no-hardlinks "$origin" "$RUNNER_TEMP/slk-host"
  git -C "$RUNNER_TEMP/slk-host" -c advice.detachedHead=false checkout --quiet --detach "$(recall A)"
  sudo cp -a "$RUNNER_TEMP/slk-host" /root/slk-host
  sudo chown -R root:root /root/slk-host
  sudo git -C /root/slk-host status --porcelain
  # The runner image ships an unpackaged engine drop-in for Docker coexistence. The bootstrap
  # refuses it (see "leftovers"); here it is moved aside as the documentation tells the owner.
  if [[ -e /etc/containers/containers.conf.d/99-fix-firewall.conf ]]; then
    sudo cat /etc/containers/containers.conf.d/99-fix-firewall.conf
    sudo mv /etc/containers/containers.conf.d/99-fix-firewall.conf /root/
  fi
  # The runner image also leaves the engine's default seccomp profile world-writable, which the
  # bootstrap refuses; restore the packaged file and mode as its message instructs.
  if [[ -e /usr/share/containers/seccomp.json ]]; then
    ls -l /usr/share/containers/seccomp.json
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --reinstall \
      "$(dpkg -S /usr/share/containers/seccomp.json | cut -d: -f1)" > /dev/null
    sudo chmod 0644 /usr/share/containers/seccomp.json
  fi
  say "Local names and the CI deployment key"
  printf '127.0.0.1 %s %s\n' "$site" "$cms" | sudo tee -a /etc/hosts > /dev/null
  mkdir -p "$keys"
  chmod 700 "$keys"
  ssh-keygen -q -t ed25519 -N '' -C ci -f "$keys/ci_key"
}

leftovers() {
  say "Leftovers of an upgraded host (running Docker, stray engine configuration) stop the bootstrap"
  sudo systemctl start docker.service
  sudo -u deploy mkdir -p /home/deploy/.config/containers
  printf '[storage]\ndriver = "vfs"\n' | sudo -u deploy tee /home/deploy/.config/containers/storage.conf > /dev/null
  local status=0
  sudo /root/slk-host/deploy/st/bootstrap-ubuntu.sh --site-host "$site" --cms-host "$cms"     --admin-email admin@example.org --tls-internal --repo-url "$origin" > "$state/leftovers.log" 2>&1 || status=$?
  cat "$state/leftovers.log"
  ((status == 1)) || fail "The bootstrap returned $status on a host with leftovers"
  grep -q "Docker is running" "$state/leftovers.log" || fail "Running Docker was not reported"
  grep -q "containers/storage.conf overrides" "$state/leftovers.log" || fail "The stray configuration was not reported"
  grep -q "/home carries POSIX ACLs" "$state/leftovers.log" || fail "The inherited ACL was not reported"
  ! sudo test -e /etc/slk-st || fail "The bootstrap changed the host before refusing"
  say "Apply the documented fixes"
  sudo systemctl disable --now docker.service docker.socket containerd.service > /dev/null
  sudo rm -r /home/deploy/.config/containers
  # The runner image gives /home a default ACL for its own account (uid 1001).
  sudo setfacl -k /home
  sudo setfacl -R -b /home/deploy
  # The runner image sets XDG_* (and possibly HOME) for its own account globally; the bootstrap refuses it.
  grep -q "is set globally in" "$state/leftovers.log" || fail "The global environment settings were not reported"
  local file pattern='^[[:space:]]*(export[[:space:]]+)?(XDG_[A-Z_]+|HOME)[[:space:]]*='
  for file in $(sudo grep -lsE "$pattern" /etc/environment /etc/environment.d/* /etc/security/pam_env.conf || true); do
    echo "Removing global assignments from $file:"
    sudo grep -E "$pattern" "$file" | cut -d= -f1
    sudo sed -i -E "/$pattern/d" "$file"
  done
}

bootstrap() {
  say "Build release A on runner for prebuilt bootstrap (server never builds)"
  local sha_a="$(recall A)"
  local tag_a="release-$sha_a"
  local archive_a="$state/$tag_a.tar.zst"
  local manifest_a="$state/$tag_a.manifest.json"

  build_at "$sha_a" "$state/build-A.log" ||
    { annotate "Build A log" "$state/build-A.log"; fail "Build A failed"; }
  [[ -f "$archive_a" && -f "$manifest_a" ]] || fail "Archive or manifest for A not created"

  say "Bootstrap a fresh Ubuntu server with prebuilt images (packages, account, AppArmor, firewall, first start, gateway)"
  if ! sudo /root/slk-host/deploy/st/bootstrap-ubuntu.sh --site-host "$site" --cms-host "$cms" \
    --admin-email admin@example.org --tls-internal --repo-url "$origin" \
    --ci-public-key "$keys/ci_key.pub" --ci-from 127.0.0.1,::1 \
    --archive "$archive_a" --manifest "$manifest_a" --cloudflare-proxy > "$RUNNER_TEMP/bootstrap.log" 2>&1; then
    annotate "Bootstrap log" "$RUNNER_TEMP/bootstrap.log"
    fail "The bootstrap failed"
  fi
  cat "$RUNNER_TEMP/bootstrap.log"
  say "Trust the rehearsal gateway CA on the CI side and pin the server's host key"
  sudo install -m 0644 /etc/slk-st/gateway-ca.crt /usr/local/share/ca-certificates/slk-rehearsal.crt
  sudo update-ca-certificates > /dev/null
  printf '127.0.0.1 %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > "$keys/known_hosts"
  say "Idempotency: a second bootstrap run changes nothing that is deployed"
  sudo /root/slk-host/deploy/st/bootstrap-ubuntu.sh --site-host "$site" --cms-host "$cms" \
    --admin-email admin@example.org --tls-internal --repo-url "$origin" \
    --ci-public-key "$keys/ci_key.pub" --ci-from 127.0.0.1,::1 \
    --archive "$archive_a" --manifest "$manifest_a" --cloudflare-proxy > "$RUNNER_TEMP/bootstrap-again.log" 2>&1 ||
    { annotate "Second bootstrap log" "$RUNNER_TEMP/bootstrap-again.log"; fail "The second bootstrap run failed"; }
  sudo grep -c ' slk-st-ci$' /home/deploy/.ssh/authorized_keys | grep -qx 1 || fail "The CI key was installed twice"
  # The nightly backup (03:30 Europe/Berlin) also prunes release images; a run that crosses that
  # time would remove images the rollback scenarios need. The backup scenario starts it explicitly.
  sudo systemctl stop staedtechallenge-backup.timer

  sudo grep -qE '^[[:space:]]+trusted_proxies static 173[.]245[.]48[.]0/20 ' /etc/caddy/servers.d/cloudflare.caddy ||
    fail "--cloudflare-proxy did not install the trusted Cloudflare ranges"
  # The server must run exactly the images built on the runner side, not rebuilt ones.
  local service expected loaded
  for service in database meilisearch directus frontend maintenance; do
    expected="$(jq -r ".images.application.$service.id" "$manifest_a")"
    loaded="$(deploy_podman image inspect --format '{{.Id}}' \
      "localhost/slk-podman-$service:$tag_a" || true)"
    [[ -n "$expected" && "$loaded" == "$expected" ]] ||
      fail "The server's $service image ($loaded) is not the uploaded one ($expected)"
  done
  echo "✓ The server runs exactly the images built on the runner side"

  expect 0 smoke "https://$site" "https://$cms"
  # The release protocol snapshots the published homepage before each activation.
  local code
  code="$(curl --silent --output "$state/homepage.json" --write-out '%{http_code}' "https://$site/api/public/pages/index")"
  [[ "$code" == 200 ]] || { head -c 600 "$state/homepage.json"; fail "The homepage API returned $code"; }
  active "$(recall A)"
}

restricted() {
  say "The CI key only reaches the forced command"
  local ssh=(ssh -F /dev/null -i "$keys/ci_key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$keys/known_hosts")
  local request status
  for request in "id" "deploy abc" "deploy $(recall A); id" "status && id" "bash -i" "wait ../../etc/passwd"; do
    status=0
    "${ssh[@]}" deploy@127.0.0.1 "$request" > "$state/out" 2>&1 || status=$?
    ((status == 2)) || fail "Request '$request' returned $status, expected the usage error 2"
    ! grep -q "uid=" "$state/out" || fail "Request '$request' executed a command"
  done
  local forward
  "${ssh[@]}" -N -o ExitOnForwardFailure=yes -L 127.0.0.1:19001:127.0.0.1:9001 deploy@127.0.0.1 > /dev/null 2>&1 &
  forward=$!
  sleep 5
  if curl --silent --max-time 5 http://127.0.0.1:19001/server/health > /dev/null; then fail "Port forwarding is possible"; fi
  kill "$forward" 2> /dev/null || true
  status=0
  "${ssh[@]}" root@127.0.0.1 status > /dev/null 2>&1 || status=$?
  ((status == 255)) || fail "The CI key authenticated as root"
  echo "Shell commands, malformed requests, port forwarding and other accounts are refused"
}

deploy_unchanged() {
  say "Deploying the active commit is a health-checked no-op"
  release A
  expect 0 deploy "$(recall A)"
}

deploy_update() {
  say "Commit B changes visible content; deploy it like st-deploy.yml"
  add_marker() { printf 'rehearsal-B\n' > "$work/src/frontend/public/st-rehearsal.txt"; }
  commit_on_main B "Rehearsal: publish a release marker" add_marker
  not_served /st-rehearsal.txt
  release B
  expect 0 deploy "$(recall B)"
  expect 0 smoke "https://$site" "https://$cms"
  served /st-rehearsal.txt rehearsal-B
  active "$(recall B)"
}

deploy_broken() {
  say "Commit C passes staging but fails during activation; the protocol must restore B"
  break_import() {
    sed -i 's/^set -euo pipefail$/set -euo pipefail\necho "Rehearsal: simulated failing configuration import" >\&2\nexit 1/' \
      "$work/src/directus/cli/import-all.sh"
    grep -q "simulated failing" "$work/src/directus/cli/import-all.sh"
    printf 'rehearsal-C\n' > "$work/src/frontend/public/st-rehearsal.txt"
  }
  commit_on_main C "Rehearsal: break the configuration import" break_import
  release C
  DEPLOY_ANNOTATE=false expect 1 deploy "$(recall C)"
  expect 0 smoke "https://$site" "https://$cms"
  served /st-rehearsal.txt rehearsal-B
  active "$(recall B)"
  # The glob must expand as root: the run logs are private to the deployment account.
  sudo bash -c 'grep -q "simulated failing configuration import" /home/deploy/.local/state/slk-st/runs/*-deploy-"$1".log' \
    _ "$(recall C)" ||
    fail "The failure did not come from the broken import"
}

refuse_foreign() {
  say "A commit that is not contained in main is refused before anything changes"
  git -C "$work" checkout --quiet --detach "$(recall B)"
  printf 'rehearsal-D\n' > "$work/src/frontend/public/st-rehearsal.txt"
  git -C "$work" -c user.name="Deployment rehearsal" -c user.email=rehearsal@example.invalid \
    commit --quiet -am "Rehearsal: unreviewed side branch"
  git -C "$work" push --quiet origin HEAD:refs/heads/unreviewed
  remember D "$(git -C "$work" rev-parse HEAD)"
  # The server already refuses to accept an upload of D, and a deploy of it.
  local sha_d archive_d
  sha_d="$(recall D)"
  archive_d="$state/release-$sha_d.tar.zst"
  build_at "$sha_d" "$state/build-D.log" || { annotate "Build log for D" "$state/build-D.log"; fail "Build failed for D"; }
  DEPLOY_ANNOTATE=false expect 3 upload "$sha_d" "$archive_d" "$state/release-$sha_d.manifest.json"
  DEPLOY_ANNOTATE=false expect 3 deploy "$sha_d"
  # Zero SHA and old commits without fresh upload should also be refused
  DEPLOY_ANNOTATE=false expect 3 deploy "$(printf '%040d' 0)"
  DEPLOY_ANNOTATE=false expect 3 deploy "$(recall A)"
  served /st-rehearsal.txt rehearsal-B
  active "$(recall B)"
}

rollback_release() {
  say "A CI-requested rollback (as after failed public checks) restores A"
  # Note: rollback doesn't need prior upload, it restores an already-deployed release
  DEPLOY_ANNOTATE=false expect 3 rollback "$(recall A)"
  expect 0 rollback "$(recall B)"
  expect 0 smoke "https://$site" "https://$cms"
  not_served /st-rehearsal.txt
  active "$(recall A)"
}

redeploy() {
  say "Redeploying B after its rollback uses a fresh release record"
  release B
  expect 0 deploy "$(recall B)"
  served /st-rehearsal.txt rehearsal-B
  active "$(recall B)"
}

build_on_runner() {
  say "Build release on runner (STEP 3: prebuilt images, never built on 2GB server)"
  # Commit E: add a new marker for the prebuilt flow
  # E also repairs the import that C broke (main still contains C), as a real follow-up release would.
  add_prebuilt_marker() {
    git -C "$work" checkout --quiet "$(recall B)" -- src/directus/cli/import-all.sh
    printf 'rehearsal-E-prebuilt\n' > "$work/src/frontend/public/st-rehearsal-prebuilt.txt"
  }
  commit_on_main E "Rehearsal: test prebuilt release pipeline" add_prebuilt_marker

  # Build on runner with build-release.sh (like GitHub Actions would)
  local sha="$(recall E)"
  local tag="release-$sha"
  local archive="$state/$tag.tar.zst"
  local manifest="$state/$tag.manifest.json"

  say "Building 9 images with revision labels..."
  build_at "$sha" "$state/build.log" || {
    annotate "Build log" "$state/build.log"
    fail "Build failed"
  }

  [[ -f "$archive" ]] || fail "Archive not created"
  [[ -f "$manifest" ]] || fail "Manifest not created"

  local size=$(stat -c %s "$archive")
  say "Archive created: $(numfmt --to=iec-i --suffix=B $size)"

  # Verify manifest contains expected images
  grep -q '"directus"' "$manifest" || fail "Manifest missing directus"
  grep -q '"frontend"' "$manifest" || fail "Manifest missing frontend"
  grep -q "\"$sha\"" "$manifest" || fail "Manifest missing sha"
}

upload_and_deploy() {
  say "Upload prebuilt archive and deploy (server never builds)"
  local sha="$(recall E)"
  local tag="release-$sha"
  local archive="$state/$tag.tar.zst"
  local manifest="$state/$tag.manifest.json"

  # Upload via ci-deploy.sh (using the archive built in build_on_runner)
  connection
  bash "$workspace/deploy/st/ci-deploy.sh" upload "$sha" "$archive" "$manifest" ||
    fail "Upload failed for E"

  # Deploy using the uploaded images
  not_served /st-rehearsal-prebuilt.txt
  expect 0 deploy "$sha"
  expect 0 smoke "https://$site" "https://$cms"
  served /st-rehearsal-prebuilt.txt rehearsal-E-prebuilt
  active "$sha"
}

refused_tampered_upload() {
  say "Tampered upload is refused (sha256 or revision label mismatch)"
  # Commit F: another marker
  add_tamper_marker() { printf 'rehearsal-F-tamper\n' > "$work/src/frontend/public/st-rehearsal-tamper.txt"; }
  commit_on_main F "Rehearsal: test tamper detection" add_tamper_marker

  local sha="$(recall F)"
  local tag="release-$sha"
  local archive="$state/$tag.tar.zst"
  local manifest="$state/$tag.manifest.json"

  # Build the real archive first
  build_at "$sha" "$state/build-tamper.log" ||
    { annotate "Build log" "$state/build-tamper.log"; fail "Build failed"; }

  # Tamper with the archive: append garbage
  echo "TAMPERED" >> "$archive"

  # Upload attempt should fail (sha256 mismatch)
  connection
  local status=0
  bash "$workspace/deploy/st/ci-deploy.sh" upload "$sha" "$archive" "$manifest" 2>&1 || status=$?
  ((status == 3)) || {
    # If sha256 passes (shouldn't), deploy should still refuse (revision label mismatch)
    DEPLOY_ANNOTATE=false expect 3 deploy "$sha"
  }
  [[ $status == 3 ]] || fail "Expected upload to be refused with status 3, got $status"
  echo "Tampered upload refused as expected"

  # Previous release still active
  served /st-rehearsal-prebuilt.txt rehearsal-E-prebuilt
  active "$(recall E)"
}

refused_no_upload() {
  say "Deploy without upload is refused (server never builds, exit 3)"
  # Commit G: marker without any upload
  add_no_upload_marker() { printf 'rehearsal-G-noupload\n' > "$work/src/frontend/public/st-rehearsal-noupload.txt"; }
  commit_on_main G "Rehearsal: test refused deploy without upload" add_no_upload_marker

  local sha="$(recall G)"

  # Attempt deploy without uploading first
  DEPLOY_ANNOTATE=false expect 3 deploy "$sha"

  # The refusal names the missing upload and the reason (the run logs are private to the deploy account).
  sudo bash -c 'grep -h "No prebuilt release archive uploaded" /home/deploy/.local/state/slk-st/runs/*-deploy-"$1".log'     _ "$sha" | grep -q "never builds application images" || fail "The refusal does not explain the missing upload"

  # Previous release still active
  served /st-rehearsal-prebuilt.txt rehearsal-E-prebuilt
  active "$(recall E)"
}

memory_sampling() {
  say "The stack stays below 1.6 GB of memory during a real release and afterwards (2 GB server)"
  add_memory_marker() { printf 'rehearsal-H\n' > "$work/src/frontend/public/st-rehearsal-memory.txt"; }
  commit_on_main H "Rehearsal: measure memory during a release" add_memory_marker
  release H
  sudo bash "$workspace/deploy/st/sample-memory.sh" start "$state/memory" deploy
  expect 0 deploy "$(recall H)"
  served /st-rehearsal-memory.txt rehearsal-H
  sleep 60
  sudo bash "$workspace/deploy/st/sample-memory.sh" stop "$state/memory" 1638 ||
    fail "The stack exceeded 1.6 GB of memory, or nothing was measured"
  active "$(recall H)"
}

cloudflare_ranges() {
  say "deploy/st/cloudflare-ips.txt matches the ranges Cloudflare publishes"
  local published pinned
  published="$( { curl --fail --silent --show-error https://www.cloudflare.com/ips-v4; echo
    curl --fail --silent --show-error https://www.cloudflare.com/ips-v6; echo; } | tr -d '\r' | grep -v '^$' | sort)"
  pinned="$(grep -vE '^[[:space:]]*(#|$)' "$workspace/deploy/st/cloudflare-ips.txt" | sort)"
  [[ "$published" == "$pinned" ]] ||
    fail "Cloudflare changed its address ranges; update deploy/st/cloudflare-ips.txt: $(diff <(echo "$pinned") <(echo "$published") | tr '\n' ' ')"
  echo "The pinned list is current"
}

backup() {
  say "The nightly encrypted backup service runs and records a snapshot"
  sudo systemctl start staedtechallenge-backup.service
  sudo env RESTIC_REPOSITORY=/var/backups/slk-restic RESTIC_PASSWORD_FILE=/root/.config/slk/restic-password \
    restic snapshots --tag slk --compact | tee "$state/snapshots"
  grep -q "1 snapshots" "$state/snapshots" || grep -qE '^[0-9a-f]{8} ' "$state/snapshots" || fail "No backup snapshot"
  sudo systemctl is-enabled staedtechallenge-backup.timer caddy.service
  sudo -u deploy env XDG_RUNTIME_DIR="/run/user/$(id -u deploy)" systemctl --user is-enabled slk.service
}

# Emit log tails as annotations so that results are readable without log access.
diagnostics() {
  local file title
  sudo bash -c 'ls -1t /home/deploy/.local/state/slk-st/runs/*.log 2> /dev/null | head -n 3' > "$state/runlogs" || true
  {
    echo "$RUNNER_TEMP/bootstrap.log|bootstrap"
    while read -r file; do echo "$file|$(basename "$file" .log)"; done < "$state/runlogs"
  } | while IFS='|' read -r file title; do
    sudo test -f "$file" || continue
    sudo tail -n 40 "$file" | encode > "$state/annotation"
    echo "::error title=Log tail: $title::$(cat "$state/annotation")"
  done
  for unit in caddy.service staedtechallenge-backup.service; do
    sudo journalctl -u "$unit" -n 40 --no-pager 2> /dev/null | encode > "$state/annotation" || true
    [[ -s "$state/annotation" ]] && echo "::error title=Journal: $unit::$(cat "$state/annotation")"
  done
  sudo journalctl _UID="$(id -u deploy 2> /dev/null || echo 0)" -n 60 --no-pager 2> /dev/null |
    encode > "$state/annotation" || true
  [[ -s "$state/annotation" ]] && echo "::error title=Journal: deploy user::$(cat "$state/annotation")"
  df -h / || true
}

"$@"
