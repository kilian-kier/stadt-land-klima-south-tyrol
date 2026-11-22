/**
 * Key public interactions on desktop and touch-mobile viewports against the seeded
 * development stack: header/drawer navigation into CMS pages (including a dropdown),
 * the real search palette backed by the local search index, the language selector
 * persisting through the `slk_locale` cookie across navigation and new visits, and
 * the theme toggle persisting across client navigation and reloads.
 *
 * Read-only: non-GET/HEAD requests and requests to other origins are aborted.
 * Usage: tsx src/st/interactions.browser.ts <frontend-origin>
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, newContext, waitForHydration } from "../lib/browser.js";
import { fulfillOfflineProvider } from "./offlineProviders.js";
import { cmsOrigin, isHydrationMessage } from "./publicRoutes.browser.js";

const origin = new URL(process.argv[2] ?? "http://localhost:8080").origin;
const report = fileURLToPath(new URL("../../../../.reports/st-e2e/interactions/", import.meta.url));
mkdirSync(report, { recursive: true });
const darkTheme = "staedteChallengeDark";

const viewports = {
  desktop: { viewport: { width: 1440, height: 1000 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;
type Device = keyof typeof viewports;

async function openContext(browser: Browser, device: Device, locale = "de-DE") {
  const context = await newContext(browser, { ...viewports[device], locale, colorScheme: "light" });
  await context.route("**/*", async (route) => {
    if (
      ![origin, cmsOrigin].includes(new URL(route.request().url()).origin) ||
      !["GET", "HEAD"].includes(route.request().method())
    )
      return route.abort("blockedbyclient");
    if (await fulfillOfflineProvider(route)) return;
    return route.continue();
  });
  // Development pages may still compile on first load; navigation gets a generous bound.
  context.setDefaultNavigationTimeout(90_000);
  return context;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (isHydrationMessage(message.text())) errors.push(`hydration: ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith("/api/public/") && response.status() >= 500)
      errors.push(`HTTP ${response.status()} ${url.pathname}`);
  });
  return errors;
}

async function translate(page: Page, key: string): Promise<string> {
  await waitForHydration(page);
  return page.evaluate((translationKey) => {
    type Root = Element & {
      __vue_app__?: { config: { globalProperties: { $nuxt?: { $t: (key: string) => string } } } };
    };
    const app = [...document.querySelectorAll<Root>("#nuxt-root, #__nuxt")]
      .map((root) => root.__vue_app__?.config.globalProperties.$nuxt)
      .find(Boolean);
    if (!app) throw new Error("Hydrated Nuxt app is required");
    return app.$t(translationKey);
  }, key);
}

async function visit(page: Page, path: string) {
  const response = await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${path} status`).toBe(200);
  await waitForHydration(page);
}

async function openDrawer(page: Page) {
  const menu = await translate(page, "generic.menu");
  const toggle = page.locator(".slk-dock :is(button, a):visible").filter({ hasText: menu }).first();
  if (!(await toggle.getAttribute("class"))?.split(/\s+/).includes("slk-dock-active")) await toggle.click();
  await expect(toggle).toHaveClass(/slk-dock-active/);
}

/** Desktop settings live in the header dropdown, mobile settings in the drawer sheet. */
async function openSettings(page: Page, device: Device) {
  if (device === "desktop") await page.locator(".settings-trigger:visible").first().click();
  else await openDrawer(page);
}

/** Follow a real header (desktop) or drawer (mobile) link through the client router. */
async function clientNavigate(page: Page, device: Device, href: string) {
  if (device === "mobile" && !(await page.locator(`a[href="${href}"]:visible`).count())) await openDrawer(page);
  await page
    .locator(`${device === "desktop" ? "header " : ""}a[href="${href}"]:visible`)
    .first()
    .click();
  await expect(page).toHaveURL(`${origin}${href}`);
}

async function navigation(context: BrowserContext, device: Device) {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await visit(page, "/");
  await clientNavigate(page, device, "/klimawerkstatt");
  await expect(page.locator("main")).toContainText("Die Demo-Klimawerkstatt.");
  if (device === "desktop") {
    // A dropdown parent without its own page opens its children on hover.
    await page.locator("header button:visible").filter({ hasText: "Über uns" }).first().hover();
    await page.locator('a[href="/ueber-uns"]:visible').first().click();
  } else {
    await openDrawer(page);
    await page.locator("li").filter({ hasText: "Über uns" }).locator("button:visible").first().click();
    await page.locator('a[href="/ueber-uns"]:visible').first().click();
  }
  await expect(page).toHaveURL(`${origin}/ueber-uns`);
  await expect(page.locator("main")).toContainText("Über die Demo-Organisation.");
  expect(errors, `${device} navigation errors`).toEqual([]);
  await page.close();
}

