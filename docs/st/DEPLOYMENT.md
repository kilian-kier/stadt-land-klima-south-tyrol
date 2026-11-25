# Deployment: Ubuntu server with GitHub Actions releases

This repository deploys to one plain Ubuntu server. The server setup is upstream's production
model ([PODMAN.md](../../PODMAN.md), [HOST_REPRODUCIBILITY.md](../HOST_REPRODUCIBILITY.md),
[BACKUP_RETENTION.md](../BACKUP_RETENTION.md)): rootless Podman under a dedicated deployment
account, the inherited `slk-rootless` AppArmor policy, a host Caddy gateway, nightly encrypted
Restic backups and the `bin/slk release` protocol. The additions live only in `deploy/st/` and
`.github/workflows/st-*.yml`, so upstream syncs keep working.

The server never builds images or the frontend. Every release is built once on a GitHub runner,
tested there and uploaded; the server only loads and starts it.

```text
 Actions → Release (st-release.yml), one commit of main
     |
     +-- build: deploy/st/build-release.sh  → release-<sha>.tar.zst + manifest (artifact)
     +-- quality (quality.yml) and e2e (st-e2e.yml) on exactly that commit
     |
     v  environment "production": waits for your approval
 ssh deploy@server "upload <sha> <sha256>"  (archive on stdin; sha256 + revision labels checked)
 ssh deploy@server "deploy <sha>"
                                                     pinned host key, CI key only
 server: authorized_keys  restrict,command="/usr/local/libexec/slk-st/deploy-command"
         deploy-command (root-owned, runs as the deploy user, holds a lock, logs every run)
           1. accept only "upload <sha> <sha256>", "deploy|rollback|wait <sha>" or "status"
           2. git fetch origin main; the commit must be contained in origin/main
           3. a verified upload for exactly this commit must exist; nothing is ever built
           4. checkpoint + verification                           (bin/slk release backup)
           5. stage the uploaded images and frontend output       (bin/slk release stage-prebuilt)
           6. activate: maintenance, YAML import + migrations,    (bin/slk release activate)
              frontend switch, runtime audit; rolls back on error
           7. health checks on loopback and through Caddy; on failure: checkout previous,
              bin/slk release rollback
     |
 Release: public smoke checks incl. /api/version == <sha>; on failure "rollback <sha>";
          then the "production" branch and a release-YYYYMMDD-N tag point at <sha>
```

## Server requirements

- **The server must run Ubuntu 26.04 LTS** (x86_64, with systemd, AppArmor and cgroup v2, which
  are the defaults). Use a fresh install, or upgrade a 24.04 server in place with
  `do-release-upgrade` (see "Upgraded from 24.04" below). Ubuntu 24.04 itself cannot run this
  deployment: it ships Podman 4.9, while upstream's production preflight requires Podman 5.4 or
  newer (`bin/lib/podman-security.ts`). Ubuntu 26.04 ships Podman 5.7. Its podman-compose is older
  than the 1.6 upstream needs, so the bootstrap installs podman-compose 1.6.0 hash-pinned in an
  isolated environment, as PODMAN.md recommends.
- Memory: the server only runs the stack (database, Redis, Meilisearch, Directus, Nuxt, Caddy).
  Measured before the first deployment: the whole stack peaked at about 780 MiB during a release
  (Directus 634 MiB, Nuxt 197 MiB, PostgreSQL 120 MiB), so 2 GB RAM is the minimum; 4 GB gives
  headroom for traffic, backups and release checkpoints. 40 GB disk or more: each release
  keeps its images, a database/uploads checkpoint and a staged frontend output.
- After a release upgrade (for example `do-release-upgrade` from 24.04), **reboot before the
  bootstrap**. The bootstrap refuses to run while the running kernel is older than the installed one,
  because the deployment account's systemd user manager does not start until then.
- With 2 GB of RAM, add a swap file as a safety margin (the bootstrap does not change swap):
  `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`
- A sudo-capable administrator login with your own SSH key. The bootstrap opens only
  SSH, 80 and 443 in the firewall.

