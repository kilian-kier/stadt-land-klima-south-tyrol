/**
 * Private configuration for a fresh st host. Runs as the deployment user with Node's
 * standard library only. Existing files are never overwritten; values never reach stdout.
 *
 *   private-config.mts init <checkout> <host-config> <project> <tag> <site-origin> <cms-origin> <admin-email>
 *   private-config.mts merge <private-env> <snippet> [--nuxt-aliases]
 *   private-config.mts get <private-env> <KEY>      (prints one value; for flow/token plumbing only)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";

const secret = (bytes = 32) => randomBytes(bytes).toString("hex");
const placeholder =
  /^(?:replace-with-|your-.+-here$|change-me|url_to_|domain_as_|dev-secret-|some-random-key$)|<flow-id>/i;

function fail(message: string): never {
  process.stderr.write(`private-config: ${message}\n`);
  process.exit(1);
}

function assertPrivate(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    fail(`${path} must be an owner-only regular file`);
}

function writePrivate(path: string, contents: string, replace: boolean): void {
  if (!isAbsolute(path)) fail("private paths must be absolute");
  if (existsSync(path) && !replace) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    if (!replace && existsSync(path)) return;
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function safeValue(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n$`"'\\]/.test(value)) fail(`unsafe value for ${name}`);
  return value;
}

/** Apply updates to dotenv text: replace one existing assignment or append; drop leftover placeholders. */
export function applyEnvironment(source: string, updates: Record<string, string>, drop: string[] = []): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) {
      output.push(line);
      continue;
    }
    const name = match[1]!;
    if (drop.includes(name)) continue;
    if (name in updates) {
      if (seen.has(name)) fail(`duplicate key ${name}`);
      seen.add(name);
      output.push(`${name}=${safeValue(name, updates[name]!)}`);
      continue;
    }
    const value = parseEnv(`${name}=${match[2]}`)[name] ?? "";
    // Examples ship placeholders that production startup checks reject; leave them unset.
    if (placeholder.test(value)) continue;
    output.push(line.replace(/\s+#.*$/, ""));
  }
  for (const [name, value] of Object.entries(updates))
    if (!seen.has(name)) output.push(`${name}=${safeValue(name, value)}`);
  return output.join("\n").replace(/\n*$/, "\n");
}

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || !/^[a-z0-9.-]+$/.test(url.hostname))
    fail("origins must be plain https:// origins");
  return url.origin;
}

