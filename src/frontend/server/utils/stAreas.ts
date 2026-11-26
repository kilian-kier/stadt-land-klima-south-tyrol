/**
 * South Tyrol areas in the format of the Stadt.Land.Zahl API, from the province's open data
 * (server/data/st-areas.json, built by deploy/st/areas/build_areas.py).
 *
 * The platform otherwise reads German administrative areas from the external Stadt.Land.Zahl
 * service. Pointing STADTLANDZAHL_SERVER_BASE_URL/STADTLANDZAHL_BASE_URL at this site's
 * /st-areas route makes search, registration, municipality pages, nearby municipalities and
 * outlines work for South Tyrol without changing their code. Areas use German-style 12-digit
 * keys with a hierarchical prefix (21 South Tyrol, 2100D district D, 2100D0000NNN municipality
 * with ISTAT number 021NNN), because the platform derives regions from key prefixes.
 * Data collections (statistics, overview tiles) are not available and answer 404.
 */
import data from "../data/st-areas.json";

type Geometry = { type: string; coordinates: unknown };
type Entry = {
  ars: string;
  name: string;
  name_de: string | null;
  name_it: string | null;
  name_ld?: string | null;
  prefix: string;
  level: number;
  slug: string;
  population: number | null;
  istat?: string;
  bordering?: string[];
  geo_center: { lat: number; lon: number };
  geo_area: Geometry;
};

const province = data.province as Entry;
const districts = data.districts as Entry[];
const municipalities = data.municipalities as Entry[];
const all = [province, ...districts, ...municipalities];
const STATE = "Südtirol";

const byArs = new Map(all.map((entry) => [entry.ars, entry]));
const bySlug = new Map<string, Entry>();
for (const entry of all) {
  bySlug.set(entry.slug, entry);
  bySlug.set(slugText(`${entry.prefix} ${entry.name}`), entry);
}

