/**
 * Local stand-ins for external providers that CI must not contact. The CARTO basemap
 * proxy (`/api/carto-basemap`) needs a paid upstream key and internet access; without
 * them it correctly answers 503 "Basemap is not configured". St browser checks always
 * replace its assets with the neutral fixtures of lib/browser.ts so maps render offline;
 * the map components and every other request stay real.
 */
import type { Route } from "playwright";
import { offlineBasemapResponse } from "../lib/browser.js";

export const basemapFixture = offlineBasemapResponse;

/** Fulfil a basemap request with its fixture; returns false for every other request. */
export async function fulfillOfflineProvider(route: Route): Promise<boolean> {
  const fixture = basemapFixture(new URL(route.request().url()));
  if (!fixture) return false;
  await route.fulfill({ status: 200, ...fixture });
  return true;
}
