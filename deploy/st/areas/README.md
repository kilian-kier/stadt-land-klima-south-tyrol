# South Tyrol areas

The platform reads administrative areas (search, registration, municipality pages, nearby
municipalities, outlines) from a service in the format of upstream's Stadt.Land.Zahl API.
For South Tyrol the website answers these requests itself from
`src/frontend/server/data/st-areas.json` (`src/frontend/server/utils/stAreas.ts`, route `/st-areas`).

Configure the website with

    STADTLANDZAHL_SERVER_BASE_URL=http://127.0.0.1:3000/st-areas
    STADTLANDZAHL_BASE_URL=https://<site>/st-areas

Areas use 12-digit keys in the shape the platform expects: `210000000000` South Tyrol,
`2100D0000000` district D, `2100D0000NNN` the municipality with ISTAT code `021NNN`.
The overview maps' outline files (`src/frontend/assets/germany-*.json`, named after upstream's
Germany maps) hold South Tyrol and its districts.

## Rebuilding the data

Sources, all CC0, from the open data portal of the Autonomous Province of Bolzano
(https://data.civis.bz.it):

    B="https://geoservices1.civis.bz.it/geoserver"
    Q="service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326"
    for layer in Municipalities Districts Land; do
      curl -o "$layer.geojson" "$B/p_bz-AdministrativeUnits/ows?$Q&typeNames=p_bz-AdministrativeUnits:$layer"
    done
    curl -o population.geojson "$B/p_bz-Astat/ows?$Q&typeNames=p_bz-Astat:OfficialResidentPopulation"

Then, with `pip install shapely`:

    python deploy/st/areas/build_areas.py <download directory> src/frontend/server/data/st-areas.json

Municipality names are shown in the official multilingual form (Ladin, German, Italian).
Data collections of Stadt.Land.Zahl (statistics, region overview tiles) do not exist for
South Tyrol; those requests answer 404.
