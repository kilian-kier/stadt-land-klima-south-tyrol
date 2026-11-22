/**
 * Create the four private dotenv files of a disposable development stack from the
 * maintained examples. Every secret is freshly generated; external providers are
 * disabled or pointed at local fixtures so no test can reach the internet.
 *
 * Usage (repository root): node bin/test_suite/src/st/ciEnvironment.ts [--force]
 * Existing files are preserved unless --force is given (CI only).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Offline Stadt.Land.Zahl stand-in (slzFixtureServer.ts) on the CI host. */
export const slzFixturePort = 18090;
/** The frontend container reaches the host through Podman's host alias; browsers use loopback. */
export const slzServerOrigin = `http://host.containers.internal:${slzFixturePort}`;
export const slzPublicOrigin = `http://127.0.0.1:${slzFixturePort}`;

type Overrides = Record<string, string>;

/** Replace or append keys while keeping the example's order and comments. */
export function applyOverrides(source: string, overrides: Overrides): string {
  const pending = new Map(Object.entries(overrides));
  const lines = source.split(/\r?\n/).map((line) => {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (!match || !pending.has(match[1]!)) return line;
    const key = match[1]!;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

export function ciEnvironment(): Record<"db" | "meilisearch" | "directus" | "frontend", Overrides> {
  const databasePassword = secret();
  return {
    db: { POSTGRES_PASSWORD: databasePassword, POSTGRES_USER: "directus", POSTGRES_DB: "directus" },
    meilisearch: { MEILI_MASTER_KEY: secret(), MEILI_ENV: "development", MEILI_NO_ANALYTICS: "true" },
    directus: {
      KEY: secret(),
      SECRET: secret(),
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: `Ci-${secret(18)}-9a!`,
      DB_PASSWORD: databasePassword,
      CLI_DIRECTUS_STATIC_TOKEN: secret(),
      UNSPLASH_ACCESS_KEY: "",
      EMAIL_VERIFY_SETUP: "false",
    },
    frontend: {
      ALTCHA_SECRET: secret(),
      CANDIDATE_SESSION_SECRET: secret(),
      EDITOR_SESSION_SECRET: secret(),
      STADTLANDZAHL_BASE_URL: slzPublicOrigin,
      STADTLANDZAHL_SERVER_BASE_URL: slzServerOrigin,
      STADTLANDZAHL_BASE_HTTP_BASIC_AUTH_USER: "",
      STADTLANDZAHL_BASE_HTTP_BASIC_AUTH_PASSWORD: "",
      CARTO_BASEMAP_API_KEY: "",
      PLAUSIBLE_ANALYTICS_URL: "",
      PLAUSIBLE_ANALYTICS_DOMAIN: "",
      LISTMONK_ENDPOINT: "",
      LISTMONK_API_USERNAME: "",
      LISTMONK_API_TOKEN: "",
      LISTMONK_LIST_ID: "",
      DEEPL_API_KEY: "",
      CONTENT_TRANSLATION_ENABLED: "false",
      CONTENT_TRANSLATION_GENERATION_ENABLED: "false",
      // Filled in with the imported flow IDs by ciFlowUrls.ts before the frontend starts.
      DIRECTUS_FLOW_NOTIFY_ADMIN: "",
      DIRECTUS_FLOW_WELCOME_EMAIL: "",
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes("--force");
  const files = {
    db: "podman/database/.env",
    meilisearch: "podman/meilisearch/.env",
    directus: "src/directus/.env",
    frontend: "src/frontend/.env",
  } as const;
  const overrides = ciEnvironment();
  for (const [service, path] of Object.entries(files) as [keyof typeof files, string][]) {
    const target = resolve(root, path);
    if (existsSync(target) && !force) {
      console.log(`Kept existing ${path}`);
      continue;
    }
    const example = readFileSync(`${target}.example`, "utf8");
    writeFileSync(target, applyOverrides(example, overrides[service]), { mode: 0o600 });
    chmodSync(target, 0o600);
    console.log(`Generated ${path} with fresh disposable secrets`);
  }
}
