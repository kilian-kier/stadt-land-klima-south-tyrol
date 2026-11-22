/**
 * Permission boundaries of the imported CMS, checked against the code-first YAML.
 *
 * 1. Every policy's imported permission rows (collection, action, item filter, validation,
 *    presets, fields) equal its YAML definition, and the public access is exactly the
 *    YAML Public policy.
 * 2. The Public policy stays limited to public-folder files/folders (AGENTS.md: never
 *    broaden public access); anonymous requests cannot read or write any collection or
 *    administrative endpoint, and cannot fetch files outside the public folder.
 * 3. The private service identities (Frontend-Public, Frontend-Server, Frontend-Preview)
 *    read exactly the collections and system endpoints their policies grant and cannot
 *    write elsewhere.
 *
 * Writes are probed with empty payloads: anything but a client error counts as accepted.
 * Collections whose hooks validate payloads before authorization may answer 400; that
 * still proves nothing was written. Singletons are probed with PATCH.
 *
 * Usage: tsx src/st/permissionBoundaries.ts <backend-url> <frontend-url> <private-cms-env-file>
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontendEnvironment, loadConfig } from "../lib/config.js";
import { createAdminClient } from "../lib/directus.js";
import { normalize } from "./importIdempotency.js";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { parse } = require("yaml") as { parse: (source: string) => unknown };
const directus = fileURLToPath(new URL("../../../../src/directus/", import.meta.url));

type Grant = `${string}:${string}`;
interface PermissionRow {
  collection: string;
  action: string;
  permissions?: unknown;
  validation?: unknown;
  presets?: unknown;
  fields?: string[] | null;
}
interface PolicyFile {
  name: string;
  permissions?: PermissionRow[] | null;
}

export function yamlPolicyFiles(): PolicyFile[] {
  return readdirSync(`${directus}policies`)
    .filter((name) => name.endsWith(".yaml"))
    .map((file) => parse(readFileSync(`${directus}policies/${file}`, "utf8")) as PolicyFile);
}

export function grantsOf(policy: PolicyFile | undefined): Set<Grant> {
  return new Set((policy?.permissions ?? []).map((row) => `${row.collection}:${row.action}` as Grant));
}

/** Comparable permission row: empty rules/fields are equivalent to null, field order is irrelevant. */
export function permissionKey(row: PermissionRow): string {
  const empty = (value: unknown) =>
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length)
      ? null
      : normalize(value);
  return JSON.stringify({
    collection: row.collection,
    action: row.action,
    permissions: empty(row.permissions),
    validation: empty(row.validation),
    presets: empty(row.presets),
    fields: row.fields?.length ? [...row.fields].sort() : null,
  });
}

export function yamlRolePolicies(role: string): string[] {
  const file = readdirSync(`${directus}roles`).find(
    (name) =>
      name.endsWith(".yaml") &&
      (parse(readFileSync(`${directus}roles/${name}`, "utf8")) as { name?: string } | null)?.name === role,
  );
  if (!file) throw new Error(`Role ${role} is not defined in YAML`);
  return (parse(readFileSync(`${directus}roles/${file}`, "utf8")) as { policies?: string[] }).policies ?? [];
}

/** System endpoints probed for every identity, with the collection that grants them. */
export const systemEndpoints: Record<string, string> = {
  "/users": "directus_users",
  "/roles": "directus_roles",
  "/policies": "directus_policies",
  "/permissions": "directus_permissions",
  "/access": "directus_access",
  "/flows": "directus_flows",
  "/operations": "directus_operations",
  "/presets": "directus_presets",
  "/activity": "directus_activity",
  "/revisions": "directus_revisions",
  "/settings": "directus_settings",
  "/dashboards": "directus_dashboards",
  "/panels": "directus_panels",
  "/notifications": "directus_notifications",
  "/translations": "directus_translations",
};

