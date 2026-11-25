/**
 * Idempotent public demo dataset for a disposable development CMS.
 *
 * A freshly imported CMS has schema, roles and a few seeds, but no catalogue,
 * assessments or editorial content. Read-only public suites (route crawl, smoke,
 * SEO, styles, UI acceptance) need realistic published records. This creates one
 * deterministic set, identified by the `ci-demo` prefix, through the admin API and
 * the same hooks/flows editors use. Re-running it changes nothing.
 *
 * Usage: tsx src/st/seedDemoContent.ts <backend-url> <frontend-url> <private-cms-env-file>
 * Never run it against a shared or production CMS: it refuses non-loopback URLs.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { loadConfig } from "../lib/config.js";
import { DirectusClient, createAdminClient, type JsonRecord } from "../lib/directus.js";
import { waitFor } from "../lib/wait.js";
import { demo, demoMeasures, type DemoManifest } from "./demoManifest.js";

type Row = { id: string | number } & JsonRecord;

const config = loadConfig(process.argv.slice(2));
for (const url of [config.backendUrl, config.frontendUrl])
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
    throw new Error(`Demo content is only seeded into a local disposable stack, not ${url}`);
const admin = await createAdminClient(config.backendUrl, config.env);

async function find(collection: string, filter: JsonRecord, fields = ["id"]): Promise<Row | undefined> {
  return (await admin.readItems<Row>(collection, { filter, fields, limit: 1 }))[0];
}

/** Create once; on later runs return the existing record unchanged. */
async function ensure(collection: string, filter: JsonRecord, data: JsonRecord): Promise<Row> {
  const existing = await find(collection, filter);
  if (existing) return existing;
  const created = await admin.createItem<Row>(collection, data);
  // Like the upstream fixtures: creation derives page/measure slugs from their names,
  // so the deterministic slug is applied afterwards.
  if ((collection === "measures" || collection === "pages") && typeof data.slug === "string")
    await admin.updateItem(collection, created.id, { slug: data.slug });
  process.stdout.write(`created ${collection} ${String(created.id)}\n`);
  return created;
}

async function ensureAgreements(): Promise<void> {
  for (const [type, label] of [
    ["terms_of_service", "Nutzungsbedingungen"],
    ["data_protection", "Datenschutzerklärung"],
    ["newsletter", "Newsletter"],
  ] as const)
    await ensure(
      "agreement_versions",
      { type: { _eq: type }, isCurrentVersion: { _eq: true } },
      { type, version: `${demo.prefix}-1`, isCurrentVersion: true, legal_text: `<p>${label} (Demo)</p>` },
    );
}

async function ensureCatalog(): Promise<Row> {
  const catalog = await ensure(
    "measure_catalog",
    { name: { _eq: demo.catalog } },
    { name: demo.catalog, hidden: false, isCurrentFrontend: true, isCurrentBackend: true },
  );
  for (const [index, { sector, measureId, slug }] of demoMeasures().entries())
    await ensure(
      "measures",
      { slug: { _eq: slug } },
      {
        slug,
        name: `Demo-Maßnahme ${measureId}`,
        // Real catalogue identifiers, so the Wahlcheck thesis templates match them.
        measure_id: measureId,
        catalog_version: catalog.id,
        status: "published",
        sector,
        weight: (index % 3) + 1,
        choices_rating: "0",
        must_be_rated_again: false,
        description_about: `<p>Beschreibung der Demo-Maßnahme ${measureId}.</p>`,
        description_evaluation_criteria: "<ul><li>Erstes Kriterium</li><li>Zweites Kriterium</li></ul>",
        description_verification: "<p>Nachweis über einen Ratsbeschluss.</p>",
      },
    );
  return catalog;
}

