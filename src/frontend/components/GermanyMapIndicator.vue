<template>
  <svg
    :viewBox="`0 0 ${SVG_W} ${SVG_H}`"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    class="germany-map-indicator block"
    :style="indicatorStyle"
  >
    <!-- State shapes rendered from real GeoJSON -->
    <path
      v-for="(d, i) in statePaths"
      :key="i"
      :d="d"
      fill="var(--germany-map-fill)"
      stroke="var(--germany-map-stroke)"
      stroke-width="0.5"
      stroke-linejoin="round"
      stroke-linecap="round"
    />

    <!-- Marker: only shown when lat/lon are valid and within Germany -->
    <template v-if="markerX !== null && markerY !== null">
      <!-- Outer glow ring -->
      <circle :cx="markerX" :cy="markerY" r="4" fill="var(--germany-map-marker)" fill-opacity="0.2" />
      <!-- Outer filled ring -->
      <circle :cx="markerX" :cy="markerY" r="2.8" fill="var(--germany-map-marker)" />
      <!-- Contrasting inner -->
      <circle :cx="markerX" :cy="markerY" r="1.4" fill="var(--germany-map-marker-inner)" />
      <!-- Center dot -->
      <circle :cx="markerX" :cy="markerY" r="0.6" fill="var(--germany-map-marker)" />
    </template>
  </svg>
</template>

<script lang="ts">
import { BoundaryGeometrySchema } from "~/shared/contracts/geometry";
import stateBordersData from "~/assets/germany-state-borders.json";
</script>

<script setup lang="ts">
import type { PropType } from "vue";

import { computed } from "vue";

// South Tyrol: the outline files hold the province and its districts (deploy/st/areas).
const LON_MIN = 10.35,
  LON_MAX = 12.5;
const LAT_MAX = 47.11,
  LAT_MIN = 46.2;
// Aspect-corrected viewBox: South Tyrol is ~2.15° lon × 0.91° lat.
// Applying cos(46.65°) ≈ 0.686 lon-scale: effective width = 2.15 × 0.686 ÷ 0.91 × 100 ≈ 162
const SVG_W = 162;
const SVG_H = 100;

function project(lon: number, lat: number): [number, number] {
  return [((lon - LON_MIN) / (LON_MAX - LON_MIN)) * SVG_W, ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * SVG_H];
}

function ringToPath(ring: number[][]) {
  if (!ring || ring.length < 3) return "";
  const MIN_DIST = 0.4; // skip sub-pixel points for a tiny map
  let d = "";
  let px: number | null = null,
    py: number | null = null;
  for (const coord of ring) {
    const [x, y] = project(coord[0]!, coord[1]!);
    if (px === null || py === null) {
      d += `M${x.toFixed(1)},${y.toFixed(1)}`;
      px = x;
      py = y;
    } else if (Math.hypot(x - px, y - py) >= MIN_DIST) {
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
      px = x;
      py = y;
    }
  }
  return d ? d + "Z" : "";
}

// Computed once at module level (static GeoJSON data)
const statePaths = stateBordersData.features
  .map((f) => {
    const geom = BoundaryGeometrySchema.parse(f.geometry);
    if (!geom) return "";
    if (geom.type === "Polygon") return geom.coordinates.map(ringToPath).filter(Boolean).join("");
    if (geom.type === "MultiPolygon")
      return geom.coordinates
        .flatMap((p) => p.map(ringToPath))
        .filter(Boolean)
        .join("");
    return "";
  })
  .filter(Boolean);

const props = defineProps({
  /** WGS84 latitude */
  lat: { type: Number as PropType<number | null | undefined>, default: null },
  /** WGS84 longitude */
  lon: { type: Number as PropType<number | null | undefined>, default: null },
  /** Display width in pixels */
  size: { type: Number as PropType<number | undefined>, default: 80 },
  /** State fill color */
  fillColor: { type: String as PropType<string | undefined>, default: "#dbeafe" },
  /** State stroke color */
  strokeColor: { type: String as PropType<string | undefined>, default: "#93c5fd" },
  /** Marker color */
  markerColor: { type: String as PropType<string | undefined>, default: "#006e94" },
  /** State fill color in dark mode */
  darkFillColor: { type: String as PropType<string | undefined>, default: "var(--slk-blue-tint)" },
  /** State stroke color in dark mode */
  darkStrokeColor: { type: String as PropType<string | undefined>, default: "var(--slk-blue)" },
  /** Marker color in dark mode */
  darkMarkerColor: { type: String as PropType<string | undefined>, default: "var(--slk-blue-bright)" },
});

const indicatorStyle = computed(() => ({
  width: `${props.size}px`,
  height: "auto",
  "--germany-map-fill-light": props.fillColor,
  "--germany-map-stroke-light": props.strokeColor,
  "--germany-map-marker-light": props.markerColor,
  "--germany-map-fill-dark": props.darkFillColor,
  "--germany-map-stroke-dark": props.darkStrokeColor,
  "--germany-map-marker-dark": props.darkMarkerColor,
}));

// The marker uses the same projection as the outlines.
const markerX = computed(() => {
  if (props.lon == null || props.lat == null) return null;
  const [x] = project(props.lon, props.lat);
  return x >= 0 && x <= SVG_W ? x : null;
});

const markerY = computed(() => {
  if (props.lon == null || props.lat == null) return null;
  const [, y] = project(props.lon, props.lat);
  return y >= 0 && y <= SVG_H ? y : null;
});
</script>

<style>
.germany-map-indicator {
  --germany-map-fill: var(--germany-map-fill-light);
  --germany-map-stroke: var(--germany-map-stroke-light);
  --germany-map-marker: var(--germany-map-marker-light);
  --germany-map-marker-inner: #ffffff;
}

html[data-theme="staedteChallengeDark"] .germany-map-indicator {
  --germany-map-fill: var(--germany-map-fill-dark);
  --germany-map-stroke: var(--germany-map-stroke-dark);
  --germany-map-marker: var(--germany-map-marker-dark);
  --germany-map-marker-inner: var(--slk-surface);
}
</style>