function init(args: string[]): void {
  const [checkout, hostConfig, project, tag, siteValue, cmsValue, adminEmail] = args;
  if (!checkout || !hostConfig || !project || !tag || !siteValue || !cmsValue || !adminEmail)
    fail("init needs 7 arguments");
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(project)) fail("invalid project");
  if (!/^release-[a-f0-9]{8,40}$/.test(tag)) fail("invalid release tag");
  if (!/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(adminEmail)) fail("invalid administrator email");
  const site = origin(siteValue);
  const cms = origin(cmsValue);
  if (site === cms) fail("website and CMS origins must differ");
  const example = (path: string) => readFileSync(join(checkout, path), "utf8");
  const files = {
    database: join(checkout, "podman/database/.env"),
    search: join(checkout, "podman/meilisearch/.env"),
    directus: join(checkout, "src/directus/.env"),
    frontend: join(checkout, "src/frontend/.env"),
  };
  // A partially written set would pair new credentials with an initialized database.
  const present = Object.values(files).filter((path) => existsSync(path));
  if (present.length && present.length !== 4) fail("some private application files already exist; refusing to mix");
  if (!present.length) {
    const databasePassword = secret();
    writePrivate(
      files.database,
      applyEnvironment(example("podman/database/.env.example"), {
        POSTGRES_PASSWORD: databasePassword,
        POSTGRES_USER: "directus",
        POSTGRES_DB: "directus",
      }),
      false,
    );
    writePrivate(
      files.search,
      applyEnvironment(example("podman/meilisearch/.env.example"), {
        MEILI_MASTER_KEY: secret(),
        MEILI_ENV: "production",
        MEILI_NO_ANALYTICS: "true",
      }),
      false,
    );
    writePrivate(
      files.directus,
      applyEnvironment(
        example("src/directus/.env.example"),
        {
          KEY: randomUUID(),
          SECRET: secret(),
          ADMIN_EMAIL: adminEmail,
          ADMIN_PASSWORD: secret(24),
          SLK_STARTUP_SECURITY_CHECKS: "true",
          DB_USER: "directus",
          DB_PASSWORD: databasePassword,
          DB_DATABASE: "directus",
          EXTENSIONS_AUTO_RELOAD: "false",
          PUBLIC_URL: cms,
          FRONTEND_BASE_URL: site,
          CLI_DIRECTUS_STATIC_TOKEN: secret(),
          // The isolated CMS origin settings that `slk cms-origin prepare` applies.
          CORS_ENABLED: "true",
          CORS_ORIGIN: cms,
          CORS_CREDENTIALS: "false",
          SESSION_COOKIE_DOMAIN: "",
          REFRESH_TOKEN_COOKIE_DOMAIN: "",
          SESSION_COOKIE_SECURE: "true",
          REFRESH_TOKEN_COOKIE_SECURE: "true",
          SESSION_COOKIE_SAME_SITE: "strict",
          REFRESH_TOKEN_COOKIE_SAME_SITE: "strict",
          SESSION_COOKIE_NAME: "__Host-slk-directus-session",
          REFRESH_TOKEN_COOKIE_NAME: "__Host-slk-directus-refresh",
          // No mail transport is configured yet; see docs/st/DEPLOYMENT.md.
          EMAIL_VERIFY_SETUP: "false",
          WAHLCHECK_EMAIL: adminEmail,
        },
        ["UNSPLASH_ACCESS_KEY"],
      ),
      false,
    );
    writePrivate(
      files.frontend,
      applyEnvironment(
        example("src/frontend/.env.example"),
        {
          APP_ENV: "production",
          SERVER_DIRECTUS_URL: "http://directus:8055",
          CLIENT_DIRECTUS_URL: cms,
          PUBLIC_URL: site,
          ALTCHA_SECRET: secret(),
          CANDIDATE_SESSION_SECRET: secret(),
          EDITOR_SESSION_SECRET: secret(),
          ADMIN_NOTIFICATION_EMAIL: adminEmail,
          ERFOLGSPROJEKTE_NOTIFICATION_EMAIL: adminEmail,
          FORM_RESPONSE_NOTIFICATION_EMAIL: adminEmail,
          CONTENT_TRANSLATION_ENABLED: "false",
          CONTENT_TRANSLATION_GENERATION_ENABLED: "false",
        },
        [
          "PLAUSIBLE_ANALYTICS_URL",
          "PLAUSIBLE_ANALYTICS_DOMAIN",
          "DIRECTUS_FLOW_NOTIFY_ADMIN",
          "DIRECTUS_FLOW_WELCOME_EMAIL",
        ],
      ),
      false,
    );
  }
  writePrivate(
    hostConfig,
    [
      "# Private release host configuration (dotenv data, never evaluated as shell).",
      `SLK_PODMAN_PROJECT=${project}`,
      "SLK_DEPLOYMENT_TARGET=production",
      `SLK_PODMAN_TAG=${tag}`,
      `SLK_PODMAN_DB_ENV_FILE=${files.database}`,
      `SLK_PODMAN_MEILI_ENV_FILE=${files.search}`,
      `SLK_PODMAN_DIRECTUS_ENV_FILE=${files.directus}`,
      `SLK_PODMAN_FRONTEND_ENV_FILE=${files.frontend}`,
      `SLK_ALLOWED_ORIGINS=${cms}`,
      "",
    ].join("\n"),
    false,
  );
  for (const path of [...Object.values(files), hostConfig]) assertPrivate(path);
}

function merge(args: string[]): void {
  const [target, snippet, flag] = args;
  if (!target || !snippet || (flag !== undefined && flag !== "--nuxt-aliases"))
    fail("merge <file> <snippet> [--nuxt-aliases]");
  assertPrivate(target);
  assertPrivate(snippet);
  const values = parseEnv(readFileSync(snippet, "utf8"));
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || !value) fail(`empty value for ${name}`);
    updates[name] = value;
    if (flag) updates[`NUXT_${name}`] = value;
  }
  if (!Object.keys(updates).length) fail("nothing to merge");
  const source = readFileSync(target, "utf8");
  const next = applyEnvironment(source, updates);
  if (next !== source) {
    if (readFileSync(target, "utf8") !== source) fail("file changed concurrently");
    writePrivate(target, next, true);
  }
}

function get(args: string[]): void {
  const [file, name] = args;
  if (!file || !name) fail("get <file> <KEY>");
  assertPrivate(file);
  const value = parseEnv(readFileSync(file, "utf8"))[name];
  if (!value) fail(`${name} is not set`);
  process.stdout.write(value);
}

process.umask(0o077);
const [command, ...rest] = process.argv.slice(2);
if (command === "init") init(rest);
else if (command === "merge") merge(rest);
else if (command === "get") get(rest);
else fail("usage: init | merge | get");