const denied = (status: number) => status === 401 || status === 403;
const rejectedWrite = (status: number) => status >= 400 && status < 500;

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const config = loadConfig(process.argv.slice(2));
  const backend = config.backendUrl;
  if (!["localhost", "127.0.0.1"].includes(new URL(backend).hostname))
    throw new Error("Permission probes write-attempt only against a local disposable CMS");
  const admin = await createAdminClient(backend, config.env);
  const failures: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  const request = async (path: string, token?: string, method = "GET", body?: unknown) => {
    const response = await fetch(backend + path, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  };

  // 1. Imported permission rows and public access equal the YAML source of truth.
  const policyFiles = yamlPolicyFiles();
  const live = await admin.request<{ id: string; name: string }[]>("GET", "/policies", {
    query: { fields: "id,name", limit: -1 },
  });
  const permissions = await admin.request<(PermissionRow & { policy: string })[]>("GET", "/permissions", {
    query: { fields: "policy,collection,action,permissions,validation,presets,fields", limit: -1 },
  });
  for (const policy of policyFiles) {
    const imported = live.find((candidate) => candidate.name === policy.name);
    check(Boolean(imported), `Policy ${policy.name} from YAML is not imported`);
    if (!imported) continue;
    const expected = new Set((policy.permissions ?? []).map(permissionKey));
    const actual = new Set(permissions.filter((row) => row.policy === imported.id).map(permissionKey));
    for (const row of expected) check(actual.has(row), `Policy ${policy.name}: YAML permission not imported: ${row}`);
    for (const row of actual)
      check(expected.has(row), `Policy ${policy.name}: imported permission not in YAML: ${row}`);
  }
  const publicAccess = await admin.request<{ policy: { name: string } | null }[]>("GET", "/access", {
    query: {
      fields: "policy.name",
      filter: JSON.stringify({ role: { _null: true }, user: { _null: true } }),
      limit: -1,
    },
  });
  const publicPolicies = publicAccess.map((row) => row.policy?.name ?? "").sort();
  console.log(`Public access policies: ${publicPolicies.join(", ") || "none"}`);
  check(
    JSON.stringify(publicPolicies) === JSON.stringify(yamlRolePolicies("Public").sort()),
    `Anonymous access must be exactly the YAML Public role policies, found ${publicPolicies.join(", ")}`,
  );

  // 2. Public access stays limited to public-folder assets.
  const publicGrants = grantsOf(policyFiles.find((policy) => policy.name === "Public"));
  check(
    [...publicGrants].sort().join(",") === "directus_files:read,directus_folders:read",
    `Public policy must only read public files/folders, found ${[...publicGrants].join(",")}`,
  );
  const collections = (
    await admin.request<{ collection: string; schema: unknown; meta: { singleton?: boolean } | null }[]>(
      "GET",
      "/collections",
      { query: { limit: -1 } },
    )
  )
    .filter((collection) => collection.schema && !collection.collection.startsWith("directus_"))
    .map((collection) => ({ name: collection.collection, singleton: collection.meta?.singleton === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  check(collections.length > 40, `Expected the imported application collections, found ${collections.length}`);
  const write = (collection: { name: string; singleton: boolean }, token?: string) =>
    collection.singleton
      ? request(`/items/${collection.name}`, token, "PATCH", {})
      : request(`/items/${collection.name}`, token, "POST", {});
  for (const collection of collections) {
    const control = await request(`/items/${collection.name}?limit=1`, config.env.CLI_DIRECTUS_STATIC_TOKEN);
    check(control.status === 200, `Admin control read of ${collection.name} failed (HTTP ${control.status})`);
    const read = await request(`/items/${collection.name}?limit=1`);
    check(denied(read.status), `Anonymous read of ${collection.name} returned HTTP ${read.status}`);
    const created = await write(collection);
    check(rejectedWrite(created.status), `Anonymous write to ${collection.name} returned HTTP ${created.status}`);
  }
  for (const path of [...Object.keys(systemEndpoints), "/users/me", "/schema/snapshot", "/extensions"]) {
    const response = await request(path);
    check(denied(response.status), `Anonymous GET ${path} returned HTTP ${response.status}`);
  }

  // Files: uploads land in the public folder by default and are public; files moved
  // into any other folder are not anonymously readable.
  const folders = await admin.request<{ id: string; name: string }[]>("GET", "/folders", {
    query: { fields: "id,name", limit: -1 },
  });
  const publicFolder = folders.find((folder) => folder.name === "public");
  check(Boolean(publicFolder), "The imported public folder is missing");
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
  const privateFolder = await admin.request<{ id: string }>("POST", "/folders", {
    body: { name: `ci-private-${config.runId}` },
  });
  const files: string[] = [];
  try {
    const file = await admin.uploadFile<{ id: string }>("ci-upload.svg", "image/svg+xml", svg, "ci upload");
    files.push(file.id);
    const stored = await admin.request<{ folder: string | null }>("GET", `/files/${file.id}`, {
      query: { fields: "folder" },
    });
    const placement = stored.folder === publicFolder?.id ? "public" : `folder ${stored.folder ?? "root"}`;
    console.log(`Default upload placement: ${placement}`);
    if (placement !== "public") {
      for (const path of [`/files/${file.id}`, `/assets/${file.id}`]) {
        const response = await request(path);
        check(
          denied(response.status) || response.status === 404,
          `Anonymous GET ${path} (${placement}) returned HTTP ${response.status}`,
        );
      }
      if (publicFolder) await admin.request("PATCH", `/files/${file.id}`, { body: { folder: publicFolder.id } });
    }
    const control = await request(`/assets/${file.id}`);
    check(control.status === 200, `Anonymous asset in the public folder returned HTTP ${control.status}`);
    await admin.request("PATCH", `/files/${file.id}`, { body: { folder: privateFolder.id } });
    for (const path of [`/files/${file.id}`, `/assets/${file.id}`]) {
      const response = await request(path);
      check(
        denied(response.status) || response.status === 404,
        `Anonymous GET ${path} for a file in a private folder returned HTTP ${response.status}: ${response.body.slice(0, 160)}`,
      );
    }
  } finally {
    for (const id of files) await admin.request("DELETE", `/files/${id}`);
    await admin.request("DELETE", `/folders/${privateFolder.id}`);
  }

  // 3. Private service identities read exactly what their policies grant.
  const frontend = frontendEnvironment(config);
  for (const [role, variable] of [
    ["Frontend-Public", "DIRECTUS_FRONTEND_PUBLIC_TOKEN"],
    ["Frontend-Server", "DIRECTUS_FRONTEND_SERVER_TOKEN"],
    ["Frontend-Preview", "DIRECTUS_PREVIEW_TOKEN"],
  ] as const) {
    const token = frontend[variable];
    check(Boolean(token), `${variable} was not provisioned into the frontend env file`);
    if (!token) continue;
    const grants = new Set(
      yamlRolePolicies(role).flatMap((name) => [...grantsOf(policyFiles.find((policy) => policy.name === name))]),
    );
    let readable = 0;
    for (const collection of collections) {
      const read = await request(`/items/${collection.name}?limit=1`, token);
      if (grants.has(`${collection.name}:read`)) {
        readable++;
        check(read.status === 200, `${role} lost its granted read of ${collection.name} (HTTP ${read.status})`);
      } else check(denied(read.status), `${role} can read ungranted ${collection.name} (HTTP ${read.status})`);
      if (!grants.has(`${collection.name}:${collection.singleton ? "update" : "create"}`)) {
        const created = await write(collection, token);
        check(rejectedWrite(created.status), `${role} can write ungranted ${collection.name} (HTTP ${created.status})`);
      }
    }
    for (const [path, collection] of Object.entries(systemEndpoints)) {
      const response = await request(path, token);
      if (grants.has(`${collection}:read`))
        check(response.status === 200, `${role} lost its granted ${path} read (HTTP ${response.status})`);
      else check(denied(response.status), `${role} GET ${path} returned HTTP ${response.status}`);
    }
    console.log(`${role}: ${readable} granted collection reads verified, all other collections denied`);
  }

  console.log(`Checked ${collections.length} collections and ${policyFiles.length} policies`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log("Permission boundaries match the code-first configuration");
}
