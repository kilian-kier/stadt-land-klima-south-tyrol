# Staging

Every release run can show the release before it reaches production: the exact artifact that will
be deployed, with an anonymized copy of the production data, on a GitHub runner that lives only
while the release waits for approval. Nothing runs permanently and nothing is paid for.

## What happens

The `staging` job of **Actions → Release** (`.github/workflows/st-release.yml`) starts after the
build, the quality gate and the full suite have passed:

1. **Snapshot.** It asks the server for `snapshot` with a key that may do nothing else. The server
   dumps the production database, restores the dump into a temporary database, anonymizes it there
   and verifies the result (`deploy/st/snapshot.sh`, `deploy/st/anonymize-snapshot.mts`). Only the
   anonymized copy and the uploaded files that public content uses leave the server. Production is
   only read; the snapshot holds the deployment lock, so it never overlaps a release.
2. **Server.** The runner is prepared like a fresh Ubuntu server and `bootstrap-ubuntu.sh` installs
   the release from the build artifact, with the snapshot as its data
   (`deploy/st/runner-staging.sh`). The configuration import then migrates that data exactly as the
   release will migrate production.
3. **Addresses.** Two Cloudflare quick tunnels give the website and the CMS random
   `https://….trycloudflare.com` addresses. No account, DNS entry or firewall change is needed.
4. **Checks.** The usual smoke checks run against the tunnels, including `/api/version`. The
   website asks for a password (user `staging`, password: the `STAGING_PASSWORD` secret) and sends
   `X-Robots-Tag: noindex`.
5. **Review.** As soon as staging is up, the run page shows the website address on the `staging`
   deployment ("View deployment"; also under **Deployments**), and the `staging` branch
   points to the staged commit. The job keeps serving until the production job of the same run has
   finished, or at most the number of hours chosen when starting the run (default 3, at most 5).

The production job waits for your approval as before. After the approval it also waits until the
staging smoke checks have passed; if staging failed, production is not deployed.

## What the snapshot contains

The rule: what the public website shows stays, everything internal, unpublished or personal is
replaced or removed.

- Email addresses become `anon-<hash>@example.invalid`, names `Anon <hash>`, free text
  `[anonymized]`, drafts `{}`; passwords, tokens, two-factor secrets, phone numbers, IP addresses
  and user agents are removed. Members shown on the team page keep their public name, picture and
  text; their email address and login are removed too.
- Sessions, shares, notifications and revision history are emptied.
- Only files referenced by published public content, team page pictures, the project logo and the
  `public` folder are kept.
- The verification fails closed: a remaining value or any real-looking email address in a private
  table stops the snapshot before anything leaves the server. CI runs the same script against the
  test stack after the live suites (`bin/test_suite/src/st/snapshot-anonymization.sh`).

The list of private columns is in `deploy/st/anonymize-snapshot.mts`. A new private field in the
schema must be added there; until then the email scan is the safety net for addresses only.

Because every account is anonymized, nobody can log in to the staging CMS. Staging is for looking at
the website; it sends no emails (the snapshot holds no real addresses) and keeps no backups.

## Setup (once)

1. On your computer, create the staging key:

   ```bash
   ssh-keygen -t ed25519 -N '' -C slk-st-snapshot -f slk-st-snapshot
   ```

2. Release a commit that contains staging (with `ST_STAGING` still unset). Then, on the server,
   copy `slk-st-snapshot.pub` to `/root` and re-run the bootstrap from the reviewed clone at the
   deployed commit, with the options you used before plus the staging key. It installs the
   snapshot scripts and allows that key nothing but `snapshot`:

   ```bash
   sudo git -C /opt/slk-host fetch origin main
   sudo git -C /opt/slk-host checkout --detach <deployed sha>
   sudo /opt/slk-host/deploy/st/bootstrap-ubuntu.sh <the same options as before> \
     --snapshot-public-key /root/slk-st-snapshot.pub
   ```

3. In GitHub, **Settings → Environments → New environment** `staging`, limited to the `main`
   branch, with the secrets
   - `DEPLOY_SSH_HOST`, `DEPLOY_SSH_PORT`, `DEPLOY_SSH_USER`, `DEPLOY_KNOWN_HOSTS`: the same values
     as in `production`
   - `DEPLOY_SSH_KEY`: the private half `slk-st-snapshot` (not the production key)
   - `STAGING_PASSWORD`: the website password for reviewers

4. **Settings → Secrets and variables → Actions → Variables:** `ST_STAGING` = `true`.

Without `ST_STAGING`, releases run as before: no staging job, and production does not wait for one.

## Limits

- The addresses change with every run. The website address is on the run's `staging` deployment;
  both addresses are in the log of the staging job (step "Start the tunnels").
- The runner has 16 GB of memory instead of the server's 2 GB, so staging does not show memory
  problems (the full suite measures memory instead).
- Rate limits see every visitor as the tunnel; this only matters for load tests.
- Quick tunnels are a free Cloudflare service without an uptime guarantee. If one stops, the job
  fails; start a new release run.
