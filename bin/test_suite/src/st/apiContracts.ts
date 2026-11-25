/**
 * Response contracts of the public Nuxt API against the checked zod schemas in
 * src/frontend/shared/contracts, using the seeded demo records. Every endpoint must
 * answer 200 with JSON that satisfies its contract and contains no credential-like
 * fields; unknown records must be a clean 404 (never a 5xx); seeded published
 * records must be visible through the list endpoints.
 *
 * Usage: tsx src/st/apiContracts.ts <frontend-origin> <demo-manifest.json>
 */
import { resolve } from "node:path";
import { z } from "../../../../src/frontend/node_modules/zod/index.js";
import {
  ClimateToolSchema,
  ContentPageSchema,
  EventSchema,
  EventSeriesSchema,
  NewsDetailSchema,
  NewsListSchema,
  OrganisationSchema,
  ProjectDetailSchema,
  ProjectListSchema,
  TourSchema,
  TourStopSchema,
} from "../../../../src/frontend/shared/contracts/content.js";
import { PublicElectionListSchema } from "../../../../src/frontend/shared/contracts/elections.js";
import { JobsDetailResponseSchema, JobsListResponseSchema } from "../../../../src/frontend/shared/contracts/jobs.js";
import { MapResponseSchema } from "../../../../src/frontend/shared/contracts/map.js";
import {
  MeasureSchema,
  MunicipalitySchema,
  ScoreSchema,
  StatisticsSchema,
} from "../../../../src/frontend/shared/contracts/municipality.js";
import { MunicipalityUpdatesSchema } from "../../../../src/frontend/shared/contracts/municipalityUpdates.js";
import { SiteLayoutSchema } from "../../../../src/frontend/shared/contracts/navigation.js";
import { CatalogSchema, PublicMunicipalitySchema } from "../../../../src/frontend/shared/contracts/search.js";
import { assertNoCredentialFields } from "../lib/disclosure.js";
import { readDemoManifest, type DemoManifest } from "./demoManifest.js";
import { classifyFindings, printClassification } from "./knownFailures.js";

/** Structural schema type: contracts resolve zod's CommonJS declarations, this file its ESM ones. */
interface CheckedSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown[] } };
}

interface Contract {
  path: string;
  schema: CheckedSchema;
  /** Additional assertions on the parsed body; return a finding or nothing. */
  expect?: (body: never) => string | undefined;
}

const includesSlug = (rows: { slug?: string | null }[], slug: string, what: string) =>
  rows.some((row) => row.slug === slug) ? undefined : `${what} does not list seeded ${slug}`;

/**
 * StatisticsSchema transforms CMS rows (team id string to identity object); the endpoint
 * returns that output, so the response is checked against the transformed shape.
 */
const StatisticsMunicipalityResponseSchema = MunicipalitySchema.omit({ localteam_id: true }).extend({
  localteam_id: z.strictObject({ id: z.string() }).nullable(),
});
export const StatisticsResponseSchema = StatisticsSchema.extend({
  municipalities: z.array(StatisticsMunicipalityResponseSchema),
  scores: z.array(
    ScoreSchema.omit({ date_created: true, date_updated: true }).extend({
      catalog_version: CatalogSchema,
      municipality: StatisticsMunicipalityResponseSchema,
    }),
  ),
});