## 1. DNS

Upstream separates the website and the CMS origin (`__Host-` CMS cookies, isolated Admin), so the
server needs **two** names pointing at it, for example `www.example.org` and `cms.example.org`.
Caddy obtains Let's Encrypt certificates for both once DNS resolves and ports 80/443 are reachable.

The CMS name must be "DNS only". The website name may stay behind the **Cloudflare proxy**: then run
the bootstrap with `--cloudflare-proxy`. The gateway trusts Cloudflare's address ranges
(`deploy/st/cloudflare-ips.txt`, checked weekly against Cloudflare's list) and takes the visitor
address from `CF-Connecting-IP`, so rate limits count real visitors. Requests from any other address
cannot set that header. The zone's SSL/TLS mode must be **Full (strict)** or **Full**; with "Flexible"
Cloudflare talks plain HTTP to the server and Caddy's redirect to HTTPS loops.

## 2. Create the CI deployment key

On your workstation (not on the server):

```bash
ssh-keygen -t ed25519 -N '' -C slk-st-ci -f slk-st-ci
```

`slk-st-ci.pub` goes to the server. `slk-st-ci` (the private key) becomes the GitHub
secret `DEPLOY_SSH_KEY`. Delete your local copies afterwards.

## 3. Run the bootstrap

The server never builds, so the first start needs a release archive too. Run Actions → **Release**
once before the server exists (with `ST_PRODUCTION_DEPLOY` unset, it builds and tests and then skips
the deployment). Download its artifact `release-<sha>` from the run page and copy the two files
(`release-<sha>.tar.zst`, `release-<sha>.manifest.json`) to the server, e.g. to `/root/`.

Log in as your administrator and work from a **root-owned clone** at that same commit. Privileged host files are
installed only from such a clone, never from the deployment user's writable checkout
(HOST_REPRODUCIBILITY.md).

```bash
sudo git clone https://github.com/<owner>/<repo>.git /opt/slk-host
sudo git -C /opt/slk-host checkout --detach <sha>
sudo install -m 0600 slk-st-ci.pub /root/slk-st-ci.pub
sudo /opt/slk-host/deploy/st/bootstrap-ubuntu.sh \
  --site-host www.example.org --cms-host cms.example.org \
  --admin-email admin@example.org --tls-email admin@example.org \
  --ci-public-key /root/slk-st-ci.pub \
  --restic-repository sftp:backup@backup.example.org:/srv/restic/slk
```

| Option                           | Meaning                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--site-host`, `--cms-host`      | Website and CMS hostnames (two different names)                                                                                     |
| `--admin-email`                  | First CMS administrator and default notification recipient                                                                          |
| `--tls-email` / `--tls-internal` | Public ACME certificates with this contact, or a private CA (tests only)                                                            |
| `--ci-public-key`                | CI public key, installed with `restrict,command=...`                                                                                |
| `--cloudflare-proxy`             | The website name is proxied by Cloudflare: trust Cloudflare's ranges for the visitor address (see "DNS")                            |
| `--archive`, `--manifest`        | The release built by the Release workflow; the first start loads it instead of building (required)                                  |
| `--ci-from`                      | Optional `from=` patterns for the CI key. GitHub-hosted runner addresses change, so this suits self-hosted runners                  |
| `--restic-repository`            | Off-host Restic repository for nightly backups. Prepare its credentials for root first, e.g. the SSH key and `known_hosts` for SFTP |
| `--restic-password-file`         | Existing password file; otherwise one is generated in `/root/.config/slk/restic-password`                                           |
| `--release-offsite`              | Also copy each release checkpoint off-host (see "Backups")                                                                          |
| `--repo-url`, `--branch`         | Deployment source (default: this clone's origin, `main`)                                                                            |
| `--deploy-user`, `--project`     | Default `deploy`, `slk-podman-production`                                                                                           |
| `--ssh-port`, `--no-firewall`    | Firewall settings                                                                                                                   |

What it does (each step is idempotent):

1. Refuses anything but Ubuntu ≥ 26.04 on x86_64 with AppArmor, cgroup v2 and systemd.
   Also refuses a clone that is not root-owned or not clean.
2. Installs Podman, crun, conmon, uidmap, pasta, Netavark/Aardvark, restic, ufw,
   unattended-upgrades and OpenSSH. It also installs podman-compose 1.6.0 (hash-pinned) and Node from
   `.node-version`. The Node archive and binary are verified against the hashes pinned in
   `bin/cli/host-maintenance.ts`.
3. Creates the `caddy` system account and the deployment account. The deployment account gets
   subordinate UID/GID ranges and lingering, so containers start at boot without a login.
4. Loads `podman/apparmor/slk-rootless`, adds the narrow pasta override PODMAN.md describes
   and creates the AppArmor denial canary. It also sets
   `kernel.apparmor_restrict_unprivileged_unconfined = 0` in `/etc/sysctl.d/60-slk-st-apparmor.conf`.
   With Ubuntu 26.04's default of 1, the deployment account's `aa-exec -p slk-rootless` becomes a stack
   with `unconfined`. Rootless Podman then cannot create its user namespace ("failed to reexec:
   Permission denied", denied in `unprivileged_userns`). Trade-off: unprivileged local accounts can
   again enter AppArmor profiles that allow user namespaces through `aa-exec`. The
   `apparmor_restrict_unprivileged_userns` restriction for unconfined programs stays on. Keep the server
   free of untrusted local accounts. This is an interim measure. The narrower alternative is a
   privileged transition: start every engine operation already inside `slk-rootless`, for example
   through a root-owned `user@<uid>.service` drop-in with `AppArmorProfile=slk-rootless`, or a templated
   system unit started through a single sudoers rule. Upstream's CLI then skips `aa-exec`, so the kernel
   never converts the change into a stack. It is not implemented yet, because SSH sessions, the boot unit
   (which calls `aa-exec` itself) and the bootstrap's first start would all have to move into such units.
   The commit message of the sysctl change records the exact kernel audit lines.
5. Sets ufw to deny incoming traffic except SSH, 80 and 443, and enables unattended security upgrades.
6. Clones the st as the deployment user to `/home/deploy/stadt-land-klima`. Creates the four
   private dotenv files from upstream's examples with generated secrets, plus
   `~/.config/slk/production.env` (all mode 0600). Existing files are never overwritten.
7. Writes `/root/.config/slk/host.env` and `backup.env` and initializes the Restic repository.
8. First start as the deployment user (`deploy/st/first-start.sh`). It runs `slk stack doctor`,
   loads the release archive's images and imports its frontend output (it refuses to continue without
   an archive), then runs the core-only YAML import. It creates the restricted database application role
   (`slk database role`), starts the CMS with production startup checks, provisions the private
   website service identities and the mail-flow URLs, creates an empty published homepage (slug `index`, needed by `slk release activate`) when none exists, and finally `slk stack start --env production`
   (output verification, runtime confinement audit).
9. Extracts the reviewed Caddy binary from the gateway image and installs upstream's host
   artifacts through `deploy/st/host-install.mts`. These are the pinned Node, backup helpers, nightly
   `staedtechallenge-backup.timer`, AppArmor policy, Caddy service and snippets, and the
   deployment user's boot unit `slk.service`. Only the gateway entrypoint is st-specific:
   `deploy/st/Caddyfile` plus `/etc/systemd/system/caddy.service.d/slk-st.conf` with your names.
10. Checks the site through Caddy and installs the CI key as a forced command.

It finally prints the values for GitHub.

After the bootstrap:

- Log in to `https://cms.example.org/admin` as `--admin-email`. The generated password is
  `ADMIN_PASSWORD` in `/home/deploy/stadt-land-klima/src/directus/.env`
  (`sudo -u deploy grep ADMIN_PASSWORD ...`). Change it in the CMS. The dotenv value is only a
  bootstrap value and changing it later does nothing.
- Configure real mail delivery in `src/directus/.env` (`EMAIL_TRANSPORT=smtp`, `EMAIL_SMTP_*`,
  `EMAIL_FROM`; then `EMAIL_VERIFY_SETUP=true`). Integrations such as `LISTMONK_*`,
  `CARTO_BASEMAP_API_KEY` and Plausible go into `src/frontend/.env`. Apply them with
  `sudo -iu deploy` and then
  `cd stadt-land-klima && node bin/cli/host-environment.ts ~/.config/slk/production.env bin/slk stack restart --env production directus`
  (or `frontend`).
- The database starts empty except for the code-first configuration and seeds. To move existing
  content, follow upstream's [portable backup](../../bin/PORTABLE_BACKUP.md) restore procedure.

## 4. GitHub settings

Repository → Settings → Environments → **New environment `production`**:

- **Required reviewers:** add yourself. Every release waits for your approval before it touches
  the server, and GitHub notifies you by email and in the app.
- **Deployment branches and tags:** Selected branches → `main` (only runs from main can read the
  secrets).
- **Secrets**:

  | Secret               | Value                                                                                                                                                                  |
  | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `DEPLOY_SSH_HOST`    | DNS name or IP address of the server                                                                                                                                   |
  | `DEPLOY_SSH_PORT`    | SSH port (optional, default 22)                                                                                                                                        |
  | `DEPLOY_SSH_USER`    | Deployment account (`deploy`)                                                                                                                                          |
  | `DEPLOY_KNOWN_HOSTS` | The pinned host key line printed by the bootstrap: `<host> ssh-ed25519 AAAA…` (`[host]:port` for a non-standard port). Copy it from the server, not from `ssh-keyscan` |
  | `DEPLOY_SSH_KEY`     | The complete private key `slk-st-ci`                                                                                                                                   |

- **Variables** of the environment: `DEPLOY_SITE_ORIGIN` (`https://www.example.org`) and
  `DEPLOY_CMS_ORIGIN` (`https://cms.example.org`).

Repository → Settings → Secrets and variables → Actions → **Variables**: set
`ST_PRODUCTION_DEPLOY` to `true` once the environment is complete. Until then a release builds and
tests everything and reports "Deployment skipped". (It is a repository variable because job
conditions cannot read environment variables.)

Repository → Settings → Rules → Rulesets: protect `main` (pull requests and passing `quality`
checks). Protect `production` against manual pushes and deletion, and add **GitHub Actions** to the
ruleset's bypass list so only the Release workflow moves it.

## 5. How releases run

- Actions → **Release** → Run workflow, optionally with a commit, branch or tag of main
  (default: the head of main). See [RELEASE.md](RELEASE.md).
- The server refuses commits that are not contained in `origin/main` (exit 3), commits older than
  the active release (use rollback for those), deploys without a verified upload, and requests other
  than the five forms. If the SSH connection drops, the release keeps running on the server and the
  workflow reattaches with `wait <sha>`.
- Server exit codes: `0` success, `1` release failed and the previous release serves again,
  `3` refused, `4` operator attention required, `75` another deploy is running.
- On the server: `sudo -iu deploy /usr/local/libexec/slk-st/deploy-command status` lists the
  active release and recent runs. Logs are in `~deploy/.local/state/slk-st/runs/`. Release
  checkpoints are in `~deploy/.local/state/slk-releases/<tag>/`.

### What a rollback restores

Rollbacks are upstream's application rollback: previous images, previous frontend output,
previous release tag and the guarded homepage restore. The database, uploads and search index keep
running and are **not** reverted (PODMAN.md "Application release coordination"). Migrations of a
failed release that already ran stay applied. A rollback also needs the previous release's images: the nightly
maintenance keeps the images of the two most recently activated releases. The state installed by the
bootstrap is not such a release, so once the first regular release has been live for a night, it can
no longer be rolled back to the bootstrap state; fix forward with a new release instead. To undo data changes, restore the release checkpoint
or a nightly backup (below).

### Host-level changes

The deployment account cannot change root-owned files: AppArmor policy, Caddy snippets and binary,
backup helpers, boot unit and the st scripts in `/usr/local/libexec/slk-st`. When a release
changes any of them, the deploy log and the workflow show a "Host files changed" warning. Update
them with the reviewed revision:

```bash
sudo git -C /opt/slk-host fetch origin main
sudo git -C /opt/slk-host checkout --detach <deployed sha>
sudo /opt/slk-host/deploy/st/bootstrap-ubuntu.sh <the same options as before>
```

Re-running never touches private configuration, data or the deployed release.

## 6. Backups and restore

- **Nightly:** upstream's `staedtechallenge-backup.timer` (03:30 Europe/Berlin) dumps every
  database and backs up uploads, private configuration and `/etc/caddy` with Restic. It then applies
  the five-snapshot retention (BACKUP_RETENTION.md) and checks 10 % of the data on Sundays. Without
  `--restic-repository` the repository is the local `/var/backups/slk-restic`. That protects against
  mistakes but not against losing the server, so configure an off-host repository by re-running
  the bootstrap with `--restic-repository`.
  Keep the Restic password (`/root/.config/slk/restic-password`) **off the server too**. Without it
  the backups cannot be read.
- **Per release:** `slk release backup` checkpoints the database, uploads, frontend output, source and
  configuration before every activation. The last five are kept. The st verifies the manifest,
  dump listing and archives before it marks the checkpoint verified. With `--release-offsite`, create
  `~deploy/.config/slk/release-offsite.env` (mode 0600, `RESTIC_REPOSITORY=…`,
  `RESTIC_PASSWORD_FILE=…` and backend credentials). Each checkpoint is then also copied there and its
  database dump is read back before activation. Use a separate append-only repository
  (for example `rest-server --append-only`) so the deployment account cannot delete history.
- **Restore** follows upstream: [portable backup](../../bin/PORTABLE_BACKUP.md) for complete
  recovery bundles, `slk database import` for a database dump, `restic restore` for nightly snapshots.
  Restore into a stopped application, keep a copy of the current state, and verify CMS health and
  website data before re-enabling writers.

## 7. Rotating keys and secrets

- **CI key:** generate a new key pair and re-run the bootstrap with `--ci-public-key <new.pub>`. The
  previous `slk-st-ci` line is replaced. Then update `DEPLOY_SSH_KEY`. If you suspect a leak, also
  remove the line immediately: `sudo -u deploy sed -i '/ slk-st-ci$/d' ~deploy/.ssh/authorized_keys`.
- **Server host key:** after `ssh-keygen -A` or a reinstall, update `DEPLOY_KNOWN_HOSTS`. A mismatch
  stops deployments instead of trusting the new key.
- **Restic password:** `restic key add` with the new password file, update `RESTIC_PASSWORD_FILE`
  in `/root/.config/slk/backup.env`, then `restic key remove` the old key.
- **Application secrets** (database, CMS tokens, signing secrets) follow upstream. Rotate the
  persisted account or token in the service first, then the private dotenv, then restart
  (README "Production and runtime configuration", DEPLOYMENT_CHECKLIST.md).
- Unattended upgrades install security updates but do not reboot. Reboot regularly. `slk.service`
  brings the application back after boot and Caddy starts as a system service.

## 8. Security properties of the CI path

- The key works only for the deployment account. `restrict` disables PTY, agent, X11 and port
  forwarding, and `command=` runs the root-owned `/usr/local/libexec/slk-st/deploy-command`
  whatever the client asks for. `from=` can additionally pin source addresses.
- The command accepts exactly `upload <40 lowercase hex> <64 lowercase hex sha256>`,
  `deploy|rollback|wait <40 lowercase hex>` or `status` (120 characters at most) and never passes
  client text to a shell. Uploads are size-capped, must match
  the announced sha256 and must carry images labelled with exactly that commit. It deploys only
  commits contained in `origin/main` after fetching from the configured remote.
- The key cannot reach root, the CMS or the database directly, and it cannot change host files. A
  stolen key can roll back one release, read status, and deploy commits of main.
- **Trade-off of building on the runner:** the server checks that an upload matches its announced
  sha256 and that its images carry the commit's revision label, but it cannot prove that the images
  were built from that commit. Whoever holds the CI key could therefore deploy self-built images
  under a main commit's label. The key is only usable from the `production` environment, after your
  approval. The planned hardening is signed build provenance (GitHub artifact attestations) that the
  server verifies before loading an upload.
- GitHub pins the server's host key (`StrictHostKeyChecking=yes`, no TOFU). The secrets are
  environment secrets limited to `main`. The workflow has `contents: read` only and runs main's
  scripts, never the requested commit's. Server output is printed with workflow commands disabled.

## Upgraded from 24.04

A server upgraded in place keeps packages and configuration from its 24.04 life. Before
changing anything, the bootstrap checks for the leftovers below. If it finds any, it stops and lists
the manual fix for each one; it never overwrites them silently:

- third-party container repositories (Kubic, libcontainers, Alvistack) or held `podman`, `netavark`,
  `aardvark-dns`, `crun`, `conmon`, `passt` or `uidmap` packages. Remove the repository, `apt-mark unhold`, then
  `apt-get install --reinstall podman netavark aardvark-dns crun conmon`;
- the distribution's `podman-compose` package or another `podman`/`podman-compose` earlier in `PATH`.
  Remove them (`apt-get remove podman-compose`, `pip uninstall podman-compose`). Only the hash-pinned
  1.6.0 in `/usr/local/bin` is used;
- unpackaged or locally modified `/etc/containers/containers.conf`, `storage.conf` or their `.d`
  directories, and per-user `~deploy/.config/containers/*.conf`. Review them and move them aside;
- rootless container storage of the deployment account that the bootstrap did not create, for
  example from Podman 4. Inspect it as that user (`podman ps -a`, `podman volume ls`) and back up
  what you need. Then either keep it with `podman system migrate` and
  `touch ~/.local/state/slk-st/bootstrap-owned`, or delete it with `podman system reset`;
- a running Docker. Its published ports bypass ufw and it competes for 80/443. Move its workloads,
  then `systemctl disable --now docker.service docker.socket`, or uninstall it;
- any other service on port 80 or 443, such as an old nginx or Apache. Stop and disable it;
- POSIX ACLs on `/home` or the deployment account's home (shown as `+` in `ls -ld`). The rootless
  container storage inherits them. Entries for other accounts cannot be mapped into the user namespace,
  so image builds fail with "cp: preserving permissions …: Invalid argument". Remove them with
  `setfacl -k /home` and `setfacl -R -b /home/deploy`.

After the fixes, run the bootstrap again. After every distribution upgrade, also reboot once and run
`sudo -iu deploy /usr/local/libexec/slk-st/deploy-command status` to confirm the stack came back.

## Upstream files changed by this deployment

- `bin/cli/check-plan.ts`, `bin/cli/check-command.ts`, `bin/cli/index.ts`, `docs/CHECKS.md`:
  `slk check release --origin <https-origin>` runs the read-only release checks against another
  deployment. The upstream `--target staging|production` origins are unchanged.
- New `bin/cli/check-origin.test.ts`: tests for `--origin`.
- `bin/cli/host-backup.ts` (bug fix): nightly dumps load the database credentials through the
  slk-env loader, as `release-backup.ts` already does. Test: new `bin/cli/host-backup-shell.test.ts`.
- `caddy/global-options.caddy`: an optional `import servers.d/*.caddy` inside `servers` for host-specific
  server options such as trusted proxies. Without files nothing changes (Caddy only logs that the
  glob matched nothing). `caddy/application.caddy` and `caddy/directus.caddy` use `{client_ip}`
  instead of `{remote_host}` for `X-Real-IP` and the rate-limit keys; without trusted proxies both
  are the same address, and a client still cannot forge it.
- `caddy/directus.caddy`, `caddy/legacy-cms.caddy`: the CMS and website origins can be overridden
  with `SLK_CADDY_CMS_ORIGIN` and `SLK_CADDY_WEBSITE_ORIGIN`. Defaults are upstream's hostnames, so
  installed bytes and upstream behavior are unchanged.
