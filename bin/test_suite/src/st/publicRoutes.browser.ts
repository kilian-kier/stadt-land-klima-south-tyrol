/**
 * Crawl every canonical public route plus real dynamic records in German, English and
 * Italian. Each page must render with HTTP 200, the requested `lang`, a non-empty
 * translated title, no raw translation keys, no uncaught page errors, no console
 * errors, no hydration mismatch warnings and no failing `/api/public/*` responses.
 *
 * Read-only: every non-GET/HEAD request and every request leaving the tested origin
 * is aborted, so the crawl can neither change data nor depend on the internet.
 *
 * Usage: tsx src/st/publicRoutes.browser.ts <frontend-origin> [demo-manifest.json]
 */
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { PUBLIC_NUXT_ROUTES } from "../../../../src/frontend/shared/publicRoutes.js";
import { translationKeys } from "../../../../src/frontend/shared/translationKeys.js";
import { launchBrowser, newContext, waitForHydration } from "../lib/browser.js";
import { readDemoManifest } from "./demoManifest.js";
import { classifyFindings, printClassification } from "./knownFailures.js";
import { fulfillOfflineProvider } from "./offlineProviders.js";

export const locales = ["de-DE", "en-GB", "it-IT"] as const;
export type Locale = (typeof locales)[number];

const dottedKeys = new Set<string>(translationKeys.filter((key) => key.includes(".")));
/** Visible tokens that are literally a translation key mean a missing translation. */
export function rawTranslationKeys(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][\w-]*(?:\.[\w-]+)+/g)) if (dottedKeys.has(match[0])) found.add(match[0]);
  return [...found];
}

/** Console/page messages that identify a hydration mismatch in Vue/Nuxt. */
export function isHydrationMessage(text: string): boolean {
  return /hydration/i.test(text) && /mismatch|mismatches/i.test(text);
}

/** The local CMS serves public assets to the browser; it is part of the system under test. */
export const cmsOrigin = new URL(process.env.SLK_TEST_BACKEND_URL ?? "http://localhost:8081").origin;

export interface RouteCheck {
  path: string;
  /** Expected document status; non-200 routes are explicit negative checks. */
  status?: number;
}

export function staticRoutes(): RouteCheck[] {
  return PUBLIC_NUXT_ROUTES.map((route) => ({ path: route.url }));
}

async function discoverSlugs(origin: string, path: string): Promise<string[]> {
  const response = await fetch(origin + path);
  if (!response.ok) throw new Error(`Route discovery ${path} returned HTTP ${response.status}`);
  const slugs = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else {
      const record = value as Record<string, unknown>;
      if (typeof record.slug === "string" && record.slug) slugs.add(record.slug);
      for (const nested of Object.values(record)) visit(nested, depth + 1);
    }
  };
  visit(await response.json(), 0);
  return [...slugs];
}

export async function dynamicRoutes(origin: string, manifestPath?: string): Promise<RouteCheck[]> {
  const routes: RouteCheck[] = [];
  if (manifestPath) {
    const manifest = readDemoManifest(manifestPath);
    const catalog = encodeURIComponent(manifest.catalog);
    for (const municipality of manifest.municipalities) {
      routes.push({ path: `/municipalities/${municipality.slug}` });
      routes.push({ path: `/municipalities/${municipality.slug}?v=${catalog}` });
    }
    for (const slug of manifest.measures.slice(0, 3)) routes.push({ path: `/measures/${slug}?v=${catalog}` });
    routes.push({ path: `/measures/sectors`, status: 404 }, { path: `/measures/sectors/energy?v=${catalog}` });
    for (const slug of manifest.news.slice(0, 2)) routes.push({ path: `/news/${slug}` });
    for (const slug of manifest.events.slice(0, 2)) routes.push({ path: `/events/${slug}` });
    routes.push({ path: `/events/series/ci-demo-series` });
    for (const slug of manifest.projects) routes.push({ path: `/projects/${slug}` });
    for (const slug of manifest.jobs) routes.push({ path: `/jobs/${slug}` });
    for (const slug of manifest.pages.filter((slug) => slug !== "index")) routes.push({ path: `/${slug}` });
  }
  for (const slug of await discoverSlugs(origin, "/api/public/tours")) routes.push({ path: `/projects/tours/${slug}` });
  routes.push({ path: "/spenden-statt-schenken" });
  // Negative checks: unknown records must be a clean 404 page, never a server error.
  // (Unknown news slugs deliberately render 200 so editors can open drafts client-side.)
  routes.push(
    { path: "/ci-route-that-does-not-exist", status: 404 },
    { path: "/municipalities/ci-municipality-that-does-not-exist", status: 404 },
  );
  return routes;
}