async function search(context: BrowserContext, device: Device) {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await visit(page, "/news");
  if (device === "desktop") await page.locator("[data-search-header] input").click();
  else await page.locator(`header button[aria-label="${await translate(page, "generic.search")}"]`).click();
  const dialog = page.locator('[role="dialog"]:visible');
  await dialog.waitFor();
  await page.keyboard.type("Kontakt");
  const result = dialog.locator('a[href="/contact"]').first();
  await result.waitFor({ timeout: 20_000 });
  await result.click();
  await expect(page).toHaveURL(`${origin}/contact`);
  await expect(dialog).toHaveCount(0);
  expect(errors, `${device} search errors`).toEqual([]);
  await page.close();
}

async function language(browser: Browser, context: BrowserContext, device: Device) {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await visit(page, "/tools");
  await expect(page.locator("html")).toHaveAttribute("lang", "de-DE");
  await openSettings(page, device);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.locator('[role="group"]:visible button').filter({ hasText: "IT" }).first().click(),
  ]);
  await waitForHydration(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "it-IT");
  expect(page.url(), "switching keeps the route").toBe(`${origin}/tools`);
  const cookie = (await context.cookies()).find((candidate) => candidate.name === "slk_locale");
  expect(cookie?.value, "selection is stored in slk_locale").toBe("it-IT");
  // Client navigation and a fresh document load both keep the selection.
  await clientNavigate(page, device, "/klimawerkstatt");
  await expect(page.locator("html")).toHaveAttribute("lang", "it-IT");
  const second = await context.newPage();
  await visit(second, "/measures");
  await expect(second.locator("html")).toHaveAttribute("lang", "it-IT");
  await second.close();
  // The stored cookie wins over a different browser language in a new visit.
  const english = await openContext(browser, device, "en-GB");
  await english.addCookies([{ name: "slk_locale", value: "it-IT", url: origin }]);
  const fresh = await english.newPage();
  await visit(fresh, "/");
  await expect(fresh.locator("html")).toHaveAttribute("lang", "it-IT");
  await english.close();
  expect(errors, `${device} language errors`).toEqual([]);
  await page.close();
}

async function theme(context: BrowserContext, device: Device) {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await visit(page, "/news");
  const initial = await page.locator("html").getAttribute("data-theme");
  expect(initial, "light browser preference starts light").not.toBe(darkTheme);
  await openSettings(page, device);
  await page.locator(".theme-toggle:visible").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", darkTheme);
  expect(await page.evaluate(() => localStorage.getItem("slk_theme_preference"))).toBe("dark");
  if (device === "desktop") await page.keyboard.press("Escape");
  await clientNavigate(page, device, "/klimawerkstatt");
  await expect(page.locator("html")).toHaveAttribute("data-theme", darkTheme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForHydration(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", darkTheme);
  await page.screenshot({ path: `${report}${device}-dark.png` });
  await openSettings(page, device);
  await page.locator(".theme-toggle:visible").first().click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", darkTheme);
  expect(await page.evaluate(() => localStorage.getItem("slk_theme_preference"))).toBe("light");
  expect(errors, `${device} theme errors`).toEqual([]);
  await page.close();
}

const browser = await launchBrowser(true);
const failures: string[] = [];
try {
  for (const device of Object.keys(viewports) as Device[]) {
    for (const [name, scenario] of [
      ["navigation", (context: BrowserContext) => navigation(context, device)],
      ["search", (context: BrowserContext) => search(context, device)],
      ["language", (context: BrowserContext) => language(browser, context, device)],
      ["theme", (context: BrowserContext) => theme(context, device)],
    ] as const) {
      const context = await openContext(browser, device);
      try {
        await scenario(context);
        console.log(`PASS ${device} ${name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n").slice(0, 6).join(" | ") : String(error);
        failures.push(`${device} ${name}: ${message}`);
        console.log(`FAIL ${device} ${name}: ${message}`);
        for (const [index, page] of context.pages().entries())
          await page.screenshot({ path: `${report}${device}-${name}-${index}.png` }).catch(() => undefined);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`${failures.length} of 8 interaction scenarios failed`);
if (failures.length) process.exitCode = 1;
