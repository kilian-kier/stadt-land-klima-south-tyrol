import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anonymizationSql,
  verificationSql,
  KEPT_FILES_SQL,
  PRIVATE_COLUMNS,
  PUBLIC_FILE_REFERENCES,
  SCANNED_TABLES,
  TRUNCATED_TABLES,
} from "../../../../deploy/st/anonymize-snapshot.mts";

const anonymize = anonymizationSql();
const verify = verificationSql();

test("every private column is replaced, guarded by its existence in this database", () => {
  for (const { table, column } of PRIVATE_COLUMNS) {
    assert.match(anonymize, new RegExp(`table_name = '${table}' AND column_name = '${column}'`), `${table}.${column}`);
    assert.match(anonymize, new RegExp(`UPDATE "${table}" SET "${column}" = `), `${table}.${column}`);
  }
});

test("team page members keep their public profile, everyone else loses it", () => {
  for (const column of ["first_name", "last_name", "avatar", "bio", "title", "location", "description"]) {
    assert.match(
      anonymize,
      new RegExp(`UPDATE "directus_users" SET "${column}" = [^$]+ WHERE "${column}" IS NOT NULL AND show_on_team_page IS NOT TRUE`),
      column,
    );
  }
  assert.ok(
    PUBLIC_FILE_REFERENCES.some((r) => r.table === "directus_users" && r.where === "show_on_team_page IS TRUE"),
    "team avatars stay as files",
  );
});

test("emails and names become deterministic fakes, free text and drafts are cleared", () => {
  assert.match(anonymize, /SET "email" = 'anon-' \|\| substr\(md5\("email"::text\), 1, 12\) \|\| '@example\.invalid'/);
  assert.match(anonymize, /SET "sender_name" = 'Anon ' \|\| substr\(md5\("sender_name"::text\), 1, 8\)/);
  assert.match(anonymize, /SET "content" = '\[anonymized\]'/);
  assert.match(anonymize, /SET "draft_blocks" = '\{\}'/);
  assert.match(anonymize, /SET "token" = NULL/);
});

test("sessions, shares, notifications and revision copies are emptied", () => {
  // Together in one statement, without CASCADE (the tables reference each other).
  assert.match(anonymize, /EXECUTE 'TRUNCATE ' \|\| tables/);
  assert.doesNotMatch(anonymize, /CASCADE/i);
  for (const table of TRUNCATED_TABLES) assert.match(anonymize, new RegExp(`ARRAY\\[[^\\]]*'${table}'`), table);
});

test("only files referenced by published public content or the public folder are kept", () => {
  for (const { table, column } of PUBLIC_FILE_REFERENCES)
    assert.match(anonymize, new RegExp(`SELECT "${column}"::uuid FROM "${table}"`), `${table}.${column}`);
  assert.match(anonymize, /"status" = 'published'/);
  assert.match(anonymize, /WHERE d\.name = 'public'/);
  assert.match(anonymize, /DELETE FROM directus_files WHERE id NOT IN \(SELECT id FROM st_kept_files\)/);
  assert.match(KEPT_FILES_SQL, /^SELECT filename_disk FROM directus_files/);
});

test("the anonymization is one transaction that stops at the first error", () => {
  assert.match(anonymize, /^\\set ON_ERROR_STOP on\nBEGIN;\n/);
  assert.match(anonymize, /\nCOMMIT;$/);
  // Nothing outside the reviewed statements: no drops and no other deletes.
  assert.doesNotMatch(anonymize, /\bDROP\b/i);
  assert.equal(anonymize.match(/\bDELETE FROM\b/g)?.length, 1);
});

test("the verification checks every private column and scans private rows for real emails", () => {
  for (const { table, column } of PRIVATE_COLUMNS)
    assert.match(verify, new RegExp(`'VIOLATION %: %', '${table}\\.${column}'`), `${table}.${column}`);
  for (const { table } of SCANNED_TABLES) assert.match(verify, new RegExp(`'${table} \\(email in row\\)'`), table);
  assert.match(verify, /regexp_replace\(row_to_json\(r\)::text, '\[a-z0-9\._%\+-\]\+@example\\\.invalid', '', 'gi'\)/);
});
