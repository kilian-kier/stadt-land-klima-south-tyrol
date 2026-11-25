# Upstream sync

`.github/workflows/st-upstream-sync.yml` keeps this repository in sync with
[StrategieLukas/stadt-land-klima](https://github.com/StrategieLukas/stadt-land-klima)
without ever rewriting `main`. It runs weekly on Saturday at 22:00 UTC and on manual dispatch
(Actions → Upstream sync → Run workflow; `force` rebuilds and re-tests an
unchanged sync branch).

## Behavior

1. **Fetch.** The workflow checks out the default branch and fetches upstream
   `main` (override with the repository variables `SLK_UPSTREAM_REPOSITORY` and
   `SLK_UPSTREAM_BRANCH`). If `main` already contains the upstream head, it stops
   and closes an open conflict issue.
2. **Skip unchanged work.** If `sync/upstream` already is the merge of the current
   `main` and upstream heads and carries a final `upstream-sync` status,
   nothing is re-tested unless `force` is set. An interrupted run (status still
   pending or missing) is rebuilt by the next run.
3. **Merge.** It creates a regular merge commit
   (`Merge <repo> main (<sha>) into main`) on top of `main`.
   - **Conflict:** the merge is aborted and nothing is pushed. An issue titled
     _Upstream sync blocked by merge conflicts_ lists the conflicting files and the
     commands for a manual merge; the run fails with one annotation per file.
     Later runs update the same issue, and the first clean sync closes it.
4. **Push.** The merge is pushed to `sync/upstream` (replacing the previous
   candidate; the branch belongs to the workflow, do not commit to it) and a
   `pending` commit status `upstream-sync` is set on the merge commit.
5. **Gates.** The merge commit is tested inside the same run through
   `workflow_call`: `quality.yml` and `st-e2e.yml`, both with
   `ref: <merge sha>`. This is necessary because pushes and pull requests created
   with `GITHUB_TOKEN` do not trigger other workflows. The gate workflow
   definitions come from `main`; the code under test is the merge result.
6. **Report.** The commit status becomes `success` or `failure`, and a pull
   request `sync/upstream → main` is opened or updated with the gate results,
   the incoming upstream commits and a file summary.
7. **Auto-merge.** If both quality and end-to-end gates pass and the
   `SLK_UPSTREAM_SYNC_TOKEN` secret is configured, the workflow enables auto-merge
   on the pull request using the MERGE method. The PR will be merged automatically
   once all branch protection requirements are satisfied. If the token is not
   configured, the PR is left open for manual merge.

Merge sync pull requests with a **merge commit** (not squash or rebase), otherwise
the next sync re-applies the same upstream history and conflicts.

### Resolving a conflict manually

```sh
git fetch https://github.com/StrategieLukas/stadt-land-klima.git main
git switch -c sync/upstream-manual origin/main
git merge FETCH_HEAD        # resolve, then commit
git push -u origin sync/upstream-manual
```

Open a pull request to `main`; its normal `pull_request` checks run because it
was pushed by a person. After it is merged, the next scheduled sync closes the
conflict issue.

## Required repository settings

| Setting                                                                                                | Why                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Actions → General → Workflow permissions: **Read repository contents** (default) is enough             | Each job requests its own write scopes (`contents`, `statuses`, `issues`, `pull-requests`) explicitly. |
| Actions → General → **Allow GitHub Actions to create and approve pull requests**                       | Required for `gh pr create` with `GITHUB_TOKEN`.                                                       |
| General → Features → **Issues** enabled                                                                | Conflict reports are issues. Without it, conflicts only fail the run.                                  |
| Actions tab: enable workflows                                                                          | GitHub may disable scheduled workflows in repositories; enable them in the Actions tab.                |
| No branch protection/rulesets that block the workflow from force-pushing `sync/upstream`               | The candidate branch is rebuilt on every run.                                                          |
| Optional: require the `upstream-sync` status only on rulesets that target the sync PR, not all of main | Other pull requests do not receive this status.                                                        |

### Optional token for workflow file changes and auto-merge

`GITHUB_TOKEN` can never push commits that add or change files under
`.github/workflows/`. When upstream changes a workflow, the push fails with an
annotation that names this setting. Create a fine-grained personal access token
limited to this repository with **Contents: read and write**, **Pull requests:
read and write** and **Workflows: read and write**, and store it as the Actions
secret `SLK_UPSTREAM_SYNC_TOKEN`. The workflow then uses it to push and to open
the pull request; commit statuses still use `GITHUB_TOKEN`. Because a personal
token is not `GITHUB_TOKEN`, its pull request also triggers the regular
`pull_request` workflows. Rotate it before it expires.

**Auto-merge:** When `SLK_UPSTREAM_SYNC_TOKEN` is configured and both gates pass,
the workflow automatically enables auto-merge on the sync PR with the MERGE method.
The PR will be merged automatically once all branch protection requirements are met.
Without the token, the PR is left open for manual review and merge.

## Upstream-owned files changed by this repository's CI

Changes made to upstream workflow files to support the sync process:

- `.github/workflows/quality.yml`: `workflow_call` with optional `ref` for gate testing.
- `.github/workflows/st-e2e.yml`: Created for end-to-end testing with `workflow_call` support.
- Other CI infrastructure files as needed for testing and deployment.
