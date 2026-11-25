#!/usr/bin/env bash
# One-time (and idempotent) preparation of a fresh Ubuntu 26.04 LTS server for this st,
# following upstream's production model: rootless Podman under a dedicated deployment
# account, inherited AppArmor confinement, host Caddy, nightly Restic backups and the
# `slk release` protocol. Run as root from a clean, root-owned clone of the st:
#
#   sudo git clone https://github.com/<owner>/<repo>.git /opt/slk-host
#   sudo /opt/slk-host/deploy/st/bootstrap-ubuntu.sh --site-host www.example.org \
#     --cms-host cms.example.org --admin-email admin@example.org --tls-email admin@example.org \
#     --ci-public-key /root/slk-ci.pub
#
# See docs/st/DEPLOYMENT.md for every option. Re-running it updates host packages and
# root-owned host files from the clone's revision; it never overwrites private
# configuration, never re-initializes data and never changes the deployed release.
set -Eeuo pipefail
# Name the failing command; the text is unexpanded, so no private values are printed.
trap 'slk_status=$?; echo "${BASH_SOURCE[0]##*/}: line $LINENO: \"$BASH_COMMAND\" failed with status $slk_status" >&2' ERR
umask 022

usage() {
  cat >&2 << 'EOF'
Usage: bootstrap-ubuntu.sh --site-host HOST --cms-host HOST --admin-email EMAIL
                           (--tls-email EMAIL | --tls-internal) [options]
  --repo-url URL             Git URL the server deploys from (default: this clone's origin)
  --branch NAME              Branch whose commits may be deployed (default: main)
  --deploy-user NAME         Dedicated rootless deployment account (default: deploy)
  --project NAME             Podman project name (default: slk-podman-production)
  --ci-public-key FILE       Public key of the CI deployment key (restricted forced command)
  --ci-from PATTERNS         Optional sshd from= patterns for the CI key (comma-separated)
  --ssh-port PORT            SSH port opened in the firewall (default: 22)
  --archive FILE             Prebuilt release archive (tar.zst) to load instead of building
  --manifest FILE            Release manifest JSON for the archive
  --restic-repository REPO   Off-host Restic repository for nightly backups
  --restic-password-file F   Existing Restic password file (default: generated)
  --release-offsite          Also copy every release checkpoint off-host with Restic
                             (needs /home/<user>/.config/slk/release-offsite.env)
  --no-firewall              Leave the firewall unchanged
  --cloudflare-proxy         The website hostname is proxied by Cloudflare: trust Cloudflare's
                             address ranges (deploy/st/cloudflare-ips.txt) and take the visitor
                             address from CF-Connecting-IP
EOF
  exit 2
}

log() { printf '\n==> %s\n' "$*"; }
# Atomically write standard input to a root-owned file with the given mode.
put() {
  local mode="$1" destination="$2" temporary
  temporary="$(mktemp "$destination.XXXXXX")"
  cat > "$temporary"
  chown root:root "$temporary"
  chmod "$mode" "$temporary"
  mv -f "$temporary" "$destination"
}
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

site_host="" cms_host="" admin_email="" tls="" repo_url="" branch=main deploy_user=deploy
project=slk-podman-production ci_key="" ci_from="" ssh_port=22 archive="" manifest=""
restic_repository="" restic_password_file="" release_offsite=none firewall=true cloudflare=false
while (($#)); do
  case "$1" in
    --site-host) site_host="${2:?}"; shift 2 ;;
    --cms-host) cms_host="${2:?}"; shift 2 ;;
    --admin-email) admin_email="${2:?}"; shift 2 ;;
    --tls-email) tls="${2:?}"; shift 2 ;;
    --tls-internal) tls=internal; shift ;;
    --repo-url) repo_url="${2:?}"; shift 2 ;;
    --branch) branch="${2:?}"; shift 2 ;;
    --deploy-user) deploy_user="${2:?}"; shift 2 ;;
    --project) project="${2:?}"; shift 2 ;;
    --ci-public-key) ci_key="${2:?}"; shift 2 ;;
    --ci-from) ci_from="${2:?}"; shift 2 ;;
    --ssh-port) ssh_port="${2:?}"; shift 2 ;;
    --archive) archive="${2:?}"; shift 2 ;;
    --manifest) manifest="${2:?}"; shift 2 ;;
    --restic-repository) restic_repository="${2:?}"; shift 2 ;;
    --restic-password-file) restic_password_file="${2:?}"; shift 2 ;;
    --release-offsite) release_offsite=restic; shift ;;
    --no-firewall) firewall=false; shift ;;
    --cloudflare-proxy) cloudflare=true; shift ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

