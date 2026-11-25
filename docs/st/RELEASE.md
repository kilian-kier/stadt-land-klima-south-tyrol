# Releases

Feature branches go to `main` through pull requests (upstream's quality checks run on every pull
request). A release is one manual run of **Actions → Release** (`.github/workflows/st-release.yml`)
for one commit of `main`. The server itself is described in [DEPLOYMENT.md](DEPLOYMENT.md).

## What a release run does

1. **resolve:** turns the requested ref (default `main`) into a full commit SHA, refuses commits
   that are not contained in `main` and names the release `release-YYYYMMDD-N`.
2. **build** (runner): `deploy/st/build-release.sh` builds every image and the production frontend
   output once and uploads them as the artifact `release-<sha>` (7 days). The commit, release name
   and build time are baked in and served by `GET /api/version`.
3. **quality** and **e2e**, in parallel with the build: upstream's quality gate and the full-stack
   suite (`st-e2e.yml`, about 30 minutes) on exactly that commit. See [TESTING.md](TESTING.md).
4. **production:** waits for your approval in the `production` environment. It then uploads the
   artifact to the server, deploys it (backup → stage → activate, automatic rollback on failure) and
   runs the public smoke checks, which require `/api/version` to report the released commit. If the
   smoke checks fail, it rolls the server back to the previous release.
5. **record:** moves the `production` branch to the released commit, tags it `release-YYYYMMDD-N`
   and writes a summary with the changes since the previous release.

Until the repository variable `ST_PRODUCTION_DEPLOY` is `true`, steps 4 and 5 are skipped and the
run ends after a successful build and test ("Deployment skipped").

## Which version is live

| Question                                     | Where                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| What is in production?                       | the `production` branch, or Deployments on the repository page |
| What would the next release contain?         | `compare/production...main`                                    |
| What is really running?                      | `https://<site>/api/version`                                   |
| When was what released, and who approved it? | Deployments history, `release-*` tags                          |

## Rolling back

- Automatic: a failed activation is rolled back by the server; failed smoke checks are rolled back
  by the workflow.
- Manual: **Actions → Rollback**, enter the commit of the active release (the `production`
  branch). After your approval it restores the release before it, runs the smoke checks and moves
  `production` to the commit `/api/version` now reports. Releasing an older commit through the
  Release workflow is refused, because the server only moves forward.
- Rollbacks restore application images and frontend output, not data
  (DEPLOYMENT.md, "What a rollback restores").

## Weekly upstream sync

Every Saturday night upstream's `main` is merged, tested and proposed as a pull request; see
[UPSTREAM_SYNC.md](UPSTREAM_SYNC.md). Merging it does not deploy anything. Release when you are ready.

## Planned (second stage)

A staging site on a GitHub runner with an anonymized copy of the production data, reachable through
a password-protected temporary address while the release waits for approval, plus a `staging` pointer
branch.
