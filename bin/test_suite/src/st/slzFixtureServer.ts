/**
 * Offline stand-in for the Stadt.Land.Zahl data API used by the development stack in CI.
 *
 * It models a reachable data service that knows the country and state regions and one
 * data product, but has no datasets or overview snapshots for it: list endpoints answer
 * empty results, other records answer 404. The frontend's own
 * contracts then exercise their "no external data" paths deterministically, instead of
 * connection errors against an unreachable host. Every request is logged so missing
 * endpoints are visible in the CI artifacts. Data-driven SLZ pages (regions, dashboards)
 * are covered by the isolated dashboard fixture test, not by this server.
 *
 * Usage: node bin/test_suite/src/st/slzFixtureServer.ts <port> <request-log-file>
 */
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

/**
 * Administrative regions above municipality level (country and states) exist in every
 * dataset; they let region pages render their "no municipality data" state.
 */
export const fixtureRegions = [
  { ars: "000000000000", name: "Deutschland", prefix: "", level: 0 },
  { ars: "030000000000", name: "Niedersachsen", prefix: "03", level: 1 },
  { ars: "040000000000", name: "Bremen", prefix: "04", level: 1 },
  { ars: "080000000000", name: "Baden-Württemberg", prefix: "08", level: 1 },
  { ars: "090000000000", name: "Bayern", prefix: "09", level: 1 },
].map((region) => ({ ...region, is_reasonable_for_municipal_rating: false, population: null }));

/** One published data product without a current overview snapshot. */
export const fixtureCollections = [
  {
    id: "wind-turbines",
    title: { "de-DE": "Windkraft", "en-US": "Wind power", "it-IT": "Energia eolica" },
    description: {
      "de-DE": "Installierte Leistung im kommunalen Vergleich.",
      "en-US": "Installed capacity compared across municipalities.",
      "it-IT": "Potenza installata a confronto tra i comuni.",
    },
    sector: "energy",
    iconify_str: "mdi:wind-turbine",
    municipality_overview: { contract_version: 1, default_metric_id: "power" },
  },
];

export function fixtureResponse(method: string, rawUrl: string): { status: number; body: unknown } {
  const url = new URL(rawUrl, "http://slz.fixture");
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { detail: "Method not allowed" } };
  const path = url.pathname;
  if (path === "/api/areas/" || path === "/api/search/areas/") return { status: 200, body: { results: [] } };
  if (path === "/api/manifests/collections-index") return { status: 200, body: { collections: fixtureCollections } };
  if (/^\/api\/areas\/[^/]+\/ancestors\/$/.test(path)) return { status: 200, body: { ancestors: [] } };
  if (/^\/api\/areas\/[^/]+\/nearby\/$/.test(path)) return { status: 200, body: { areas: [] } };
  if (/^\/api\/areas\/[^/]+\/bordering-municipalities\/$/.test(path))
    return { status: 200, body: { bordering_municipalities: [] } };
  const region = fixtureRegions.find((candidate) => path === `/api/areas/${candidate.ars}/`);
  if (region) return { status: 200, body: region };
  return { status: 404, body: { detail: "Not found." } };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const port = Number(process.argv[2] ?? "18090");
  const log = process.argv[3];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const { status, body } = fixtureResponse(request.method ?? "GET", request.url ?? "/");
    if (log) appendFileSync(log, `${new Date().toISOString()} ${request.method} ${request.url} -> ${status}\n`);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(body));
  });
  server.listen(port, "0.0.0.0", () => console.log(`Stadt.Land.Zahl fixture listening on 0.0.0.0:${port}`));
}
