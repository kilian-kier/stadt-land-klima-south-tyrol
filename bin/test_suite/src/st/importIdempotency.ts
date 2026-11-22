/**
 * Code-first import idempotency: running the documented importer on an already
 * imported CMS must succeed and change nothing. The importer runs twice (the first
 * run may still apply seeds that depend on content created after the initial import);
 * the second run must leave schema, access control, flows, presets, translations,
 * dashboards, folders, settings and seeded content counts byte-for-byte unchanged.
 *
 * Usage (repository root CMS env): tsx src/st/importIdempotency.ts <backend-url> <frontend-url> <private-cms-env-file>
 */
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createAdminClient, type DirectusClient } from "../lib/directus.js";
import { waitFor } from "../lib/wait.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const volatile = new Set([
  "date_created",
  "date_updated",
  "user_created",
  "user_updated",
  "last_access",
  "last_page",
  "modified_on",
  "uploaded_on",
  "timestamp",
]);

/** Drop volatile audit fields and order arrays of records by identity for stable comparison. */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normalize);
    const key = (item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? JSON.stringify(
            ["id", "collection", "field", "name", "key", "action", "policy", "role", "user"].map(
              (name) => (item as Record<string, unknown>)[name],
            ),
          )
        : JSON.stringify(item);
    return items.every((item) => item && typeof item === "object" && !Array.isArray(item))
      ? [...items].sort((a, b) => key(a).localeCompare(key(b)) || JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !volatile.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  return value;
}

/** Paths where two normalized documents differ, bounded for readable output. */
export function differences(before: unknown, after: unknown, path = "$", found: string[] = []): string[] {
  if (found.length >= 40) return found;
  if (JSON.stringify(before) === JSON.stringify(after)) return found;
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after as object)]))
      differences(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${path}.${key}`,
        found,
      );
    return found;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((item, index) => differences(item, after[index], `${path}[${index}]`, found));
    return found;
  }
  found.push(`${path}: ${JSON.stringify(before)?.slice(0, 160)} -> ${JSON.stringify(after)?.slice(0, 160)}`);
  return found;
}

/**
 * The importer replaces permission, access, preset and dashboard/panel rows on every run,
 * so their surrogate ids (and the id lists that reference them) change by design; their
 * content is compared instead. Panels reference their dashboard by name.
 */
export const surrogateFields: Record<string, string[]> = {
  "/permissions": ["id"],
  "/access": ["id"],
  "/policies": ["permissions", "roles", "users"],
  "/roles": ["policies", "users", "children"],
  "/presets": ["id"],
  "/dashboards": ["id", "panels"],
  "/panels": ["id"],
};

export function withoutSurrogates(path: string, value: unknown): unknown {
  const dropped = surrogateFields[path];
  if (!dropped || !Array.isArray(value)) return value;
  return value.map((row) =>
    row && typeof row === "object"
      ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => !dropped.includes(key)))
      : row,
  );
}

const configurationEndpoints = [
  "/schema/snapshot",
  "/roles",
  "/policies",
  "/permissions",
  "/access",
  "/flows",
  "/operations",
  "/presets",
  "/translations",
  "/dashboards",
  "/panels",
  "/folders",
  "/settings",
];
const seededCollections = ["pages", "blocks", "measure_questions_template", "success_project_tours", "articles"];

async function snapshot(admin: DirectusClient): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const dashboards = await admin.request<{ id: string; name: string }[]>("GET", "/dashboards", {
    query: { fields: "id,name", limit: -1 },
  });
  const dashboardName = new Map(dashboards.map((dashboard) => [dashboard.id, dashboard.name]));
  for (const path of configurationEndpoints) {
    try {
      let value = await admin.request<unknown>("GET", path, { query: { limit: -1 } });
      if (path === "/panels" && Array.isArray(value))
        value = value.map((panel: Record<string, unknown>) => ({
          ...panel,
          dashboard: dashboardName.get(String(panel.dashboard)) ?? panel.dashboard,
        }));
      result[path] = normalize(withoutSurrogates(path, value));
    } catch (error) {
      throw new Error(`Snapshot of ${path} failed (CMS container: ${cmsContainerState()})`, { cause: error });
    }
  }
  for (const collection of seededCollections)
    result[`count:${collection}`] = (
      await admin.request<{ count: string }[]>("GET", `/items/${collection}`, { query: { "aggregate[count]": "*" } })
    )[0]?.count;
  return result;
}

/** Start time/restart count of the CMS container: a repeated import must not restart it. */
function cmsContainerState(): string {
  const inspect = spawnSync(
    "podman",
    [
      "inspect",
      "--format",
      "{{.State.StartedAt}} restarts={{.RestartCount}} status={{.State.Status}}",
      "slk-podman-development_directus_1",
    ],
    { encoding: "utf8" },
  );
  return inspect.status === 0 ? inspect.stdout.trim() : `unavailable (${inspect.stderr.trim()})`;
}

async function waitForHealth(url: string): Promise<void> {
  await waitFor("CMS health after import", async () => (await fetch(`${url}/server/health`)).ok, {
    timeoutMs: 120_000,
    intervalMs: 1_000,
  });
}

function importAll(label: string): void {
  const started = performance.now();
  const run = spawnSync(
    process.execPath,
    [
      "bin/slk",
      "stack",
      "compose",
      "--env",
      "development",
      "--",
      "exec",
      "-T",
      "directus",
      "/directus/cli/import-all.sh",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (run.status !== 0) throw new Error(`${label} import failed with exit status ${run.status ?? run.signal}`);
  console.log(`${label} import succeeded in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const config = loadConfig(process.argv.slice(2));
  if (!["localhost", "127.0.0.1"].includes(new URL(config.backendUrl).hostname))
    throw new Error("Import idempotency runs only against the local development stack");
  importAll("Converging");
  await waitForHealth(config.backendUrl);
  const admin = await createAdminClient(config.backendUrl, config.env);
  const before = await snapshot(admin);
  const stateBefore = cmsContainerState();
  importAll("Repeated");
  await waitForHealth(config.backendUrl);
  const after = await snapshot(await createAdminClient(config.backendUrl, config.env));
  const stateAfter = cmsContainerState();
  console.log(`CMS container before: ${stateBefore}; after: ${stateAfter}`);
  if (stateBefore !== stateAfter) {
    console.log("FAIL The repeated import restarted the CMS container");
    process.exitCode = 1;
  }
  const report = new URL("../../../../.reports/st-e2e/import-idempotency/", import.meta.url);
  mkdirSync(report, { recursive: true });
  writeFileSync(new URL("before.json", report), JSON.stringify(before, null, 2));
  writeFileSync(new URL("after.json", report), JSON.stringify(after, null, 2));
  const changed = differences(before, after);
  for (const change of changed) console.log(`CHANGED ${change}`);
  if (changed.length) {
    console.log(`A repeated import changed ${changed.length}+ configuration values`);
    process.exitCode = 1;
  } else console.log(`A repeated import left ${Object.keys(before).length} configuration snapshots unchanged`);
}
