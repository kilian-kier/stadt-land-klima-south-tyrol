import assert from "node:assert/strict";
import { test } from "node:test";
import { annotationChunks, escapeAnnotation, escapeProperty, logTail } from "./annotateFailure.js";
import { applyOverrides, ciEnvironment } from "./ciEnvironment.js";
import { demo } from "./demoManifest.js";
import { differences, normalize, withoutSurrogates } from "./importIdempotency.js";
import { classifyFindings, classifyStep, stepFindings, type KnownFailure } from "./knownFailures.js";
import { basemapFixture } from "./offlineProviders.js";
import { fixtureResponse } from "./slzFixtureServer.js";
import { CollectionsResponseSchema } from "../../../../src/frontend/shared/contracts/slz.js";
import { isHydrationMessage, rawTranslationKeys, staticRoutes } from "./publicRoutes.browser.js";

test("env overrides replace active keys, keep comments and append missing keys", () => {
  const source = "# KEY=commented\nKEY=old\nOTHER=1 # note\r\n\n";
  assert.equal(
    applyOverrides(source, { KEY: "new", ADDED: "x" }),
    "# KEY=commented\nKEY=new\nOTHER=1 # note\nADDED=x\n",
  );
});

test("generated CI secrets are fresh, strong and consistent between database and CMS", () => {
  const first = ciEnvironment();
  const second = ciEnvironment();
  assert.equal(first.db.POSTGRES_PASSWORD, first.directus.DB_PASSWORD);
  assert.notEqual(first.directus.SECRET, second.directus.SECRET);
  assert.match(first.directus.CLI_DIRECTUS_STATIC_TOKEN!, /^[A-Za-z0-9_-]{32,255}$/);
  assert.ok(first.frontend.ALTCHA_SECRET!.length >= 32);
  assert.equal(first.frontend.STADTLANDZAHL_SERVER_BASE_URL, "http://host.containers.internal:18090");
  assert.equal(first.frontend.STADTLANDZAHL_BASE_URL, "http://127.0.0.1:18090");
  assert.equal(first.frontend.DEEPL_API_KEY, "");
  assert.equal(first.frontend.LISTMONK_ENDPOINT, "");
});

test("demo passwords are deterministic per stack secret and differ between stacks", () => {
  const env = { SECRET: "a", ADMIN_PASSWORD: "b" };
  assert.equal(demo.password(env), demo.password({ ...env }));
  assert.notEqual(demo.password(env), demo.password({ ...env, SECRET: "c" }));
});

test("annotations escape GitHub workflow command syntax and keep bounded tails", () => {
  assert.equal(escapeAnnotation("50% done\r\nnext"), "50%25 done%0Anext");
  assert.equal(escapeProperty("a: b, c"), "a%3A b%2C c");
  const tail = logTail(`${"x".repeat(5000)}\nkept line\n\u001b[31mred\u001b[0m`, 100);
  assert.ok(tail.length <= 100);
  assert.ok(tail.endsWith("kept line\nred"));
});

test("known failures are explicit: matching findings are known, missing ones are stale", () => {
  const entries: KnownFailure[] = [
    { id: "a", suite: "crawl", pattern: /\/broken/, reason: "bug", tracking: "issue" },
    { id: "b", suite: "crawl", pattern: /\/fixed/, reason: "bug", tracking: "issue" },
  ];
  const result = classifyFindings("crawl", ["de-DE /broken: error", "de-DE /new: error"], entries);
  assert.deepEqual(result.failures, ["de-DE /new: error"]);
  assert.deepEqual(
    result.known.map((item) => item.entry.id),
    ["a"],
  );
  assert.deepEqual(
    result.fixed.map((entry) => entry.id),
    ["b"],
  );
});

test("raw translation keys are detected only for real dotted catalogue keys", () => {
  assert.deepEqual(rawTranslationKeys("Titel news.title und example.org"), ["news.title"]);
  assert.deepEqual(rawTranslationKeys("Neuigkeiten"), []);
  assert.ok(isHydrationMessage("[Vue warn]: Hydration text content mismatch on <p>"));
  assert.ok(isHydrationMessage("Hydration completed but contains mismatches."));
  assert.ok(!isHydrationMessage("hydration finished"));
});

test("the crawl covers every canonical public route", () => {
  const paths = staticRoutes().map((route) => route.path);
  for (const path of ["/", "/municipalities", "/measures", "/news", "/projects", "/data", "/elections/wahlcheck"])
    assert.ok(paths.includes(path), path);
});

