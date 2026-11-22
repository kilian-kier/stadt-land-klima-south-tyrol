/** Deterministic identities of the st CI demo dataset (see seedDemoContent.ts). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const demoSectors = ["energy", "transport", "buildings", "agriculture", "industry", "management"] as const;

export const demo = {
  prefix: "ci-demo",
  catalog: "ci-demo-2026",
  /** Deterministic per stack, derived from its private admin secret; never a fixed password. */
  password: (env: Record<string, string>) =>
    `Demo-${createHash("sha256")
      .update(`ci-demo:${env.SECRET ?? ""}:${env.ADMIN_PASSWORD ?? ""}`)
      .digest("base64url")
      .slice(0, 24)}-A1!`,
  ratingValues: ["1", "0.75", "0.5", "0.75"],
  /**
   * Every catalogue identifier that has a Wahlcheck thesis template, by sector. A
   * production-sized catalogue lets thesis generation pick ten measures even after the
   * full workflow marks some measures as not applicable.
   */
  measureIds: {
    energy: ["EN_01", "EN_02", "EN_03", "EN_05", "EN_06", "EN_07", "EN_09", "EN_10", "EN_11", "EN_13"],
    transport: ["VK_01", "VK_03", "VK_04", "VK_05", "VK_06", "VK_08", "VK_16", "VK_20"],
    buildings: ["GW_02", "GW_03", "GW_04", "GW_05"],
    agriculture: ["LNE_02", "LNE_05", "LNE_08"],
    industry: ["IWK_03", "IWK_05", "IWK_08", "IWK_10", "IWK_11"],
    management: ["KV_02", "KV_03", "KV_07", "KV_08", "KV_09", "KV_10", "KV_11"],
  } satisfies Record<(typeof demoSectors)[number], readonly string[]>,
  municipalities: [
    {
      slug: "ci-demo-stadt",
      name: "Demostadt",
      ars: "091620000000",
      state: "Bayern",
      population: 250000,
      type: "big_city",
      coordinates: [11.576, 48.137],
      complete: true,
    },
    {
      slug: "ci-demo-dorf",
      name: "Demodorf",
      ars: "032410001001",
      state: "Niedersachsen",
      population: 4000,
      type: "small_city",
      coordinates: [9.732, 52.374],
      complete: false,
    },
  ],
  pages: [
    { slug: "index", name: "Startseite", contents: "" },
    { slug: "ueber-uns", name: "Über uns", contents: "<p>Über die Demo-Organisation.</p>" },
    { slug: "klimawerkstatt", name: "Klimawerkstatt", contents: "<p>Die Demo-Klimawerkstatt.</p>" },
  ],
  headerNavigation: [
    { id: "ci-demo-nav-municipalities-top", label: "Kommunen", link_type: "page", page_slug: "municipalities" },
    { id: "ci-demo-nav-projects-top", label: "Erfolgsprojekte", link_type: "page", page_slug: "projects" },
    {
      id: "ci-demo-nav-about",
      label: "Über uns",
      link_type: "none",
      dropdown_layout: "list",
      children: [
        { id: "ci-demo-nav-about-page", label: "Über uns", link_type: "page", page_slug: "ueber-uns" },
        { id: "ci-demo-nav-workshop", label: "Klimawerkstatt", link_type: "page", page_slug: "klimawerkstatt" },
      ],
    },
    { id: "ci-demo-nav-workshop-top", label: "Klimawerkstatt", link_type: "page", page_slug: "klimawerkstatt" },
    {
      id: "ci-demo-nav-explore",
      label: "Entdecken",
      link_type: "none",
      dropdown_layout: "cards",
      children: [
        { id: "ci-demo-nav-municipalities", label: "Kommunen", link_type: "page", page_slug: "municipalities" },
        { id: "ci-demo-nav-projects", label: "Erfolgsprojekte", link_type: "page", page_slug: "projects" },
        { id: "ci-demo-nav-measures", label: "Maßnahmen", link_type: "page", page_slug: "measures" },
      ],
    },
  ],
  /** Production-like footer columns: every page links to the main sections. */
  footerNavigation: [
    {
      id: "ci-demo-footer-sections",
      label: "Bereiche",
      link_type: "none",
      children: [
        { id: "ci-demo-footer-municipalities", label: "Kommunen", link_type: "page", page_slug: "municipalities" },
        { id: "ci-demo-footer-projects", label: "Erfolgsprojekte", link_type: "page", page_slug: "projects" },
        { id: "ci-demo-footer-news", label: "Neuigkeiten", link_type: "page", page_slug: "news" },
      ],
    },
    {
      id: "ci-demo-footer-organisation",
      label: "Organisation",
      link_type: "none",
      children: [
        { id: "ci-demo-footer-about", label: "Über uns", link_type: "page", page_slug: "ueber-uns" },
        { id: "ci-demo-footer-contact", label: "Kontakt", link_type: "page", page_slug: "contact" },
      ],
    },
  ],
} as const;

/** Deterministic measure slugs, in catalogue order. */
export function demoMeasures(): { sector: (typeof demoSectors)[number]; measureId: string; slug: string }[] {
  return demoSectors.flatMap((sector) =>
    demo.measureIds[sector].map((measureId) => ({
      sector,
      measureId,
      slug: `${demo.prefix}-${measureId.toLowerCase().replace("_", "-")}`,
    })),
  );
}

export interface DemoManifest {
  catalog: string;
  measures: string[];
  municipalities: { slug: string; published: boolean }[];
  news: string[];
  events: string[];
  projects: string[];
  pages: string[];
  jobs: string[];
  /** Suspended legacy browser identity that still stores its retired static token. */
  retiredLegacyUserId: string;
}

export function readDemoManifest(path: URL | string): DemoManifest {
  return JSON.parse(readFileSync(path, "utf8")) as DemoManifest;
}