seccomp_dropin=/etc/containers/containers.conf.d/50-slk-st-seccomp.conf
hostname_pattern='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$'
email_pattern='^[A-Za-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
[[ "$site_host" =~ $hostname_pattern && "$cms_host" =~ $hostname_pattern && "$site_host" != "$cms_host" ]] ||
  die "--site-host and --cms-host must be two distinct lowercase DNS names"
[[ "$admin_email" =~ $email_pattern ]] || die "--admin-email is required"
[[ "$tls" == internal || "$tls" =~ $email_pattern ]] || die "Choose --tls-email EMAIL (public ACME certificates) or --tls-internal"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]{0,30}$ && "$deploy_user" != root ]] || die "Invalid --deploy-user"
[[ "$project" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || die "Invalid --project"
[[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Invalid --branch"
[[ "$ssh_port" =~ ^[0-9]{1,5}$ ]] || die "Invalid --ssh-port"
[[ -z "$ci_from" || "$ci_from" =~ ^[0-9A-Fa-f.:/*?,!a-z-]+$ ]] || die "Invalid --ci-from"

# --- Preconditions --------------------------------------------------------------
log "Checking preconditions"
[[ "$(id -u)" == 0 ]] || die "Run as root (sudo)"
source /etc/os-release
[[ "${ID:-}" == ubuntu ]] || die "Ubuntu is required"
# Upstream requires Podman 5.4+ and Netavark; Ubuntu 24.04 ships Podman 4.9 and
# no supported newer build, so the first LTS meeting the requirement is 26.04.
dpkg --compare-versions "${VERSION_ID:-0}" ge 26.04 ||
  die "Ubuntu ${VERSION_ID:-?} ships a Podman older than 5.4, which upstream's production preflight refuses. Use Ubuntu 26.04 LTS or newer."
[[ "$(uname -m)" == x86_64 ]] || die "Upstream's images support Linux x86_64 only"
[[ -d /run/systemd/system ]] || die "systemd is required"
[[ "$(cat /sys/module/apparmor/parameters/enabled 2> /dev/null)" == Y ]] || die "AppArmor must be enabled"
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || die "cgroup v2 is required"
# After a release upgrade the new kernel and core services only run after a reboot; until then the
# deployment account's systemd user manager does not start ("The user manager of deploy did not start").
newest_kernel="$(find /boot -maxdepth 1 -name 'vmlinuz-*' -printf '%f\n' 2> /dev/null | sed 's/^vmlinuz-//' | sort -V | tail -n 1)"
[[ -z "$newest_kernel" || "$(uname -r)" == "$newest_kernel" ]] ||
  die "The running kernel $(uname -r) is older than the installed $newest_kernel. Reboot first, then run the bootstrap again."

root_checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
st_dir="$root_checkout/deploy/st"
check_root_owned() {
  local path="$1"
  while [[ "$path" != / ]]; do
    [[ "$(stat -c %u "$path")" == 0 && "$(( 0$(stat -c %a "$path") & 022 ))" == 0 ]] ||
      die "$path must be root-owned and not group/world writable (use a root-owned clone)"
    path="$(dirname "$path")"
  done
}
check_root_owned "$root_checkout"
[[ -z "$(git -C "$root_checkout" status --porcelain)" ]] || die "The root checkout $root_checkout must be clean"
revision="$(git -C "$root_checkout" rev-parse HEAD)"
[[ -n "$repo_url" ]] || repo_url="$(git -C "$root_checkout" remote get-url origin)"
[[ "$repo_url" =~ ^(https://|ssh://|git@|/)[A-Za-z0-9._@:/+-]+$ ]] || die "Unsupported --repo-url"
if [[ -n "$ci_key" ]]; then
  [[ -f "$ci_key" ]] || die "--ci-public-key $ci_key does not exist"
  ci_key_line="$(head -n 1 "$ci_key")"
  [[ "$ci_key_line" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com)\ ([A-Za-z0-9+/=]+)(\ .*)?$ ]] ||
    die "The CI key must be a single Ed25519 or ECDSA public key"
  ci_key_line="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
fi
node_version="$(tr -d '[:space:]' < "$root_checkout/.node-version")"
node_version="${node_version#v}"
read_pin() { sed -nE "s/^ *$1: \"([0-9a-f]{64}|[0-9.]+)\",?$/\\1/p" "$root_checkout/bin/cli/host-maintenance.ts"; }
[[ "$(read_pin version)" == "$node_version" ]] || die "bin/cli/host-maintenance.ts does not pin Node $node_version"
node_archive_sha="$(read_pin archiveSha256)"
node_binary_sha="$(read_pin binarySha256)"
[[ ${#node_archive_sha} == 64 && ${#node_binary_sha} == 64 ]] || die "Could not read the reviewed Node hashes"

# --- Existing host state (for example an in-place upgrade from 24.04) ---------------
# Nothing found here is changed automatically: each finding names the manual fix.
log "Checking for leftovers that would replace or bypass the reviewed setup"
problems=()
# grep exits 2 when one of several paths is missing even if another matched, so test its output.
repos="$(grep -rlsiE 'kubic|libcontainers|alvistack' /etc/apt/sources.list /etc/apt/sources.list.d/ || true)"
if [[ -n "$repos" ]]; then
  problems+=("Third-party container repositories replace Ubuntu's security-maintained Podman: $(echo "$repos" | tr '\n' ' ')
     Remove them, run apt-get update, then reinstall: apt-get install --reinstall podman netavark aardvark-dns crun conmon")
fi
if held="$(apt-mark showhold | grep -xE 'podman|netavark|aardvark-dns|crun|conmon|passt|uidmap')"; then
  problems+=("Held container packages would stay at old versions: $(echo "$held" | tr '\n' ' ')
     Release them with: apt-mark unhold <package>")
fi
if dpkg-query -W -f '${Status}' podman-compose 2> /dev/null | grep -q 'ok installed'; then
  problems+=("The distribution's podman-compose $(dpkg-query -W -f '${Version}' podman-compose) is installed; upstream needs 1.6+.
     Remove it so only the hash-pinned provider is used: apt-get remove podman-compose")
fi
for tool in podman podman-compose; do
  while read -r found; do
    # /bin is a symbolic link to /usr/bin on merged-/usr systems; compare resolved paths.
    resolved="$(readlink -f "$found")"
    [[ -z "$found" || "$resolved" == /usr/bin/podman || "$resolved" == /usr/bin/podman-compose ||
      "$resolved" == /opt/slk-podman-compose/bin/podman-compose ]] && continue
    problems+=("$found shadows the distribution's $tool. Remove it (for example pip uninstall podman-compose).")
  done < <(type -ap "$tool" 2> /dev/null || true)
done
if systemctl is-active --quiet docker.service docker.socket 2> /dev/null; then
  problems+=("Docker is running. Its published ports bypass ufw through its own iptables rules, and it competes for 80/443.
     Migrate or stop its workloads, then: systemctl disable --now docker.service docker.socket (or uninstall Docker)")
fi
while read -r listener; do
  [[ -z "$listener" || "$listener" == *'"caddy"'* ]] && continue
  problems+=("Another service listens on port 80/443: $listener
     Stop and disable it; the gateway needs both ports.")
done < <(ss -Hltnp '( sport = :80 or sport = :443 )' 2> /dev/null)
for file in /etc/containers/containers.conf /etc/containers/storage.conf /etc/containers/containers.conf.d/* \
  /etc/containers/storage.conf.d/*; do
  [[ -e "$file" && "$file" != "$seccomp_dropin" ]] || continue
  if ! package="$(dpkg -S "$file" 2> /dev/null | cut -d: -f1)"; then
    problems+=("$file is not from an Ubuntu package (left over from an older Podman?). Review it and move it aside.")
  elif dpkg --verify "$package" 2> /dev/null | grep -q " $file$"; then
    problems+=("$file was modified locally. Compare it with the $package default (apt-get install --reinstall -o Dpkg::Options::=--force-confask $package) or move it aside.")
  fi
done
# Global XDG_* or HOME assignments point every account's user manager at one user's directories;
# Podman's health-check units then fail ("mkdir /run/user/<other>/libpod: permission denied").
found="$(grep -lsE '^[[:space:]]*(export[[:space:]]+)?(XDG_[A-Z_]+|HOME)[[:space:]]*=|DefaultEnvironment=.*(XDG_|HOME=)' \
  /etc/environment /etc/environment.d/* /etc/security/pam_env.conf /etc/systemd/user.conf /etc/systemd/user.conf.d/* \
  /etc/systemd/system.conf /etc/systemd/system.conf.d/* || true)"
if [[ -n "$found" ]]; then
  problems+=("XDG_* or HOME is set globally in: $(echo "$found" | tr '\n' ' ')
     These are per-account settings; remove the global assignments.")
fi
# Rootless container storage lives in the account's home. Inherited POSIX ACL entries for other
# accounts cannot be mapped into its user namespace, so Debian-based image builds fail with
# "cp: preserving permissions ...: Invalid argument" (for example base-files' postinst).
for directory in /home "/home/$deploy_user"; do
  [[ -d "$directory" ]] || continue
  # ls marks an ACL with "+" after the mode bits; this works without the acl package.
  [[ "$(ls -ld "$directory" | cut -c 11)" == + ]] || continue
  problems+=("$directory carries POSIX ACLs, which $deploy_user's rootless container storage would inherit.
     Inspect with getfacl $directory, then remove them: setfacl -k /home (default ACL) and setfacl -R -b /home/$deploy_user")
done
if home="$(getent passwd "$deploy_user" | cut -d: -f6)" && [[ -n "$home" ]]; then
  for file in "$home"/.config/containers/{containers.conf,storage.conf,registries.conf}; do
    [[ -e "$file" ]] && problems+=("$file overrides the engine configuration for $deploy_user. Review it and move it aside.")
  done
  if [[ -e "$home/.local/share/containers/storage" && ! -e "$home/.local/state/slk-st/bootstrap-owned" ]]; then
    problems+=("$deploy_user already has rootless container storage that this bootstrap did not create (an older Podman?).
     Inspect it as $deploy_user (podman ps -a; podman volume ls) and back up what you need. Then either
     keep it with 'podman system migrate' and create the marker $home/.local/state/slk-st/bootstrap-owned,
     or delete it with 'podman system reset'.")
  fi
fi
if ((${#problems[@]})); then
  printf 'ERROR: this host needs manual attention before the bootstrap continues (docs/st/DEPLOYMENT.md, "Upgraded from 24.04"):\n' >&2
  for index in "${!problems[@]}"; do printf '  %d. %s\n' "$((index + 1))" "${problems[$index]}" >&2; done
  exit 1
fi

# --- Packages ----------------------------------------------------------------------
log "Installing host packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  podman crun conmon uidmap passt netavark aardvark-dns catatonit dbus-user-session \
  apparmor apparmor-utils git curl ca-certificates xz-utils tar gzip util-linux procps \
  python3 python3-venv python3-yaml python3-dotenv restic ufw unattended-upgrades openssh-server
podman_version="$(/usr/bin/podman --version | awk '{print $3}')"
dpkg --compare-versions "$podman_version" ge 5.4 || die "Podman $podman_version is older than 5.4"
dpkg --compare-versions "$(dpkg-query -W -f '${Version}' netavark)" ge 1.10 || die "netavark is older than 1.10"

log "Installing the pinned Compose provider"
if [[ "$(/opt/slk-podman-compose/bin/podman-compose --version 2> /dev/null)" != *"version 1.6.0"* ]]; then
  rm -rf /opt/slk-podman-compose
  python3 -m venv --system-site-packages /opt/slk-podman-compose
  /opt/slk-podman-compose/bin/pip install --quiet --disable-pip-version-check --no-deps --require-hashes \
    -r "$st_dir/podman-compose.requirements.txt"
fi
ln -sfn /opt/slk-podman-compose/bin/podman-compose /usr/local/bin/podman-compose
podman-compose --version | grep -q "version 1.6" || die "podman-compose 1.6 is not available"

log "Installing Node $node_version from the reviewed archive"
node_dir="/opt/slk-node/node-v$node_version-linux-x64"
if [[ ! -x "$node_dir/bin/node" ]] || [[ "$(sha256sum "$node_dir/bin/node" | cut -d' ' -f1)" != "$node_binary_sha" ]]; then
  node_download="$(mktemp -d)"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    -o "$node_download/node.tar.xz" "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
  echo "$node_archive_sha  $node_download/node.tar.xz" | sha256sum --quiet --check || die "Node archive hash mismatch"
  mkdir -p /opt/slk-node
  rm -rf "$node_dir"
  tar -xJf "$node_download/node.tar.xz" -C /opt/slk-node --no-same-owner
  rm -rf "$node_download"
fi
[[ "$(sha256sum "$node_dir/bin/node" | cut -d' ' -f1)" == "$node_binary_sha" ]] || die "Node binary hash mismatch"
chown -R root:root /opt/slk-node
chmod -R go-w /opt/slk-node
for tool in node npm npx; do ln -sfn "$node_dir/bin/$tool" "/usr/local/bin/$tool"; done

# --- Accounts ----------------------------------------------------------------------
log "Preparing the deployment account $deploy_user"
getent group caddy > /dev/null || groupadd --system caddy
getent passwd caddy > /dev/null ||
  useradd --system --gid caddy --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy
if ! getent passwd "$deploy_user" > /dev/null; then
  useradd --create-home --user-group --shell /bin/bash "$deploy_user"
fi
deploy_uid="$(id -u "$deploy_user")"
deploy_home="$(getent passwd "$deploy_user" | cut -d: -f6)"
[[ "$deploy_home" == "/home/$deploy_user" ]] || die "Upstream's host tooling expects /home/$deploy_user"
chmod 700 "$deploy_home"
next_subordinate() {
  awk -F: 'BEGIN { max = 100000 } { if ($2 + $3 > max) max = $2 + $3 } END { print max }' "$1"
}
if ! grep -q "^$deploy_user:" /etc/subuid; then
  start="$(next_subordinate /etc/subuid)"
  usermod --add-subuids "$start-$((start + 65535))" "$deploy_user"
fi
if ! grep -q "^$deploy_user:" /etc/subgid; then
  start="$(next_subordinate /etc/subgid)"
  usermod --add-subgids "$start-$((start + 65535))" "$deploy_user"
fi
loginctl enable-linger "$deploy_user"
for _ in $(seq 60); do [[ -S "/run/user/$deploy_uid/bus" ]] && break; sleep 1; done
[[ -S "/run/user/$deploy_uid/bus" ]] || die "The user manager of $deploy_user did not start"

as_deploy() {
  runuser -u "$deploy_user" -- env -i --chdir="$deploy_home" HOME="$deploy_home" USER="$deploy_user" LOGNAME="$deploy_user" \
    PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 XDG_RUNTIME_DIR="/run/user/$deploy_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$deploy_uid/bus" "$@"
}
foreign="$(as_deploy systemctl --user show-environment | grep -E '^(XDG_[A-Z_]+|HOME)=' |
  grep -vE "^(XDG_RUNTIME_DIR=/run/user/$deploy_uid|HOME=$deploy_home|XDG_[A-Z_]+=$deploy_home(/.*)?|XDG_(DATA|CONFIG)_DIRS=.*)$" || true)"
[[ -z "$foreign" ]] ||
  die "The user manager of $deploy_user inherits another account's settings: $(tr '\n' ' ' <<< "$foreign")
  Remove the global assignments, then: systemctl restart user@$deploy_uid.service"

# --- AppArmor (PODMAN.md "Ubuntu rootless AppArmor") --------------------------------
log "Loading the inherited AppArmor policy"
install -o root -g root -m 0644 "$root_checkout/podman/apparmor/slk-rootless" /etc/apparmor.d/slk-rootless
apparmor_parser -r -W /etc/apparmor.d/slk-rootless
if [[ -f /etc/apparmor.d/usr.bin.passt ]] && grep -q 'local/usr.bin.passt' /etc/apparmor.d/usr.bin.passt; then
  put 0644 /etc/apparmor.d/local/usr.bin.passt << 'EOF'
# Installed by deploy/st/bootstrap-ubuntu.sh (PODMAN.md): let the confined rootless
# engine run pasta and exchange signals with it.
/usr/bin/pasta{,.avx2} mr,
signal (receive, send) peer=slk-rootless,
EOF
  apparmor_parser -r -W /etc/apparmor.d/usr.bin.passt
fi
# Ubuntu 26.04 converts an unprivileged account's change into slk-rootless (aa-exec) into a stack
# with "unconfined" when kernel.apparmor_restrict_unprivileged_unconfined=1. Creating the rootless
# user namespace then moves the unconfined half to unprivileged_userns, which refuses Podman's
# re-exec ("failed to reexec: Permission denied"). Upstream's model needs the inherited policy, so
# the restriction is disabled; the userns restriction for unconfined programs stays enabled.
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_unconfined 2> /dev/null || echo 0)" != 0 ]]; then
  log "Letting aa-exec enter slk-rootless without the unprivileged-unconfined stacking restriction"
  printf '%s\n' "# Written by deploy/st/bootstrap-ubuntu.sh (docs/st/DEPLOYMENT.md, AppArmor)." \
    "kernel.apparmor_restrict_unprivileged_unconfined = 0" | put 0644 /etc/sysctl.d/60-slk-st-apparmor.conf
  sysctl --quiet --load /etc/sysctl.d/60-slk-st-apparmor.conf
fi
as_deploy mkdir -p "$deploy_home/.local/state/slk-st"
# Marks the rootless container storage as created by this bootstrap (see the leftover checks).
as_deploy touch "$deploy_home/.local/state/slk-st/bootstrap-owned"
canary="$deploy_home/.local/state/slk-apparmor-denied"
[[ -f "$canary" ]] || as_deploy touch "$canary"
chown "$deploy_user:$deploy_user" "$canary"
chmod 600 "$canary"

# --- Firewall, updates, SSH ------------------------------------------------------
if [[ "$firewall" == true ]]; then
  log "Configuring the firewall (SSH $ssh_port, HTTP, HTTPS)"
  ufw default deny incoming > /dev/null
  ufw default allow outgoing > /dev/null
  ufw allow "$ssh_port/tcp" > /dev/null
  ufw allow 80/tcp > /dev/null
  ufw allow 443/tcp > /dev/null
  ufw --force enable > /dev/null
fi
log "Enabling unattended security upgrades"
put 0644 /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades.service > /dev/null
systemctl enable --now ssh.service > /dev/null 2>&1 || systemctl enable --now ssh.socket > /dev/null

# --- St scripts and configuration -----------------------------------------------
log "Installing the st deployment scripts"
install -d -o root -g root -m 0755 /usr/local/libexec/slk-st /etc/slk-st
install -o root -g root -m 0644 "$st_dir/lib.sh" /usr/local/libexec/slk-st/lib.sh
install -o root -g root -m 0644 "$st_dir/private-config.mts" /usr/local/libexec/slk-st/private-config.mts
install -o root -g root -m 0755 "$st_dir/deploy-command.sh" /usr/local/libexec/slk-st/deploy-command
install -o root -g root -m 0755 "$st_dir/first-start.sh" /usr/local/libexec/slk-st/first-start
checkout="$deploy_home/stadt-land-klima"
host_config="$deploy_home/.config/slk/production.env"
gateway_ca=""
[[ "$tls" == internal ]] && gateway_ca=/etc/slk-st/gateway-ca.crt
put 0644 /etc/slk-st/deploy.conf << EOF
# Written by deploy/st/bootstrap-ubuntu.sh; read as data by the st scripts.
SLK_ST_USER=$deploy_user
SLK_ST_PROJECT=$project
SLK_ST_CHECKOUT=$checkout
SLK_ST_HOST_CONFIG=$host_config
SLK_ST_BRANCH=$branch
SLK_ST_REMOTE_URL=$repo_url
SLK_ST_SITE_ORIGIN=https://$site_host
SLK_ST_CMS_ORIGIN=https://$cms_host
SLK_ST_OFFSITE=$release_offsite
SLK_ST_GATEWAY_CA=$gateway_ca
EOF

# --- Deployment checkout and private configuration --------------------------------
if [[ ! -d "$checkout/.git" ]]; then
  log "Cloning $repo_url at $revision as $deploy_user"
  as_deploy git clone --quiet --no-checkout "$repo_url" "$checkout"
  as_deploy git -C "$checkout" -c advice.detachedHead=false checkout --quiet --detach "$revision"
fi
[[ "$(stat -c %U "$checkout")" == "$deploy_user" ]] || die "$checkout must belong to $deploy_user"
deployed="$(as_deploy git -C "$checkout" rev-parse HEAD)"
as_deploy npm ci --prefix "$checkout/bin" --ignore-scripts --no-audit --no-fund --loglevel=error
as_deploy npm ci --prefix "$checkout/src/directus/cli" --ignore-scripts --no-audit --no-fund --loglevel=error
as_deploy node /usr/local/libexec/slk-st/private-config.mts init "$checkout" "$host_config" "$project" \
  "release-$deployed" "https://$site_host" "https://$cms_host" "$admin_email"

log "Root host and backup configuration"
install -d -o root -g root -m 0700 /root/.config /root/.config/slk
if [[ -z "$restic_repository" && -f /root/.config/slk/backup.env ]]; then
  restic_repository="$(sed -n 's/^RESTIC_REPOSITORY=//p' /root/.config/slk/backup.env)"
fi
if [[ -z "$restic_repository" ]]; then
  restic_repository=/var/backups/slk-restic
  echo "WARNING: no --restic-repository given; nightly backups go to the local $restic_repository." >&2
  echo "         Configure an off-host repository before relying on them (docs/st/DEPLOYMENT.md)." >&2
fi
[[ "$restic_repository" =~ ^[A-Za-z0-9._@:/+=-]+$ ]] || die "Unsupported --restic-repository"
if [[ -z "$restic_password_file" ]]; then
  restic_password_file=/root/.config/slk/restic-password
  [[ -f "$restic_password_file" ]] || (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$restic_password_file")
fi
[[ "$(stat -c '%u %a' "$restic_password_file")" == "0 600" ]] || die "$restic_password_file must be root-owned mode 0600"
put 0600 /root/.config/slk/backup.env << EOF
RESTIC_REPOSITORY=$restic_repository
RESTIC_PASSWORD_FILE=$restic_password_file
EOF
put 0600 /root/.config/slk/host.env << EOF
SLK_HOST_APP_USER=$deploy_user
SLK_HOST_APP_CONFIG=$host_config
SLK_HOST_BACKUP_CONFIG=/root/.config/slk/backup.env
SLK_HOST_BACKUP_HOST=$(hostname -s | tr -cd 'A-Za-z0-9._-')
SLK_HOST_BACKUP_TAG=slk
EOF
if ! RESTIC_REPOSITORY="$restic_repository" RESTIC_PASSWORD_FILE="$restic_password_file" restic cat config > /dev/null 2>&1; then
  RESTIC_REPOSITORY="$restic_repository" RESTIC_PASSWORD_FILE="$restic_password_file" restic init > /dev/null ||
    die "Cannot open or initialize the Restic repository $restic_repository"
fi

# --- Seccomp profile -----------------------------------------------------------------
# Upstream's preflight derives its hardened policy from the engine's default seccomp profile and
# accepts only a root-owned regular file, not a symbolic link. If the distribution installs the
# default as a link, point the engine at the link's root-owned target (same bytes).
engine_seccomp() {
  as_deploy aa-exec -p slk-rootless -- podman --remote=false info --format json |
    node -e 'let b="";process.stdin.on("data",(c)=>(b+=c)).on("end",()=>process.stdout.write(String(JSON.parse(b).host.security.seccompProfilePath)))'
}
seccomp="$(engine_seccomp)"
if [[ -f "$seccomp" && ! -L "$seccomp" && "$(( 0$(stat -c %a "$seccomp") & 022 ))" != 0 ]]; then
  owner="$(dpkg -S "$seccomp" 2> /dev/null | cut -d: -f1 || true)"
  die "The engine's seccomp profile $seccomp is group/world writable ($(stat -c %A "$seccomp")), so its contents cannot be trusted.
  Restore the packaged file and mode: apt-get install --reinstall ${owner:-<owning package>}; chmod 0644 $seccomp"
fi
if [[ -L "$seccomp" ]]; then
  target="$(readlink -f "$seccomp")"
  [[ -f "$target" && ! -L "$target" && "$(stat -c %u "$target")" == 0 && "$(( 0$(stat -c %a "$target") & 022 ))" == 0 ]] ||
    die "The engine's seccomp profile $seccomp links to $target, which is not a protected root-owned file"
  check_root_owned "$(dirname "$target")"
  log "Using the seccomp profile $target (the target of $seccomp)"
  install -d -o root -g root -m 0755 "$(dirname "$seccomp_dropin")"
  printf '# Written by deploy/st/bootstrap-ubuntu.sh: %s is a symbolic link.\n[containers]\nseccomp_profile = "%s"\n' \
    "$seccomp" "$target" | put 0644 "$seccomp_dropin"
elif [[ ! -f "$seccomp" ]]; then
  die "The engine reports no usable seccomp profile ($seccomp)"
fi
ls -l "$(engine_seccomp)"

# --- First start ---------------------------------------------------------------------
if [[ -n "$archive" && -n "$manifest" ]]; then
  log "Starting the stack as $deploy_user with prebuilt images (2GB server never builds)"
  [[ -f "$archive" && -f "$manifest" ]] || die "Prebuilt archive or manifest not found"
  # Copy archive and manifest to deploy user's home
  # Not /tmp: Ubuntu 26.04 mounts it as tmpfs (half the RAM), too small for a release archive.
  as_deploy mkdir -p "$deploy_home/.cache"
  deploy_tmp="$(as_deploy mktemp -d "$deploy_home/.cache/slk-st-bootstrap.XXXXXX")"
  install -o "$deploy_user" -g "$deploy_user" -m 0600 "$archive" "$deploy_tmp/release.tar.zst"
  install -o "$deploy_user" -g "$deploy_user" -m 0600 "$manifest" "$deploy_tmp/release.manifest.json"
  (cd / && as_deploy bash /usr/local/libexec/slk-st/first-start "$deploy_tmp/release.tar.zst" "$deploy_tmp/release.manifest.json")
  as_deploy rm -rf "$deploy_tmp"
else
  log "Starting the stack as $deploy_user (first start builds all images; this takes a while)"
  (cd / && as_deploy bash /usr/local/libexec/slk-st/first-start)
fi

# --- Host artifacts and gateway --------------------------------------------------------
log "Installing the reviewed Caddy binary from the gateway image"
caddy_image="$(grep -oE 'localhost/slk-caddy:[0-9.]+' "$root_checkout/bin/cli/stack.ts" | head -n 1)"
[[ -n "$caddy_image" ]] || die "Cannot find the gateway image name in bin/cli/stack.ts"
extract="$(as_deploy mktemp -d)"
as_deploy bash -c 'set -e; c="$(aa-exec -p slk-rootless -- podman --remote=false create --pull=never "$1")"
  aa-exec -p slk-rootless -- podman --remote=false cp "$c:/usr/bin/caddy" "$2/caddy"
  aa-exec -p slk-rootless -- podman --remote=false rm "$c" > /dev/null' _ "$caddy_image" "$extract"
install -o root -g root -m 0755 "$extract/caddy" /usr/local/bin/caddy.new
rm -rf "$extract"
/usr/local/bin/caddy.new list-modules | grep -q '^http.handlers.rate_limit$' || die "The gateway binary lacks rate limiting"
mv -f /usr/local/bin/caddy.new /usr/local/bin/caddy

log "Installing host artifacts from $revision"
node "$st_dir/host-install.mts" install /root/.config/slk/host.env "$node_dir/bin/node" "$site_host" "$cms_host" "$tls" > /dev/null
install -d -o caddy -g caddy -m 0700 /var/lib/caddy
# Trusted proxies for upstream's optional "import servers.d/*.caddy" (caddy/global-options.caddy).
install -d -o root -g caddy -m 0750 /etc/caddy/servers.d
if [[ "$cloudflare" == true ]]; then
  ranges="$(grep -vE '^[[:space:]]*(#|$)' "$st_dir/cloudflare-ips.txt" | tr '\n' ' ')"
  [[ "$ranges" =~ ^([0-9a-f.:]+/[0-9]{1,3}[[:space:]])+$ ]] || die "deploy/st/cloudflare-ips.txt is malformed"
  printf '\ttrusted_proxies static %s\n\tclient_ip_headers CF-Connecting-IP\n\ttrusted_proxies_strict\n' "${ranges% }" |
    put 0640 /etc/caddy/servers.d/cloudflare.caddy
  chgrp caddy /etc/caddy/servers.d/cloudflare.caddy
else
  rm -f /etc/caddy/servers.d/cloudflare.caddy
fi
runuser -u caddy -- env SLK_CADDY_SITE_HOST="$site_host" SLK_CADDY_CMS_HOST="$cms_host" \
  SLK_CADDY_WEBSITE_ORIGIN="https://$site_host" SLK_CADDY_CMS_ORIGIN="https://$cms_host" SLK_CADDY_TLS="$tls" \
  XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy \
  /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null ||
  die "The gateway configuration does not validate"
systemctl daemon-reload
systemctl enable caddy.service > /dev/null
systemctl reload-or-restart caddy.service
if [[ "$tls" == internal ]]; then
  for _ in $(seq 60); do [[ -f /var/lib/caddy/caddy/pki/authorities/local/root.crt ]] && break; sleep 1; done
  install -o root -g root -m 0644 /var/lib/caddy/caddy/pki/authorities/local/root.crt /etc/slk-st/gateway-ca.crt
fi

# Host-level sources whose installed copies only root can update (checked on each deploy).
(cd "$root_checkout" && sha256sum podman/apparmor/slk-rootless caddy/*.caddy caddy/caddy.service.example \
  caddy/Containerfile podman/host-backup.timer podman/slk-application-only.service.example \
  bin/cli/host-backup.ts bin/cli/host-configuration.ts bin/cli/cloud-retention.ts bin/cli/release-retention.ts \
  bin/cli/image-retention.ts deploy/st/Caddyfile deploy/st/lib.sh deploy/st/private-config.mts \
  deploy/st/deploy-command.sh deploy/st/first-start.sh deploy/st/host-install.mts deploy/st/cloudflare-ips.txt) |
  put 0644 /etc/slk-st/host-files.sha256
printf '%s\n' "$revision" | put 0644 /etc/slk-st/host-revision

log "Checking the public gateway on this host"
(cd / && as_deploy bash -c 'source /usr/local/libexec/slk-st/lib.sh; load_st_conf; user_runtime_environment; check_health') ||
  die "The application is not reachable through the gateway"

# --- Restricted CI access ---------------------------------------------------------
if [[ -n "$ci_key" ]]; then
  log "Installing the restricted CI deployment key"
  options='restrict,command="/usr/local/libexec/slk-st/deploy-command"'
  [[ -n "$ci_from" ]] && options+=",from=\"$ci_from\""
  as_deploy install -d -m 0700 "$deploy_home/.ssh"
  keys="$deploy_home/.ssh/authorized_keys"
  as_deploy touch "$keys"
  chmod 600 "$keys"
  as_deploy bash -c 'grep -v " slk-st-ci$" "$1" > "$1.new" || true; printf "%s\n" "$2" >> "$1.new"; chmod 600 "$1.new"; mv "$1.new" "$1"' \
    _ "$keys" "$options $ci_key_line slk-st-ci"
fi

host_key="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
cat << EOF

Bootstrap complete. Deployed revision: $deployed

GitHub environment "production" settings (docs/st/DEPLOYMENT.md):
  variable DEPLOY_SITE_ORIGIN = https://$site_host
  variable DEPLOY_CMS_ORIGIN  = https://$cms_host
  secret   DEPLOY_SSH_HOST    = <public DNS name or address of this server>
  secret   DEPLOY_SSH_PORT    = $ssh_port
  secret   DEPLOY_SSH_USER    = $deploy_user
  secret   DEPLOY_KNOWN_HOSTS = <host> $host_key   (use [host]:port when the port is not 22)
  secret   DEPLOY_SSH_KEY     = the private half of the CI key

CMS administrator: $admin_email; the generated password is ADMIN_PASSWORD in
$checkout/src/directus/.env (readable by $deploy_user only). Change it after the first login.
EOF
