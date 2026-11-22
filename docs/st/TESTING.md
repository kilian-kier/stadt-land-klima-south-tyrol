# St regression testing

This st gates upstream syncs, own changes and (later) deployments on a
full-stack end-to-end workflow in addition to upstream's static/unit
`quality.yml`. Its goal is that a regression is visible in CI before a client
sees it.

## What runs where

| Workflow                 | Trigger                                                | Environment                                                            | Purpose                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality.yml` (upstream) | push/PR, weekly                                        | ubuntu, no application stack                                           | Strict compilers, lint, formatting, the unit gate (`bin/test_suite` unit files, the CLI tests `bin/cli/*.test.ts`, CMS CLI unit tests, Go tests), extension builds, image audit, Caddy |
| `st-e2e.yml` (st)        | push to `main`, pull requests, manual, `workflow_call` | ubuntu-latest (26.04), rootless Podman 5.7, complete development stack | Everything below; callable without inputs as a deploy/sync gate                                                                                                                        |

Callers (upstream sync, deployment) use `uses: ./.github/workflows/st-e2e.yml`
with the optional `ref` input (commit, branch or tag); every job checks out that
ref and records the tested commit (`git rev-parse HEAD`) as a notice annotation.
Without `ref` the triggering commit is tested. The concurrency group includes
the calling workflow's name, so standalone, sync and deploy runs never cancel
each other. Jobs run on `ubuntu-26.04` (Podman 5.7, netavark 1.16,
podman-compose 1.6.0 via pipx), without the unsafe Podman version override.
Failed-log annotations are emitted by `src/st/annotateFailure.ts` (via
`ci-step.sh`); they can be replaced by the shared `st-annotate-failure` action.

`st-e2e.yml` has four parallel jobs. The three stack jobs each boot their own
disposable stack with `.github/actions/st-dev-stack` (about 13 minutes cold):

1. `node bin/test_suite/src/st/ciEnvironment.ts --force` writes the four private
   dotenv files from the maintained `*.env.example` files with freshly generated
   secrets (mode 0600). DeepL/Listmonk/CARTO/Plausible keys are empty, content
   translation is off and mail uses the development sendmail logger. The
   runner's distro seccomp profile is copied to a private regular file because
   the host preflight (correctly) refuses the packaged one.
2. `slzFixtureServer.ts` starts on the host (port 18090). The frontend reaches
   it as `http://host.containers.internal:18090` instead of the external
   Stadt.Land.Zahl service. It knows the country, the states used by region
   pages and one data product, but has no datasets or overview snapshots (empty
   lists, 404 for other records); every request is logged to
   `.reports/st-e2e/slz-requests.log`. A CI step verifies that the frontend
   container reaches it.
3. `./bin/slk stack doctor|build --env development`, then
   `./bin/slk stack start --env development --import --prepare-only` imports the
   YAML configuration and seeds into an empty database.
4. `ciFlowUrls.ts` writes the actually imported mail-flow IDs into the frontend
   env and the restricted translation-worker identity is provisioned as
   documented in `DYNAMIC_CONTENT_TRANSLATION.md` (generation stays disabled).
   Both happen before the frontend starts, because the Nuxt development server
   restarts (answering 503) whenever its env file changes. Then
   `./bin/slk stack start --env development` provisions the private service
   identities and starts the frontend; startup waits for CMS health, the HTML
   shell and the CMS-backed layout/catalogue APIs.
5. `seedDemoContent.ts` creates the deterministic `ci-demo` dataset through the
   admin API and the real hooks/flows: current agreement versions, a current
   catalogue with 37 measures in all six sectors (every catalogue identifier
   that has a Wahlcheck thesis template, so thesis generation can pick ten), the
   thesis templates, a complete published and an in-progress municipality (a
   verified team admin publishes), news and events spread over the surrounding
   months, an event series, projects with an image, CMS pages including the
   homepage, production-like header dropdowns and footer columns, a climate
   tool, an organisation team, an organisation, a job and a suspended legacy
   browser identity (for the credential revocation check). Re-running it changes
   nothing. Its manifest (`.reports/st-e2e/demo-manifest.json`) lists the slugs.
6. `import-all.sh` runs once more so the importer's homepage seed adds its
   landing block to the seeded homepage, and one unchecked browser visit per
   public route lets Nuxt/Vite finish on-demand compilation and client
   dependency optimisation (which otherwise answers stale chunks with 504 and
   reloads open pages mid-test).

| Job          | Checks                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public`     | St helper unit tests; import idempotency; permission boundaries; public API contracts; route crawl (de-DE, en-GB, it-IT); desktop/mobile interactions; upstream `test:public`, `test:seo`, `test:styles`, `test:header-navigation:browser`, `test:ui-feedback`, `test:feedback-followup`, `test:municipality-ux:live`                                                                                              |
| `live`       | Live suite fast and `--full` profiles (`src/run.ts`), `test:blokkli`, `test:content-translation:database`, `test:content-translation:reader`, `test:security:preview`, `test:security:migration` (after a production build for the artifact disclosure gate, made once the live suites are done), `test:legacy-buttons`, `test:project-map:live`, CMS CLI live integration (`src/directus/cli` `test:integration`) |
| `isolated`   | `test:data-dashboard:browser` (its own Nuxt development server with isolated CMS/data fixtures)                                                                                                                                                                                                                                                                                                                    |
| `production` | The production frontend (`nuxt build` without private configuration, served with `node .output/server/index.mjs` on the host against the job's CMS, a disposable Redis and the SLZ stand-in; `src/st/productionFrontend.sh`): public API contracts and the full route crawl in three languages, so production SSR, bundling, hydration and the production CSP (violations surface as console errors) are checked   |

`SLK_TEST_OFFLINE_BASEMAP=1` makes the upstream browser helpers
(`lib/browser.ts`) replace CARTO basemap proxy assets with neutral fixtures: the
proxy needs a paid key and internet access and otherwise answers 503 by design.
Deployed checks never set it.

Every check step runs through `bin/test_suite/src/st/ci-step.sh`, which keeps a
complete log under `.reports/st-e2e/<step>.log`. Later checks still run after a
failure; the job fails if any check failed. A failed step immediately emits its
log as error annotations (TestRunner failure summary first, then the end of the
log, in chunks that fit GitHub's limits); killed/timed-out steps and the
CMS/frontend container logs are annotated by the job's final step. Annotations
are readable without login through
`GET /repos/{owner}/{repo}/check-runs/{job_id}/annotations`. All reports,
screenshots, container logs, the SLZ request log and the demo manifest are
uploaded as the `st-e2e-<job>` artifacts for 14 days.

### St-owned checks (`bin/test_suite/src/st/`)

| Script                                           | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicRoutes.browser.ts` (`st:crawl`)           | Every `PUBLIC_NUXT_ROUTES` entry plus seeded municipalities (with and without catalogue), measures, sector pages, news, events, series, projects, jobs, CMS pages and discovered tours, in three locales: HTTP 200, `<html lang>`, non-empty title, no raw translation keys in title/description/body, no uncaught page errors, console errors or hydration mismatches (with Vue's mismatch details), no same-origin 5xx and no unexpected `/api/public/*` 4xx. Unknown records must render a 404 page. Non-GET (except client failure telemetry) and other-origin requests are aborted. Findings are grouped by message. |
| `apiContracts.ts` (`st:contracts`)               | `/api/public/*` responses parse with the checked zod contracts in `src/frontend/shared/contracts` (transforming contracts are checked in their output shape), contain no credential-like fields, list the seeded published records, hide unpublished results on the map, and unknown records return 404 (an unknown municipality is an empty lookup by design).                                                                                                                                                                                                                                                           |
| `interactions.browser.ts` (`st:interactions`)    | Desktop (1440 px) and touch mobile (390 px): header dropdown/drawer navigation into CMS pages, the real search palette (local search index), the language selector persisting via `slk_locale` across client navigation, new tabs and a new visit with another browser language, theme toggle persisting across navigation and reload.                                                                                                                                                                                                                                                                                    |
| `permissionBoundaries.ts` (`st:permissions`)     | Every imported permission row (collection, action, item filter, validation, presets, fields) equals the YAML and anonymous access is exactly the YAML Public role; the Public policy only reads public-folder files/folders; anonymous users cannot read or write any collection or administrative endpoint; files in non-public folders are not anonymously readable while public-folder assets are; Frontend-Public, Frontend-Server and Frontend-Preview read exactly their granted collections and system endpoints and cannot write elsewhere.                                                                       |
| `importIdempotency.ts` (`st:import-idempotency`) | Runs the documented `import-all.sh` twice on the running stack; the second run must succeed without restarting the CMS and leave the schema snapshot, roles, policies, permissions, access, flows, operations, presets, translations, dashboards, panels, folders, settings and seeded content counts unchanged (rows the importer recreates by design are compared by content, not by id).                                                                                                                                                                                                                               |
| `helpers.test.ts` (`test:st:unit`)               | The helpers above (env generation, fixtures, annotation chunking, known-failure classification, translation-key detection, snapshot comparison).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Running locally

Prepare the host as in [PODMAN.md](../../PODMAN.md#host-requirements) and use
the Node version from `.node-version`. With an existing development stack:

```bash
npm ci --prefix bin && npm ci --prefix bin/test_suite && npm ci --prefix src/frontend
npm --prefix bin/test_suite exec -- playwright install chromium
cd bin/test_suite
npm run st:seed -- http://localhost:8081 http://localhost:8080 ../../src/directus/.env
npm run st:contracts -- http://localhost:8080 ../../.reports/st-e2e/demo-manifest.json
npm run st:crawl -- http://localhost:8080 ../../.reports/st-e2e/demo-manifest.json
npm run st:interactions -- http://localhost:8080
npm run st:permissions -- http://localhost:8081 http://localhost:8080 ../../src/directus/.env
npm run st:import-idempotency -- http://localhost:8081 http://localhost:8080 ../../src/directus/.env
npm run test:st:unit
```

`st:seed` adds demo records to the selected CMS and refuses non-loopback URLs;
use a disposable stack if local data must stay untouched. The upstream suites
run as documented in [the test suite README](../../bin/test_suite/README.md),
for example `./bin/slk test dev` / `./bin/slk test full` and
`./bin/slk check ready`.

To reproduce CI from scratch on a disposable Linux host (this overwrites the
four private dotenv files, so never do it in a checkout with real
configuration):

```bash
node bin/test_suite/src/st/ciEnvironment.ts --force
node bin/test_suite/src/st/slzFixtureServer.ts 18090 .reports/st-e2e/slz-requests.log &
./bin/slk stack build --env development
./bin/slk stack start --env development --import --prepare-only
node bin/test_suite/src/st/ciFlowUrls.ts http://127.0.0.1:8081
./bin/slk stack start --env development
(cd bin/test_suite && npm run st:seed -- http://localhost:8081 http://localhost:8080 ../../src/directus/.env)
./bin/slk stack compose --env development -- exec -T directus /directus/cli/import-all.sh
```

## Adding tests

- Put st-owned checks in `bin/test_suite/src/st/` and register an npm script
  with the `st:` prefix (or `test:st:` for isolated tests) so upstream merges
  rarely conflict. Use the existing helpers (`lib/browser.ts`,
  `lib/directus.ts`, `lib/config.ts`, `lib/wait.ts`) and TypeScript.
- Add the step to the matching job in `.github/workflows/st-e2e.yml` through
  `src/st/ci-step.sh <name> <command>` with
  `if: ${{ !cancelled() && steps.stack.outcome == 'success' }}` and a
  `timeout-minutes`, so later checks still run and a hang cannot consume the
  job.
- Read-only checks use the demo manifest; writable checks create their own
  records with unique names and clean them up, like the upstream fixture flows.
- Wait for concrete conditions (`waitForHydration`, URL/locator expectations,
  `waitFor` on an API state). No fixed sleeps and no retries of failed
  assertions.
- Block other origins in browser checks; no test may depend on the internet.
  Extend `slzFixtureServer.ts` or `offlineProviders.ts` when a page needs an
  external provider, and `seedDemoContent.ts` (idempotently) when it needs
  content.
- Run `npm run test:st:unit` and Prettier (repository `.prettierrc.json`) before
  pushing; `quality.yml` type-checks and format-checks these files too.

## Known failures

Known application defects are listed explicitly in
`bin/test_suite/src/st/knownFailures.ts` (id, suite, matching finding, reason,
tracking). St checks report them as `KNOWN`; for upstream suites run as CI steps
(suite `step:<name>`) every failure listed in the TestRunner summary must match
a registered entry, otherwise the step fails. A KNOWN finding is emitted as a
warning annotation. The only other permitted entry type is an explicitly
`quarantined` failure whose cause (application or test) is not yet determined;
it must match that exact failure and is reported as QUARANTINED. An entry that
no longer occurs fails the run as `FIXED`, so it is removed instead of masking a
later regression. Test or CI problems are never listed there; they are fixed
instead.

| Id                                            | Suite                 | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error-page-title`                            | `crawl`               | `src/frontend/error.vue` renders no `<title>` and hardcoded German text (also on English/Italian pages) instead of translation keys (AGENTS.md rule 15); needs new de/en/it translation keys.                                                                                                                                                                                                                                                                                                  |
| `dashboard-detail-range-dialog` (quarantined) | `step:data-dashboard` | On the product detail page, choosing a histogram range after a snapshot change shows no municipality link in the range dialog. Not yet determined whether `pages/data/[slug]/[collection].vue` or the upstream test fixture is wrong; three stale expectations earlier in this test were fixed. The remaining dashboard steps after this point do not run until it is resolved. Evidence: runs 44941266055 and 44944163395 (QUARANTINED warning, all other dashboard steps before it passing). |

## Defects found and fixed by this suite

- `CanonicalButton.vue`: the keyboard `:focus-visible` outline lost against the
  more specific filled hover rule, so a hovered and keyboard-focused button
  showed the hover colour instead of the distinct focus colour (dark theme).
- `pages/measures/sectors/index.vue` (found by the production crawl): the
  unlinked sector index rendered an empty page with HTTP 200 and a hydration
  mismatch in production; its template only carried a "404 Page" comment. It now
  throws a 404.
- `EventCard.vue`: the calendar icon path had an invalid SVG arc flag, logging a
  console error for every event card.
- `pages/data/index.vue`: the data-product manifest error flag was a plain `ref`
  set during SSR, so whenever the data service was unavailable the server
  rendered "loading error" and the client "currently unavailable" (hydration
  mismatch in all three languages). It is now `useState`.
- `nuxt.config.ts`: `htmlparser2` and `dom-serializer` (CMS HTML rendering) were
  missing from the maintained `vite.optimizeDeps.include` list, so the
  development server discovered them at runtime and reloaded open pages
  (interrupting the dashboard browser test and local work).
- `assets/css/main.css`: the news/event month strip used fixed 1rem/1.5rem
  insets and a width cap 2rem below the 1280px content width, so from 768px
  (32px page gutter) it no longer started, ended and clipped at the page content
  edges required by `docs/DESIGN_GUIDELINES.md`. It now uses the shared
  `--slk-page-gutter`.
- Stale upstream test expectations (not application bugs): the data-dashboard
  detail link (path instead of the current hash form), the dashboard fixture's
  second metric without a description (active-metric headings belong to
  description sections), an immediate colour-mode URL check that raced the
  canonical query update, Wahlcheck wizard answers clicked (forced) while the
  question carousel was still sliding, the data construction notice selector
  removed in `8ee4e4aa`, and the municipality sidebar icon size (28 px large
  icons per `docs/DESIGN_GUIDELINES.md`).

## Not covered

- Top open gap: the production container image, Caddy in front of it and the
  production confinement audit. The `production` job runs the production
  frontend output directly on the host (no image, no Caddy, no Meilisearch, so
  search degrades), and `test:security:csp` (fresh nonce per response,
  `strict-dynamic`) is not run against it yet. The runner has no effective
  container LSM confinement, so `slk stack --env production` refuses it by
  design. Development error pages keep the strict fallback CSP of
  `server/errorHandler.ts` and are therefore not hydrated; the crawl checks
  their status, language and title only.
- `test:regions:browser` needs real Stadt.Land.Zahl region datasets
  (municipality overview tiles and lists); the offline stand-in only provides
  the area records.
- Real external providers (Stadt.Land.Zahl data, DeepL, Listmonk, SMTP delivery
  and mail capture, CARTO tiles, cal.com, Plausible). They are disabled or
  replaced by fixtures; provider contracts are covered by the upstream unit
  suites and the isolated dashboard browser test.
- Native macOS/Windows and deployed staging/production acceptance
  (`./bin/slk check native`, `./bin/slk check release --target staging`).