async function ensureUser(email: string, roleName: string, localteamId: string): Promise<string> {
  const roles = await admin.request<{ id: string; name: string }[]>("GET", "/roles", {
    query: { fields: "id,name", limit: -1 },
  });
  const role = roles.find((candidate) => candidate.name === roleName);
  if (!role) throw new Error(`Required role is missing: ${roleName}`);
  let [user] = await admin.readUsers<{ id: string }>({ filter: { email: { _eq: email } }, fields: ["id"] });
  if (!user) {
    user = await admin.createUser<{ id: string }>({
      email,
      password: demo.password(config.env),
      role: role.id,
      status: "active",
      first_name: "Demo",
      last_name: roleName,
      verified: true,
    });
    for (const agreement of await admin.readItems<Row>("agreement_versions", {
      filter: { isCurrentVersion: { _eq: true }, type: { _in: ["terms_of_service", "data_protection"] } },
      fields: ["id"],
      limit: -1,
    }))
      await admin.createItem("user_consent", { user_id: user.id, consent_target: agreement.id });
  }
  await ensure(
    "junction_directus_users_localteams",
    { directus_users_id: { _eq: user.id }, localteam_id: { _eq: localteamId } },
    { directus_users_id: user.id, localteam_id: localteamId },
  );
  return user.id;
}

async function ensureMunicipality(
  definition: (typeof demo.municipalities)[number],
  catalog: Row,
): Promise<{ slug: string; published: boolean }> {
  const localteam = await ensure(
    "localteams",
    { slug: { _eq: definition.slug } },
    {
      name: `Lokalteam ${definition.name}`,
      municipality_name: definition.name,
      slug: definition.slug,
      status: "published",
    },
  );
  const municipality = await waitFor(
    `municipality generated for ${definition.name}`,
    () => find("municipalities", { localteam_id: { _eq: localteam.id } }, ["id", "slug", "status"]),
    { timeoutMs: 60_000 },
  );
  if (municipality.status !== "published" || municipality.slug !== definition.slug)
    await admin.updateItem("municipalities", municipality.id, {
      slug: definition.slug,
      status: "published",
      ars: definition.ars,
      state: definition.state,
      population: definition.population,
      municipality_type: definition.type,
      geolocation: { type: "Point", coordinates: definition.coordinates },
    });
  const adminEmail = `${definition.slug}-admin@example.org`;
  const ownerId = await ensureUser(adminEmail, "LokalteamAdmin", String(localteam.id));
  await admin.updateItem("localteams", localteam.id, { admin_id: ownerId });

  const score = await waitFor(
    `score for ${definition.name}`,
    () =>
      find("municipality_scores", { municipality: { _eq: municipality.id }, catalog_version: { _eq: catalog.id } }, [
        "id",
        "published",
        "percentage_rated",
      ]),
    { timeoutMs: 60_000 },
  );
  const ratings = await waitFor(
    `generated ratings for ${definition.name}`,
    async () => {
      const rows = await admin.readItems<Row>("ratings_measures", {
        filter: { localteam_id: { _eq: localteam.id }, measure_id: { catalog_version: { _eq: catalog.id } } },
        fields: ["id", "rating", "approved", "measure_id.slug"],
        sort: ["measure_id.slug"],
        limit: -1,
      });
      return rows.length === demoMeasures().length ? rows : false;
    },
    { timeoutMs: 60_000 },
  );
  const rated = definition.complete ? ratings : ratings.slice(0, Math.floor(ratings.length / 2));
  for (const [index, rating] of rated.entries()) {
    const value = demo.ratingValues[index % demo.ratingValues.length]!;
    if (rating.rating === value && rating.approved === true) continue;
    await admin.updateItem("ratings_measures", rating.id, {
      rating: value,
      applicable: true,
      approved: true,
      status: "published",
      source: "<p>Demo-Quelle</p>",
    });
  }
  if (definition.complete && score.published !== true) {
    await waitFor(
      `complete score for ${definition.name}`,
      async () => {
        const row = await admin.readItem<Row>("municipality_scores", score.id, ["percentage_rated"]);
        return Number(row.percentage_rated) === 100 ? row : false;
      },
      { timeoutMs: 60_000 },
    );
    // Publishing is a team decision guarded by verification; use the team admin's own session.
    const owner = new DirectusClient(config.backendUrl);
    await owner.login(adminEmail, demo.password(config.env));
    await owner.updateItem("municipality_scores", score.id, { published: true });
  }
  return { slug: definition.slug, published: definition.complete };
}

