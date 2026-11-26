import { test } from "node:test";
import assert from "node:assert/strict";
import { stAreasResponse } from "../../../../src/frontend/server/utils/stAreas.ts";
import data from "../../../../src/frontend/server/data/st-areas.json" with { type: "json" };

type Area = Record<string, unknown> & { ars: string; name: string; level: number };
const get = (path: string) => stAreasResponse("GET", `/st-areas${path}`);
const body = <T>(path: string) => {
  const response = get(path);
  assert.equal(response.status, 200, path);
  return response.body as T;
};

test("the dataset holds all 116 municipalities, 8 districts and South Tyrol with keys in the ARS shape", () => {
  assert.equal(data.municipalities.length, 116);
  assert.equal(data.districts.length, 8);
  assert.equal(data.province.ars, "210000000000");
  for (const municipality of data.municipalities) {
    assert.match(municipality.ars, /^2100[1-8]0000\d{3}$/, municipality.name);
    assert.equal(municipality.ars.slice(-3), municipality.istat.slice(-3), municipality.name);
    assert.ok((municipality.population ?? 0) > 0, municipality.name);
  }
  const bozen = data.municipalities.find((m) => m.istat === "021008");
  assert.equal(bozen?.name, "Bozen / Bolzano");
});

test("search finds municipalities by their German, Italian and Ladin names, ignoring accents and case", () => {
  for (const [term, expected] of [
    ["Bozen", "Bozen / Bolzano"],
    ["bolzano", "Bozen / Bolzano"],
    ["Merano", "Meran / Merano"],
    ["abtei", "Badia / Abtei"],
    ["sudtirol", undefined],
  ] as const) {
    const { results } = body<{ results: Area[] }>(`/api/search/areas/?q=${encodeURIComponent(term)}`);
    if (expected) assert.equal(results[0]?.name, expected, term);
    else
      assert.ok(
        results.every((r) => r.level === 6 || r.level === 4),
        term,
      );
  }
  const rateable = body<{ results: Area[] }>("/api/search/areas/?q=bruneck&is_reasonable_for_municipal_rating=true");
  assert.ok(
    rateable.results.length > 0 && rateable.results.every((r) => r.is_reasonable_for_municipal_rating === true),
  );
});

test("an area resolves by key and by slug with its outline, centre, state and parents", () => {
  const bozen = body<Area>("/api/areas/210040000008/");
  assert.equal(bozen.name, "Bozen / Bolzano");
  assert.equal(bozen.state, "Südtirol");
  assert.equal(bozen.is_reasonable_for_municipal_rating, true);
  assert.ok((bozen.geo_area as { type: string }).type.endsWith("Polygon"));
  assert.deepEqual(
    (bozen.contained_by as Area[]).map((a) => a.level),
    [2, 4],
  );
  assert.equal(body<Area>(`/api/areas/${bozen.slug}/`).ars, bozen.ars);
  assert.equal(get("/api/areas/999999999999/").status, 404);
});

test("children, ancestors, nearby and bordering municipalities follow the hierarchy", () => {
  const districts = body<{ results: Area[] }>("/api/areas/?level=4");
  assert.equal(districts.results.length, 8);
  const pustertal = districts.results.find((d) => d.name.startsWith("Pustertal"))!;
  const inPustertal = body<{ results: Area[] }>(`/api/areas/?level=6&ars=${pustertal.ars.slice(0, 5)}`);
  assert.ok(
    inPustertal.results.length > 20 && inPustertal.results.every((m) => m.ars.startsWith(pustertal.ars.slice(0, 5))),
  );

  const { ancestors } = body<{ ancestors: Area[] }>("/api/areas/210040000008/ancestors/");
  assert.deepEqual(
    ancestors.map((a) => a.ars),
    ["210000000000", "210040000000"],
  );

  const { areas } = body<{ areas: (Area & { distance_km: number })[] }>(
    "/api/areas/210040000008/nearby/?radius_km=15&levels=4,5,6&is_reasonable_for_municipal_rating=true",
  );
  assert.ok(areas.length > 3 && areas.every((a) => a.level === 6 && a.distance_km <= 15 && a.ars !== "210040000008"));

  const { bordering_municipalities } = body<{ bordering_municipalities: Area[] }>(
    "/api/areas/210040000008/bordering-municipalities/",
  );
  assert.ok(bordering_municipalities.some((m) => m.name.startsWith("Leifers")));
});

test("data collections are not available and nothing but GET is answered", () => {
  assert.equal(get("/api/collections/stadtlandklima/overview/").status, 404);
  assert.deepEqual(body<{ collections: unknown[] }>("/api/manifests/collections-index").collections, []);
  assert.equal(stAreasResponse("POST", "/st-areas/api/search/areas/").status, 405);
});