export interface PageFindings {
  findings: string[];
  externalRequests: Set<string>;
}

/** Open one route in one locale and collect every finding. */
export async function checkRoute(
  browser: Browser,
  origin: string,
  route: RouteCheck,
  locale: Locale,
  options: { viewport?: { width: number; height: number }; screenshotDirectory?: string } = {},
): Promise<PageFindings> {
  const label = `${locale} ${route.path}`;
  const findings: string[] = [];
  // Error documents are served under the strict fallback policy of server/errorHandler.ts
  // when the renderer emits no CSP of its own (development); they are checked for status,
  // language, title and translations, but not for hydration.
  const negative = route.status !== undefined && route.status !== 200;
  const externalRequests = new Set<string>();
  const context = await newContext(browser, {
    locale,
    viewport: options.viewport ?? { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.addCookies([{ name: "slk_locale", value: locale, url: origin }]);
  await context.route("**/*", async (request) => {
    const url = new URL(request.request().url());
    if (url.origin !== origin && url.origin !== cmsOrigin) {
      externalRequests.add(url.origin);
      return request.abort("blockedbyclient");
    }
    // Client-side failure reports are same-origin telemetry; the failure itself is
    // already a console finding.
    if (url.pathname === "/api/security/client-event" && request.request().method() === "POST")
      return request.continue();
    if (!["GET", "HEAD"].includes(request.request().method())) {
      findings.push(`${label}: blocked unexpected ${request.request().method()} ${url.pathname}`);
      return request.abort("blockedbyclient");
    }
    if (await fulfillOfflineProvider(request)) return;
    return request.continue();
  });
  const page = await context.newPage();
  const pending: Promise<unknown>[] = [];
  page.on("pageerror", (error) => findings.push(`${label}: uncaught page error: ${error.message.slice(0, 300)}`));
  page.on("console", (message) => {
    const text = message.text();
    if (isHydrationMessage(text)) {
      // Vue passes the mismatching node and texts as console arguments.
      const details = Promise.all(message.args().map((arg) => arg.jsonValue().then(String, () => arg.toString()))).then(
        (args) => args.join(" ").replace(/\s+/g, " ").slice(0, 400),
        () => text.slice(0, 300),
      );
      pending.push(details.then((detail) => findings.push(`${label}: hydration mismatch: ${detail}`)));
    } else if (message.type() === "error" && !negative) {
      const source = message.location().url;
      // Network failures are judged by status below (any same-origin 5xx, unexpected
      // public API 4xx) and by the blocked-origin report, not by Chromium's console echo.
      if (text.startsWith("Failed to load resource:")) return;
      findings.push(`${label}: console error: ${text.slice(0, 300)}${source ? ` (${new URL(source).pathname})` : ""}`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin && url.origin !== cmsOrigin) return;
    const status = response.status();
    if (status >= 500 || (url.pathname.startsWith("/api/public/") && status >= 400 && status !== 404))
      findings.push(`${label}: ${url.origin === origin ? "" : url.origin}${url.pathname} returned HTTP ${status}`);
  });
  try {
    const response = await page.goto(origin + route.path, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const expected = route.status ?? 200;
    if (response?.status() !== expected)
      findings.push(`${label}: document returned HTTP ${response?.status() ?? "none"}, expected ${expected}`);
    if (!negative) await waitForHydration(page);
    // Client-side data requests and lazy components settle before the checks below.
    // Bounded settling only; continuous map/tile traffic is not itself a defect.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
    const lang = await page.locator("html").getAttribute("lang");
    if (lang !== locale) findings.push(`${label}: <html lang> is ${lang}, expected ${locale}`);
    const title = (await page.title()).trim();
    if (!title) findings.push(`${label}: empty <title>`);
    for (const key of rawTranslationKeys(title)) findings.push(`${label}: raw translation key in <title>: ${key}`);
    const text = await page.locator("body").innerText({ timeout: 20_000 });
    for (const key of rawTranslationKeys(text)) findings.push(`${label}: raw translation key in page: ${key}`);
    const description = await page
      .locator('meta[name="description"]')
      .first()
      .getAttribute("content")
      .catch(() => "");
    for (const key of rawTranslationKeys(description ?? ""))
      findings.push(`${label}: raw translation key in meta description: ${key}`);
    if (expected === 200 && /\b(?:500|Internal Server Error)\b/.test(title))
      findings.push(`${label}: error page title "${title}"`);
  } catch (error) {
    findings.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  } finally {
    await Promise.all(pending);
    if (findings.length && options.screenshotDirectory) {
      const name = `${locale}-${route.path.replace(/[^\w-]+/g, "_").slice(0, 80)}.png`;
      await page.screenshot({ path: `${options.screenshotDirectory}/${name}`, fullPage: false }).catch(() => undefined);
    }
    await context.close();
  }
  return { findings, externalRequests };
}

/** Group findings by message (without locale/route) so a long crawl stays readable. */
export function summarizeFindings(findings: string[], examples = 4): string[] {
  const groups = new Map<string, string[]>();
  for (const finding of findings) {
    const match = /^(\S+ \S+): (.*)$/s.exec(finding);
    const where = match?.[1] ?? "";
    const message = (match?.[2] ?? finding)
      .replace(/sha256-[A-Za-z0-9+/=]+/g, "sha256-...")
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<uuid>")
      .slice(0, 240);
    groups.set(message, [...(groups.get(message) ?? []), where]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([message, where]) =>
        `${where.length}x ${message}  [${where.slice(0, examples).join(", ")}${where.length > examples ? ", ..." : ""}]`,
    );
}

/** Run checks with bounded concurrency; results keep the input order. */
export async function inParallel<T, R>(items: T[], workers: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const origin = new URL(process.argv[2] ?? "http://localhost:8080").origin;
  const manifest = process.argv[3]?.startsWith("--") ? undefined : process.argv[3];
  const report = new URL("../../../../.reports/st-e2e/crawl/", import.meta.url);
  mkdirSync(report, { recursive: true });
  const routes = [...staticRoutes(), ...(await dynamicRoutes(origin, manifest))];
  const browser = await launchBrowser(true);
  const started = performance.now();
  try {
    // Warm the development server's on-demand compilation once per route, so the
    // per-locale checks below measure rendering instead of first compilation.
    await inParallel(routes, 3, async (route) => {
      await fetch(origin + route.path, { signal: AbortSignal.timeout(180_000) }).catch(() => undefined);
    });
    // One unchecked browser visit per route lets the development server finish its
    // client dependency optimisation (Vite answers stale chunks with 504 and reloads).
    await inParallel(routes, 3, (route) => checkRoute(browser, origin, route, "de-DE"));
    if (process.argv.includes("--warm-up-only")) {
      console.log(`Warmed ${routes.length} routes in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      process.exit(0);
    }
    const jobs = routes.flatMap((route) => locales.map((locale) => ({ route, locale })));
    const results = await inParallel(jobs, 4, ({ route, locale }) =>
      checkRoute(browser, origin, route, locale, { screenshotDirectory: fileURLToPath(report) }),
    );
    const findings = results.flatMap((result) => result.findings);
    const external = [...new Set(results.flatMap((result) => [...result.externalRequests]))].sort();
    writeFileSync(
      new URL("report.json", report),
      JSON.stringify({ origin, routes, locales, findings, blockedExternalOrigins: external }, null, 2),
    );
    console.log(
      `Crawled ${routes.length} routes x ${locales.length} locales in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    if (external.length) console.log(`Blocked requests to other origins: ${external.join(", ")}`);
    const classified = classifyFindings("crawl", findings);
    const ok = printClassification("crawl", classified);
    if (classified.failures.length) {
      console.log("\nUnexpected findings grouped by message:");
      for (const line of summarizeFindings(classified.failures)) console.log(`  ${line}`);
    }
    if (!ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
