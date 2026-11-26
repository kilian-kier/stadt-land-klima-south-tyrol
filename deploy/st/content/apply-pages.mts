/**
 * Puts the South Tyrol content pages (pages.json, pages/*.html) into a CMS through its API.
 *
 *   CMS_URL=https://backend.example CMS_TOKEN_FILE=token node apply-pages.mts drafts
 *   CMS_URL=https://backend.example CMS_TOKEN_FILE=token node apply-pages.mts publish
 *
 * drafts:  creates missing pages as drafts and updates name, text and order of existing ones;
 *          it never changes the status of an existing page.
 * publish: publishes the pages and sets the header and footer navigation.
 * The token belongs to a CMS administrator; it is read from a file so that it stays out of argv.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Page = { slug: string; name: string; file: string; sort_order: number; page_category: string };
type Content = { pages: Page[]; navigation: { header_items: unknown[]; footer_columns: unknown[] } };

const here = dirname(fileURLToPath(import.meta.url));
const content = JSON.parse(readFileSync(join(here, "pages.json"), "utf8")) as Content;
const base = (process.env.CMS_URL ?? "").replace(/\/+$/, "");
const tokenFile = process.env.CMS_TOKEN_FILE ?? "";
if (!/^https:\/\/[a-z0-9.-]+$/.test(base) || !tokenFile) throw new Error("CMS_URL (https origin) and CMS_TOKEN_FILE are required");
const token = readFileSync(tokenFile, "utf8").trim();

async function cms(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as { data: unknown }).data : null;
}

async function existing(slug: string) {
  const rows = (await cms("GET", `/items/pages?fields=id,status&filter[slug][_eq]=${encodeURIComponent(slug)}&limit=2`)) as {
    id: string;
    status: string;
  }[];
  if (rows.length > 1) throw new Error(`More than one page has the slug ${slug}`);
  return rows[0];
}

const mode = process.argv[2];
if (mode === "drafts") {
  for (const page of content.pages) {
    const fields = {
      name: page.name,
      contents: readFileSync(join(here, page.file), "utf8"),
      sort_order: page.sort_order,
      page_category: page.page_category,
    };
    const row = await existing(page.slug);
    if (row) {
      await cms("PATCH", `/items/pages/${row.id}`, fields);
      console.log(`updated ${page.slug} (${row.status})`);
    } else {
      await cms("POST", "/items/pages", { slug: page.slug, status: "draft", ...fields });
      console.log(`created ${page.slug} (draft)`);
    }
  }
} else if (mode === "publish") {
  for (const page of content.pages) {
    const row = await existing(page.slug);
    if (!row) throw new Error(`${page.slug} does not exist; run drafts first`);
    if (row.status !== "published") await cms("PATCH", `/items/pages/${row.id}`, { status: "published" });
    console.log(`published ${page.slug}`);
  }
  await cms("PATCH", "/items/navigation_config", content.navigation);
  console.log("navigation updated");
} else {
  throw new Error("Usage: apply-pages.mts drafts|publish");
}