/**
 * A migrated production database retains its retired legacy browser identity (suspended,
 * still holding its old static token). Fresh databases have none, so CI provides one for
 * the revocation check in securityMigration.ts (TEST_RETIRED_DIRECTUS_USER_ID).
 */
async function ensureRetiredLegacyIdentity(): Promise<string> {
  const email = `${demo.prefix}-retired-legacy-frontend@example.org`;
  const [existing] = await admin.readUsers<{ id: string }>({ filter: { email: { _eq: email } }, fields: ["id"] });
  if (existing) return existing.id;
  const roles = await admin.request<{ id: string; name: string }[]>("GET", "/roles", {
    query: { fields: "id,name", limit: -1 },
  });
  const role = roles.find((candidate) => candidate.name === "Frontend");
  if (!role) throw new Error("The legacy Frontend role is missing");
  const user = await admin.createUser<{ id: string }>({
    email,
    role: role.id,
    status: "suspended",
    token: randomBytes(32).toString("hex"),
    first_name: "Retired",
    last_name: "Legacy Frontend",
  });
  return user.id;
}

/**
 * Wahlcheck thesis templates are maintained in src/directus/contents but are not part of
 * import-all. That file still carries integer ids although the collection's primary key
 * is a UUID, so `import:items measure_questions_template` is rejected (HTTP 403) on a
 * fresh database (reported upstream). Create the maintained records without the stale ids.
 */
async function ensureMeasureQuestionTemplates(): Promise<number> {
  const [{ count }] = await admin.request<{ count: string }[]>("GET", "/items/measure_questions_template", {
    query: { "aggregate[count]": "*" },
  });
  if (Number(count) > 0) return Number(count);
  const require = createRequire(new URL("../../../package.json", import.meta.url));
  const { parse } = require("yaml") as { parse: (source: string) => unknown };
  const templates = (
    parse(
      readFileSync(
        new URL("../../../../src/directus/contents/measure_questions_template.yaml", import.meta.url),
        "utf8",
      ),
    ) as JsonRecord[]
  ).map(({ id: _staleId, ...template }) => template);
  await admin.request("POST", "/items/measure_questions_template", { body: templates });
  process.stdout.write(`created ${templates.length} measure_questions_template records\n`);
  return templates.length;
}

async function ensureEditorialContent(): Promise<
  Pick<DemoManifest, "news" | "events" | "projects" | "pages" | "jobs">