export function contracts(manifest: DemoManifest): Contract[] {
  const catalog = encodeURIComponent(manifest.catalog);
  const published = manifest.municipalities.find((municipality) => municipality.published)!.slug;
  const inProgress = manifest.municipalities.find((municipality) => !municipality.published)?.slug;
  return [
    {
      path: "/api/public/site-layout",
      schema: SiteLayoutSchema,
      expect: (body: z.infer<typeof SiteLayoutSchema>) =>
        body.navigationConfig?.header_items?.some((item) => item.children?.length)
          ? includesSlug(body.municipalities, published, "site layout")
          : "site layout has no header dropdown",
    },
    {
      path: `/api/public/map?v=${catalog}`,
      schema: MapResponseSchema,
      expect: (body: z.infer<typeof MapResponseSchema>) => {
        const scores = body.scores;
        if (!scores.some((score) => score.published && score.municipality.slug === published))
          return `map does not show published ${published}`;
        if (inProgress && !scores.some((score) => !score.published && score.municipality.slug === inProgress))
          return `map does not show in-progress ${inProgress}`;
        if (scores.some((score) => !score.published && score.score_total !== null))
          return "map discloses the result of an unpublished assessment";
        return undefined;
      },
    },
    {
      path: "/api/public/municipality-updates",
      schema: MunicipalityUpdatesSchema,
      expect: (body: z.infer<typeof MunicipalityUpdatesSchema>) =>
        body.updates.some((update) => update.municipality.slug === published)
          ? undefined
          : `municipality updates do not list ${published}`,
    },
    {
      path: `/api/public/municipalities?v=${catalog}`,
      schema: z.object({ municipalities: z.array(PublicMunicipalitySchema) }),
      expect: (body: { municipalities: { slug: string }[] }) =>
        includesSlug(body.municipalities, published, "municipality list"),
    },
    {
      path: `/api/public/measures?v=${catalog}`,
      schema: z.object({ measures: z.array(MeasureSchema) }),
      expect: (body: { measures: { slug?: string | null }[] }) =>
        body.measures.length === manifest.measures.length
          ? undefined
          : `measure list has ${body.measures.length} of ${manifest.measures.length} seeded measures`,
    },
    { path: `/api/public/stats/${catalog}`, schema: StatisticsResponseSchema },
    {
      // Unknown municipalities are a successful empty lookup; the page renders the 404.
      path: `/api/public/municipalities/ci-missing?v=${catalog}`,
      schema: z.object({ municipality: z.null() }),
    },
    {
      path: "/api/public/news",
      schema: z.object({ news: z.array(NewsListSchema) }),
      expect: (body: { news: { slug: string }[] }) => includesSlug(body.news, manifest.news[0]!, "news feed"),
    },
    { path: `/api/public/news/${manifest.news[0]}`, schema: z.object({ item: NewsDetailSchema }) },
    {
      path: "/api/public/events",
      schema: z.object({ events: z.array(EventSchema) }),
      expect: (body: { events: { slug: string }[] }) => includesSlug(body.events, manifest.events[0]!, "events"),
    },
    {
      path: "/api/public/event-series/ci-demo-series",
      schema: z.object({ series: EventSeriesSchema, events: z.array(EventSchema) }),
    },
    {
      path: "/api/public/articles",
      schema: z.object({ articles: z.array(ProjectListSchema) }),
      expect: (body: { articles: { slug: string }[] }) =>
        includesSlug(body.articles, manifest.projects[0]!, "project list"),
    },
    { path: `/api/public/articles/${manifest.projects[0]}`, schema: z.object({ article: ProjectDetailSchema }) },
    {
      path: "/api/public/jobs",
      schema: JobsListResponseSchema,
      expect: (body: { jobs: { slug: string }[] }) => includesSlug(body.jobs, manifest.jobs[0]!, "job list"),
    },
    { path: `/api/public/jobs/${manifest.jobs[0]}`, schema: JobsDetailResponseSchema },
    { path: "/api/public/climate-tools", schema: z.object({ tools: z.array(ClimateToolSchema) }) },
    { path: "/api/public/organisations", schema: z.object({ organisations: z.array(OrganisationSchema) }) },
    { path: "/api/public/pages/ueber-uns", schema: z.object({ page: ContentPageSchema }) },
    { path: "/api/public/tours", schema: z.object({ tours: z.array(TourSchema) }) },
    { path: "/api/public/wahlcheck", schema: z.array(PublicElectionListSchema) },
  ];
}

export const missingRecordPaths = [
  "/api/public/news/ci-missing",
  "/api/public/pages/ci-missing",
  "/api/public/articles/ci-missing",
  "/api/public/jobs/ci-missing",
  "/api/public/events/ci-missing",
  "/api/public/event-series/ci-missing",
  "/api/public/tours/ci-missing",
  "/api/public/measures/ci-missing",
];

async function tourContracts(origin: string): Promise<Contract[]> {
  const response = await fetch(`${origin}/api/public/tours`);
  if (!response.ok) return [];
  const { tours } = (await response.json()) as { tours: { slug: string }[] };
  return tours.slice(0, 2).map((tour) => ({
    path: `/api/public/tours/${tour.slug}`,
    schema: z.object({ tour: TourSchema, stops: z.array(TourStopSchema) }),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const origin = new URL(process.argv[2] ?? "http://localhost:8080").origin;
  const manifest = readDemoManifest(process.argv[3] ?? "../../.reports/st-e2e/demo-manifest.json");
  const findings: string[] = [];
  for (const contract of [...contracts(manifest), ...(await tourContracts(origin))]) {
    const response = await fetch(origin + contract.path, { headers: { Accept: "application/json" } });
    if (response.status !== 200) {
      findings.push(`${contract.path}: HTTP ${response.status}`);
      continue;
    }
    if (!response.headers.get("content-type")?.includes("application/json"))
      findings.push(`${contract.path}: content-type ${response.headers.get("content-type")}`);
    const body: unknown = await response.json();
    const parsed = contract.schema.safeParse(body);
    if (!parsed.success) {
      findings.push(`${contract.path}: contract violation ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
      continue;
    }
    try {
      assertNoCredentialFields(body, contract.path);
    } catch (error) {
      findings.push(`${contract.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const problem = contract.expect?.(parsed.data as never);
    if (problem) findings.push(`${contract.path}: ${problem}`);
    else console.log(`PASS ${contract.path}`);
  }
  for (const path of missingRecordPaths) {
    const response = await fetch(origin + path);
    await response.arrayBuffer();
    if (response.status !== 404)
      findings.push(`${path}: unknown record returned HTTP ${response.status}, expected 404`);
    else console.log(`PASS ${path} -> 404`);
  }
  if (!printClassification("contracts", classifyFindings("contracts", findings))) process.exitCode = 1;
}
