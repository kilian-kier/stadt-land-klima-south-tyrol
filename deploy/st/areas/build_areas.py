"""Builds src/frontend/server/data/st-areas.json from the open data of the Autonomous Province of Bolzano.

Sources (all CC0, https://data.civis.bz.it):
  - Municipalities, districts and land boundaries: WFS p_bz-AdministrativeUnits
    (Municipalities, Districts, Land), requested in EPSG:4326 as GeoJSON
  - Official resident population: WFS p_bz-Astat:OfficialResidentPopulation

  python build_areas.py <download directory> <output json>

The platform expects German-style 12-digit area keys (ARS) with a hierarchical prefix:
  210000000000  South Tyrol (level 2, like a German state)
  2100D0000000  district D (level 4, like a Kreis)
  2100D0000NNN  municipality with ISTAT number 021NNN in district D (level 6, rateable)
The ISTAT code is kept in every municipality as `istat`.
Requires shapely (pip install shapely).
"""
import json
import re
import sys
import unicodedata

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

SOURCE, OUTPUT = sys.argv[1], sys.argv[2]
SIMPLIFY = 0.0004  # degrees, about 30-45 m; keeps the file small enough to ship with the website
PROVINCE_ARS = "210000000000"


def load(name):
    with open(f"{SOURCE}/{name}.geojson", encoding="utf-8") as handle:
        return json.load(handle)["features"]


def clean(value):
    value = (value or "").strip()
    return value or None


def slugify(value):
    value = unicodedata.normalize("NFKD", value.replace("ß", "ss")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def rounded(geometry):
    def walk(coordinates):
        if isinstance(coordinates[0], (int, float)):
            return [round(coordinates[0], 5), round(coordinates[1], 5)]
        return [walk(part) for part in coordinates]

    data = mapping(geometry)
    return {"type": data["type"], "coordinates": walk(data["coordinates"])}


def outline(geometry):
    simplified = geometry.simplify(SIMPLIFY, preserve_topology=True)
    return rounded(simplified if not simplified.is_empty else geometry)


def center(geometry):
    point = geometry.representative_point()
    return {"lat": round(point.y, 5), "lon": round(point.x, 5)}


def display_name(german, italian, ladin):
    # Official multilingual form: Ladin first where it exists, then German, then Italian.
    names = []
    for name in (ladin, german, italian):
        if name and name not in names:
            names.append(name)
    return " / ".join(names)


population = {int(f["properties"]["ISTAT_CODE"]): int(f["properties"]["BW_WOHNBEV"]) for f in load("population")}

districts = {}
for feature in load("Districts"):
    properties = feature["properties"]
    code = int(properties["CODE"])
    geometry = shape(feature["geometry"])
    districts[code] = {
        "ars": f"2100{code}0000000",
        "name": display_name(clean(properties["NAME_DE"]), clean(properties["NAME_IT"]), None),
        "name_de": clean(properties["NAME_DE"]),
        "name_it": clean(properties["NAME_IT"]),
        "prefix": "Bezirksgemeinschaft",
        "level": 4,
        "geometry": geometry,
    }

municipalities = []
for feature in load("Municipalities"):
    properties = feature["properties"]
    istat = int(properties["ISTAT_CODE"])
    district = int(properties["DISTR_CODE"])
    number = istat - 21000
    assert 0 < number < 1000 and district in districts, properties
    german, italian, ladin = clean(properties["NAME_DE"]), clean(properties["NAME_IT"]), clean(properties["NAME_LD"])
    name = display_name(german, italian, ladin)
    municipalities.append(
        {
            "ars": f"2100{district}0000{number:03d}",
            "istat": f"0{istat}",
            "name": name,
            "name_de": german,
            "name_it": italian,
            "name_ld": ladin,
            "slug": slugify(name),
            "prefix": "Gemeinde",
            "level": 6,
            "district": district,
            "population": population.get(istat),
            "geometry": shape(feature["geometry"]),
        }
    )
assert len(municipalities) == 116, len(municipalities)
assert len({m["slug"] for m in municipalities}) == 116, "duplicate slugs"

for district in districts.values():
    district["population"] = sum(m["population"] or 0 for m in municipalities if m["district"] == int(district["ars"][4]))
    district["slug"] = slugify(district["name"])

province_geometry = unary_union([shape(f["geometry"]) for f in load("Land") if not f["properties"].get("IS_MASK")])
province = {
    "ars": PROVINCE_ARS,
    "name": "Südtirol",
    "name_de": "Südtirol",
    "name_it": "Alto Adige",
    "prefix": "Land",
    "level": 2,
    "slug": "suedtirol",
    "population": sum(m["population"] or 0 for m in municipalities),
}

# Neighbours from the original (unsimplified) boundaries.
for municipality in municipalities:
    grown = municipality["geometry"].buffer(0.0001)
    municipality["bordering"] = sorted(
        other["ars"] for other in municipalities if other is not municipality and grown.intersects(other["geometry"])
    )


def area(entry, geometry):
    data = {key: value for key, value in entry.items() if key not in ("geometry", "district")}
    data["geo_center"] = center(geometry)
    data["geo_area"] = outline(geometry)
    return data


output = {
    "source": "Autonome Provinz Bozen - Südtirol, Open Data (CC0): p_bz-AdministrativeUnits, p_bz-Astat:OfficialResidentPopulation",
    "province": area(province, province_geometry),
    "districts": [area(d, d["geometry"]) for d in sorted(districts.values(), key=lambda d: d["ars"])],
    "municipalities": [area(m, m["geometry"]) for m in sorted(municipalities, key=lambda m: m["name"])],
}
with open(OUTPUT, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(output, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
print(f"{OUTPUT}: {len(output['municipalities'])} municipalities, {len(output['districts'])} districts")

# The overview maps draw a country outline and its first-level borders from two static files
# (named after Germany upstream). In South Tyrol they hold the province and its districts.
ASSETS = OUTPUT.rsplit("/server/", 1)[0] + "/assets"
with open(f"{ASSETS}/germany-polygon.json", "w", encoding="utf-8", newline="\n") as handle:
    json.dump(
        {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "properties": {"NAME_0": "Südtirol"}, "geometry": outline(province_geometry)}],
        },
        handle,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    handle.write("\n")
with open(f"{ASSETS}/germany-state-borders.json", "w", encoding="utf-8", newline="\n") as handle:
    json.dump(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"NAME_0": "Südtirol", "NAME_1": d["name"], "TYPE_1": "Bezirksgemeinschaft"},
                    "geometry": outline(d["geometry"]),
                }
                for d in sorted(districts.values(), key=lambda d: d["ars"])
            ],
        },
        handle,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    handle.write("\n")
print(f"{ASSETS}: South Tyrol outline and district borders")