> {
  // Dates relative to the current month keep the news/event timelines realistically filled.
  const now = new Date();
  const month = (offset: number, day = 15) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day, 10)).toISOString();
  const news: string[] = [];
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const slug = `${demo.prefix}-news-${index}`;
    await ensure(
      "news_items",
      { slug: { _eq: slug } },
      {
        slug,
        title: `Demo-Neuigkeit ${index}`,
        teaser: `Kurzer Teaser der Demo-Neuigkeit ${index}.`,
        status: "published",
        is_tour_redirect: false,
        date_published: month(-index + 1, 5).slice(0, 19),
      },
    );
    news.push(slug);
  }
  const series = await ensure(
    "event_series",
    { slug: { _eq: `${demo.prefix}-series` } },
    { slug: `${demo.prefix}-series`, title: "Demo-Veranstaltungsreihe", status: "published", format: "standard" },
  );
  const events: string[] = [];
  for (const [index, offset] of [-1, 1, -4, -3, -2, 2, 3, 4].entries()) {
    const slug = `${demo.prefix}-event-${index + 1}`;
    await ensure(
      "events",
      { slug: { _eq: slug } },
      {
        slug,
        title: `Demo-Veranstaltung ${index + 1}`,
        description: "<p>Beschreibung der Demo-Veranstaltung.</p>",
        status: "published",
        event_category: "own_public",
        event_type: "other",
        start_date: month(offset),
        series: series.id,
      },
    );
    events.push(slug);
  }
  const imageTitle = `${demo.prefix} project image`;
  const [existingImage] = await admin.request<Row[]>("GET", "/files", {
    query: { filter: JSON.stringify({ title: { _eq: imageTitle } }), fields: "id", limit: 1 },
  });
  const image =
    existingImage ??
    (await admin.uploadFile<Row>(
      `${demo.prefix}-project.svg`,
      "image/svg+xml",
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><rect width="64" height="40" fill="#AFCA0B"/></svg>',
      ),
      imageTitle,
    ));
  const projects: string[] = [];
  for (const [index, sector] of ["energy", "transport"].entries()) {
    const slug = `${demo.prefix}-project-${index + 1}`;
    await ensure(
      "articles",
      { slug: { _eq: slug } },
      {
        slug,
        title: `Demo-Erfolgsprojekt ${index + 1}`,
        status: "published",
        abstract: "Kurzbeschreibung des Demo-Erfolgsprojekts.",
        author: "Demo-Redaktion",
        municipality_name: demo.municipalities[0].name,
        image: image.id,
        image_credits: "Demo-Bildnachweis",
        sectors: [sector],
        article_text: "<p>Ausführlicher Text des Demo-Erfolgsprojekts.</p>",
      },
    );
    projects.push(slug);
  }
  const pages: string[] = [];
  for (const page of demo.pages) {
    await ensure(
      "pages",
      { slug: { _eq: page.slug } },
      { slug: page.slug, name: page.name, status: "published", contents: page.contents, menus: [] },
    );
    pages.push(page.slug);
  }
  const navigation = await admin.request<JsonRecord | null>("GET", "/items/navigation_config", {
    query: { fields: "header_items,footer_columns" },
  });
  if (!Array.isArray(navigation?.header_items) || !navigation.header_items.length)
    await admin.request("PATCH", "/items/navigation_config", { body: { header_items: demo.headerNavigation } });
  if (!Array.isArray(navigation?.footer_columns) || !navigation.footer_columns.length)
    await admin.request("PATCH", "/items/navigation_config", { body: { footer_columns: demo.footerNavigation } });

  await ensure(
    "climate_tools",
    { title: { _eq: "Demo-Klimawerkzeug" } },
    {
      title: "Demo-Klimawerkzeug",
      description: "Beschreibung des Demo-Klimawerkzeugs.",
      category: "Demo",
      link: "https://example.org/tool",
      status: "published",
    },
  );
  await ensure(
    "organisation_teams",
    { team_key: { _eq: `${demo.prefix}-team` } },
    { team_key: `${demo.prefix}-team`, label: "Demo-Team", email: "team@example.org", tasks: [], color: "#505050" },
  );
  const organisation = await ensure(
    "organisations",
    { name: { _eq: "Demo-Organisation" } },
    { name: "Demo-Organisation", link: "https://example.org" },
  );
  const jobs: string[] = [];
  const jobSlug = `${demo.prefix}-job`;
  await ensure(
    "job_offers",
    { slug: { _eq: jobSlug } },
    {
      slug: jobSlug,
      role_title: "Demo-Stelle Klimaschutz",
      type: "part_time",
      status: "published",
      tasks: "Klimaschutz voranbringen",
      qualifications: "Begeisterung",
      benefits: "Sinnvolle Arbeit",
      salary: "Nach Vereinbarung",
      weekly_hours: "20",
      start_date: "2027-01-01T00:00:00Z",
      application_url: "https://example.org/apply",
      organisation: organisation.id,
    },
  );
  jobs.push(jobSlug);
  return { news, events, projects, pages, jobs };
}

await ensureAgreements();
const catalog = await ensureCatalog();
const municipalities = [];
for (const definition of demo.municipalities) municipalities.push(await ensureMunicipality(definition, catalog));
const editorial = await ensureEditorialContent();
const retiredLegacyUserId = await ensureRetiredLegacyIdentity();
await ensureMeasureQuestionTemplates();
const manifest: DemoManifest = {
  catalog: demo.catalog,
  measures: demoMeasures().map((measure) => measure.slug),
  municipalities,
  ...editorial,
  retiredLegacyUserId,
};
mkdirSync(new URL("../../../../.reports/st-e2e/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../../../../.reports/st-e2e/demo-manifest.json", import.meta.url),
  JSON.stringify(manifest, null, 2),
);
process.stdout.write(`Demo content ready: ${JSON.stringify(manifest)}\n`);