test("import snapshots ignore audit fields and array order but report real changes", () => {
  const before = normalize([
    { id: 2, name: "b", date_updated: "1" },
    { id: 1, name: "a", date_updated: "1" },
  ]);
  const same = normalize([
    { id: 1, name: "a", date_updated: "2" },
    { id: 2, name: "b", date_updated: "3" },
  ]);
  assert.deepEqual(differences(before, same), []);
  const changed = normalize([
    { id: 1, name: "a" },
    { id: 2, name: "changed" },
  ]);
  assert.deepEqual(differences(before, changed), ['$[1].name: "b" -> "changed"']);
});

test("only CARTO basemap assets are replaced by offline fixtures", () => {
  const asset = (path: string) => basemapFixture(new URL(`http://localhost:8080/api/carto-basemap?asset=${path}`));
  assert.equal(asset("/light_all/3/4/2.png")?.contentType, "image/png");
  assert.equal(asset("/gl/positron-gl-style/sprite.json")?.body, "{}");
  assert.equal(asset("/fonts/Open Sans Regular/0-255.pbf")?.contentType, "application/x-protobuf");
  assert.equal(basemapFixture(new URL("http://localhost:8080/api/public/map")), null);
});

test("known step failures must cover every reported failure and become stale when fixed", () => {
  const quiet = () => undefined;
  const entries: KnownFailure[] = [
    { id: "known", suite: "step:live", pattern: /Known bug/, reason: "bug", tracking: "issue" },
  ];
  const summary = (failures: string) =>
    `[FAIL] x\n\n================ Test Summary ================\nPassed: 1\nFailed: 2\n\nFailures:\n${failures}`;
  assert.deepEqual(stepFindings(summary("- A (assertion): Known bug\n- B (error): Other\n")), [
    "- A (assertion): Known bug",
    "- B (error): Other",
  ]);
  assert.equal(classifyStep("live", summary("- A (assertion): Known bug\n"), 1, entries, quiet), 0);
  assert.equal(classifyStep("live", summary("- A (assertion): Known bug\n- B (error): Other\n"), 1, entries, quiet), 1);
  assert.equal(classifyStep("live", "all good", 0, entries, quiet), 1, "a fixed known failure must be removed");
  assert.equal(classifyStep("other", "boom", 2, entries, quiet), 2);
  assert.equal(classifyStep("other", "fine", 0, entries, quiet), 0);
});

test("annotation chunks keep the failure summary and the end of long logs within GitHub limits", () => {
  const log = `${"noise\n".repeat(5000)}================ Test Summary ================\nPassed: 1\n\nFailures:\n- step (error): boom\n${"tail\n".repeat(100)}end`;
  const chunks = annotationChunks(log, 3, 500);
  assert.ok(chunks.length <= 3 && chunks.every((chunk) => chunk.length <= 500));
  assert.ok(chunks[0]!.startsWith("Failures:\n- step (error): boom"));
  assert.ok(chunks.at(-1)!.endsWith("end"));
});

test("permission rows are compared by content, not by the ids the importer recreates", () => {
  const first = normalize(
    withoutSurrogates("/permissions", [
      { id: 1, policy: "p", collection: "news_items", action: "read" },
      { id: 2, policy: "p", collection: "news_items", action: "create" },
    ]),
  );
  const second = normalize(
    withoutSurrogates("/permissions", [
      { id: 9, policy: "p", collection: "news_items", action: "create" },
      { id: 8, policy: "p", collection: "news_items", action: "read" },
    ]),
  );
  assert.deepEqual(differences(first, second), []);
  assert.deepEqual(withoutSurrogates("/policies", [{ id: "a", name: "P", permissions: [1] }]), [
    { id: "a", name: "P" },
  ]);
});

test("the Stadt.Land.Zahl fixture answers empty lists and missing records, never data", () => {
  assert.deepEqual(fixtureResponse("GET", "/api/areas/?limit=1"), { status: 200, body: { results: [] } });
  assert.deepEqual(fixtureResponse("GET", "/api/areas/091620000000/nearby/?limit=4").body, { areas: [] });
  assert.equal(fixtureResponse("GET", "/api/areas/091620000000/").status, 404);
  assert.equal((fixtureResponse("GET", "/api/areas/080000000000/").body as { name: string }).name, "Baden-Württemberg");
  assert.equal(fixtureResponse("POST", "/api/areas/").status, 405);
  assert.ok(
    CollectionsResponseSchema.safeParse(fixtureResponse("GET", "/api/manifests/collections-index").body).success,
  );
});

test("records with equal identity keys are ordered by content", () => {
  const panel = (dashboard: string) => ({ name: "Same", dashboard, width: dashboard.length });
  assert.deepEqual(
    differences(
      normalize([panel("Allgemein"), panel("Maßnahmen")]),
      normalize([panel("Maßnahmen"), panel("Allgemein")]),
    ),
    [],
  );
});