function slugText(value: string) {
  return value
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function searchText(value: string) {
  return slugText(value).replace(/-/g, " ");
}

const isMunicipality = (entry: Entry) => entry.level === 6;
const districtOf = (entry: Entry) => byArs.get(`${entry.ars.slice(0, 5)}0000000`);

function reference(entry: Entry) {
  return { ars: entry.ars, name: entry.name, prefix: entry.prefix, level: entry.level };
}

function containedBy(entry: Entry) {
  if (entry === province) return [];
  const district = isMunicipality(entry) ? districtOf(entry) : undefined;
  return [reference(province), ...(district ? [reference(district)] : [])];
}

function area(entry: Entry, options: { geometry?: boolean } = {}) {
  return {
    ars: entry.ars,
    name: entry.name,
    prefix: entry.prefix,
    level: entry.level,
    slug: slugText(`${entry.prefix} ${entry.name}`),
    population: entry.population,
    is_reasonable_for_municipal_rating: isMunicipality(entry),
    state: STATE,
    istat: entry.istat,
    names: { "de-DE": entry.name_de, "it-IT": entry.name_it, lld: entry.name_ld ?? null },
    geo_center: entry.geo_center,
    ...(options.geometry === false ? {} : { geo_area: entry.geo_area }),
    // Municipality pages read the population from here, like from Stadt.Land.Zahl.
    data_products: { population_data: entry.population == null ? null : { population: entry.population } },
    contained_by: containedBy(entry),
    stadtlandklima_data_all: [],
  };
}

function searchResult(entry: Entry) {
  return {
    prefix: entry.prefix,
    name: entry.name,
    ars: entry.ars,
    level: entry.level,
    population: entry.population,
    is_reasonable_for_municipal_rating: isMunicipality(entry),
    stadtlandklima_data_all: [],
  };
}

function search(term: string, municipalitiesOnly: boolean) {
  const needle = searchText(term);
  if (!needle) return [];
  const candidates = municipalitiesOnly ? municipalities : [...municipalities, ...districts];
  const ranked: { entry: Entry; rank: number }[] = [];
  for (const entry of candidates) {
    const names = [entry.name, entry.name_de, entry.name_it, entry.name_ld].filter(Boolean).map((n) => searchText(n!));
    if (names.some((name) => name === needle)) ranked.push({ entry, rank: 0 });
    else if (names.some((name) => name.startsWith(needle))) ranked.push({ entry, rank: 1 });
    else if (names.some((name) => name.split(" ").some((word) => word.startsWith(needle))))
      ranked.push({ entry, rank: 2 });
    else if (names.some((name) => name.includes(needle))) ranked.push({ entry, rank: 3 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || (b.entry.population ?? 0) - (a.entry.population ?? 0))
    .slice(0, 20)
    .map(({ entry }) => searchResult(entry));
}

function distanceKm(a: Entry, b: Entry) {
  const rad = Math.PI / 180;
  const dLat = (b.geo_center.lat - a.geo_center.lat) * rad;
  const dLon = (b.geo_center.lon - a.geo_center.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.geo_center.lat * rad) * Math.cos(b.geo_center.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function bounded(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** Answers one Stadt.Land.Zahl-style request: { status, body }. */
export function stAreasResponse(method: string, rawUrl: string): { status: number; body: unknown } {
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { detail: "Method not allowed" } };
  const url = new URL(rawUrl, "http://st-areas.local");
  const path = url.pathname.replace(/^\/st-areas/, "");
  const query = url.searchParams;

  if (path === "/api/search/areas/") {
    const results = search(query.get("q") ?? "", query.get("is_reasonable_for_municipal_rating") === "true");
    return { status: 200, body: { results } };
  }

  if (path === "/api/areas/") {
    const level = Number(query.get("level"));
    const prefix = query.get("ars") ?? "";
    const limit = bounded(query.get("limit"), 200, 500);
    const results = all
      .filter((entry) => (!level || entry.level === level) && entry.ars.startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .slice(0, limit)
      .map((entry) => area(entry));
    return { status: 200, body: { results } };
  }

  if (path === "/api/manifests/collections-index") return { status: 200, body: { collections: [] } };

  const match = /^\/api\/areas\/([^/]+)\/(?:(ancestors|nearby|bordering-municipalities)\/)?$/.exec(path);
  if (match) {
    const key = decodeURIComponent(match[1]!);
    const entry = byArs.get(key) ?? bySlug.get(slugText(key));
    if (!entry) return { status: 404, body: { detail: "Not found." } };
    const action = match[2];
    if (action === "ancestors") {
      const ancestors = containedBy(entry).map((ref) => area(byArs.get(ref.ars)!, { geometry: false }));
      return { status: 200, body: { ancestors } };
    }
    if (action === "nearby") {
      const radius = bounded(query.get("radius_km"), 40, 1000);
      const levels = (query.get("levels") ?? "4,5,6").split(",").map(Number);
      const limit = bounded(query.get("limit"), 50, 500);
      const geometry = query.get("include_geometry") === "true";
      const rateable = query.get("is_reasonable_for_municipal_rating") === "true";
      const areas = all
        .filter((other) => other !== entry && levels.includes(other.level) && (!rateable || isMunicipality(other)))
        .map((other) => ({ other, distance: distanceKm(entry, other) }))
        .filter(({ distance }) => distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map(({ other, distance }) => ({ ...area(other, { geometry }), distance_km: Math.round(distance * 10) / 10 }));
      return { status: 200, body: { areas } };
    }
    if (action === "bordering-municipalities") {
      // The neighbour cards draw each neighbour's outline.
      const bordering = (entry.bordering ?? []).map((ars) => area(byArs.get(ars)!));
      return { status: 200, body: { bordering_municipalities: bordering } };
    }
    if (query.get("geometry_only") === "true")
      return { status: 200, body: { ...area(entry), contained_by: undefined } };
    return { status: 200, body: area(entry) };
  }

  return { status: 404, body: { detail: "Not found." } };
}
