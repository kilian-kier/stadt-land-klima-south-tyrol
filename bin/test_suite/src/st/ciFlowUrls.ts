/**
 * Point the frontend's private mail webhook settings at the actually imported
 * Directus flows of a disposable development stack (flow IDs are assigned on import).
 *
 * Usage (repository root, CMS published on loopback):
 *   node bin/test_suite/src/st/ciFlowUrls.ts http://127.0.0.1:8081
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOverrides } from "./ciEnvironment.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const flowSettings = {
  DIRECTUS_FLOW_NOTIFY_ADMIN: "notifyAdminNewLocalteam",
  DIRECTUS_FLOW_WELCOME_EMAIL: "sendWelcomeNewLocalteam",
} as const;

function readToken(path: string): string {
  const match = /^CLI_DIRECTUS_STATIC_TOKEN=(.+)$/m.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error("CLI_DIRECTUS_STATIC_TOKEN is missing from the private CMS env file");
  return match[1]!.trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cms = new URL(process.argv[2] ?? "http://127.0.0.1:8081");
  if (!["127.0.0.1", "localhost"].includes(cms.hostname)) throw new Error("Only a loopback CMS is supported");
  const token = readToken(resolve(root, process.env.SLK_PODMAN_DIRECTUS_ENV_FILE || "src/directus/.env"));
  const response = await fetch(new URL("/flows?fields=id,name,status&limit=-1", cms), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Reading imported flows failed with HTTP ${response.status}`);
  const flows = ((await response.json()) as { data: { id: string; name: string; status: string }[] }).data;
  const overrides: Record<string, string> = {};
  for (const [key, name] of Object.entries(flowSettings)) {
    const matches = flows.filter((flow) => flow.name === name);
    if (matches.length !== 1)
      throw new Error(`Expected exactly one imported flow named ${name}, found ${matches.length}`);
    overrides[key] = `http://directus:8055/flows/trigger/${matches[0]!.id}`;
  }
  const frontend = resolve(root, process.env.SLK_PODMAN_FRONTEND_ENV_FILE || "src/frontend/.env");
  writeFileSync(frontend, applyOverrides(readFileSync(frontend, "utf8"), overrides), { mode: 0o600 });
  console.log(`Wired ${Object.keys(overrides).join(", ")} to the imported flows`);
}
