/**
 * SQL for the anonymized staging snapshot (deploy-command.sh `snapshot`).
 *
 * The production database is restored into a temporary database on the server; these statements
 * run there and never against production. Rule: what the public website shows may stay, everything
 * internal, unpublished or personal is replaced or removed. Uploaded files are reduced to the ones
 * public content references. Every statement skips tables or columns this database does not have,
 * so schema changes from upstream cannot break the snapshot; the verification then fails closed.
 *
 *   node anonymize-snapshot.mts anonymize | verify | files     prints the SQL for that step
 */

type Treatment = "email" | "name" | "text" | "secret" | "json";
type Column = { table: string; column: string; treatment: Treatment; where?: string };

/** Personal or internal columns, reviewed against src/directus/schema. */
export const PRIVATE_COLUMNS: readonly Column[] = [
  { table: "directus_users", column: "email", treatment: "email" },
  { table: "directus_users", column: "password", treatment: "secret" },
  { table: "directus_users", column: "token", treatment: "secret" },
  { table: "directus_users", column: "tfa_secret", treatment: "secret" },
  { table: "directus_users", column: "auth_data", treatment: "secret" },
  { table: "directus_users", column: "external_identifier", treatment: "secret" },
  { table: "directus_users", column: "last_page", treatment: "secret" },
  { table: "directus_users", column: "phone", treatment: "secret" },
  // The team page shows these for its members only.
  { table: "directus_users", column: "first_name", treatment: "name", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "last_name", treatment: "name", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "avatar", treatment: "secret", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "bio", treatment: "text", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "title", treatment: "text", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "location", treatment: "text", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_users", column: "description", treatment: "text", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_activity", column: "ip", treatment: "secret" },
  { table: "directus_activity", column: "user_agent", treatment: "secret" },
  { table: "directus_activity", column: "origin", treatment: "secret" },
  { table: "directus_comments", column: "comment", treatment: "text" },
  { table: "candidate", column: "email", treatment: "email" },
  { table: "candidate", column: "name", treatment: "name" },
  { table: "candidate", column: "salutation", treatment: "secret" },
  { table: "candidate", column: "access_token", treatment: "secret" },
  { table: "feedback", column: "sender_name", treatment: "name" },
  { table: "feedback", column: "sender_contact", treatment: "text" },
  { table: "feedback", column: "content", treatment: "text" },
  { table: "feedback", column: "internal_response_summary", treatment: "text" },
  { table: "form_responses", column: "sender_email", treatment: "email" },
  { table: "form_responses", column: "sender_name", treatment: "name" },
  { table: "form_responses", column: "notification_email", treatment: "email" },
  { table: "form_responses", column: "response_data", treatment: "json" },
  { table: "form_responses", column: "response_summary", treatment: "text" },
  { table: "form_responses", column: "internal_response_summary", treatment: "text" },
  { table: "editors", column: "email", treatment: "email" },
  { table: "editors", column: "internal_comment", treatment: "text" },
  { table: "localteams", column: "internal_comment", treatment: "text" },
  { table: "articles", column: "submitter_email", treatment: "email" },
  { table: "job_offers", column: "contact_notes", treatment: "text" },
  { table: "edit_states", column: "owner_name", treatment: "name" },
  { table: "edit_states", column: "draft_blocks", treatment: "json" },
  { table: "edit_states", column: "mutations", treatment: "json" },
  { table: "role_invitation_requests", column: "subject", treatment: "text" },
];

/** Session, sharing and history tables; revisions hold full copies of earlier record versions. */
export const TRUNCATED_TABLES = [
  "directus_sessions",
  "directus_shares",
  "directus_notifications",
  "directus_revisions",
] as const;

/** Private tables whose whole rows must not contain a real email address after anonymization. */
export const SCANNED_TABLES: readonly { table: string; where?: string }[] = [
  { table: "directus_users", where: "show_on_team_page IS NOT TRUE" },
  { table: "directus_activity" },
  { table: "directus_comments" },
  { table: "candidate" },
  { table: "feedback" },
  { table: "form_responses" },
  { table: "editors" },
  { table: "edit_states" },
  { table: "role_invitation_requests" },
];

/** Columns that reference files shown by public content (src/directus/schema/relations). */
export const PUBLIC_FILE_REFERENCES: readonly { table: string; column: string; where?: string }[] = [
  { table: "articles", column: "image" },
  { table: "climate_tools", column: "image" },
  { table: "elections", column: "custom_logo" },
  { table: "elections", column: "sharepic" },
  { table: "elections", column: "sharepic_dark" },
  { table: "event_series", column: "brand_logo" },
  { table: "event_series", column: "cover_image" },
  { table: "events", column: "image" },
  { table: "measures", column: "image" },
  { table: "news_items", column: "image" },
  { table: "news_journey_photos", column: "file" },
  { table: "organisations", column: "logo" },
  { table: "organisations", column: "logo_dark" },
  { table: "success_project_tour_media", column: "file" },
  { table: "success_project_tour_media", column: "poster" },
  { table: "success_project_tour_stops", column: "image" },
  { table: "success_project_tour_stops", column: "itinerary_image" },
  { table: "success_project_tours", column: "brand_logo" },
  { table: "success_project_tours", column: "cover_image" },
  { table: "directus_users", column: "avatar", where: "show_on_team_page IS TRUE" },
  { table: "directus_settings", column: "project_logo" },
  { table: "directus_settings", column: "public_foreground" },
  { table: "directus_settings", column: "public_background" },
  { table: "directus_settings", column: "public_favicon" },
];

const EMAIL = "[a-z0-9._%+-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}";
const ANONYMIZED_EMAIL = "[a-z0-9._%+-]+@example\\.invalid";

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier ${name}`);
  return `"${name}"`;
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function replacement(column: Column): string {
  const c = ident(column.column);
  switch (column.treatment) {
    case "email":
      return `'anon-' || substr(md5(${c}::text), 1, 12) || '@example.invalid'`;
    case "name":
      return `'Anon ' || substr(md5(${c}::text), 1, 8)`;
    case "text":
      return `'[anonymized]'`;
    case "json":
      return `'{}'`;
    case "secret":
      return "NULL";
  }
}

/** Valid anonymized value; anything else is a violation. */
function violation(column: Column): string {
  const c = ident(column.column);
  switch (column.treatment) {
    case "email":
      return `${c}::text !~ '^anon-[0-9a-f]{12}@example\\.invalid$'`;
    case "name":
      return `${c}::text !~ '^Anon [0-9a-f]{8}$'`;
    case "text":
      return `${c}::text <> '[anonymized]'`;
    case "json":
      return `${c}::text <> '{}'`;
    case "secret":
      return "TRUE";
  }
}

/** Runs `statement` only when the column exists; NOT NULL secrets get a random value instead. */
function guardedUpdate(column: Column): string {
  const t = ident(column.table);
  const c = ident(column.column);
  const where = `${c} IS NOT NULL${column.where ? ` AND ${column.where}` : ""}`;
  const value = replacement(column);
  return `DO $st$ DECLARE nullable boolean; BEGIN
  SELECT is_nullable = 'YES' INTO nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = ${literal(column.table)} AND column_name = ${literal(column.column)};
  IF FOUND THEN
    IF ${column.treatment === "secret" ? "nullable" : "TRUE"} THEN
      EXECUTE $q$UPDATE ${t} SET ${c} = ${value} WHERE ${where}$q$;
    ELSE
      EXECUTE $q$UPDATE ${t} SET ${c} = md5(random()::text) WHERE ${where}$q$;
    END IF;
  END IF;
END $st$;`;
}

/** Keeps the files public content references, then removes all other file records. */
function fileReduction(): string {
  const inserts = PUBLIC_FILE_REFERENCES.map(({ table, column, where }) => {
    const t = ident(table);
    const c = ident(column);
    const condition = `${c} IS NOT NULL${where ? ` AND ${where}` : ""}`;
    return `DO $st$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${literal(table)} AND column_name = ${literal(column)}) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${literal(table)} AND column_name = 'status') THEN
      EXECUTE $q$INSERT INTO st_kept_files SELECT ${c}::uuid FROM ${t} WHERE ${condition} AND "status" = 'published' ON CONFLICT DO NOTHING$q$;
    ELSE
      EXECUTE $q$INSERT INTO st_kept_files SELECT ${c}::uuid FROM ${t} WHERE ${condition} ON CONFLICT DO NOTHING$q$;
    END IF;
  END IF;
END $st$;`;
  });
  return [
    "CREATE TEMP TABLE st_kept_files (id uuid PRIMARY KEY);",
    ...inserts,
    `INSERT INTO st_kept_files SELECT f.id FROM directus_files f JOIN directus_folders d ON d.id = f.folder WHERE d.name = 'public' ON CONFLICT DO NOTHING;`,
    "DELETE FROM directus_files WHERE id NOT IN (SELECT id FROM st_kept_files);",
  ].join("\n");
}

export function anonymizationSql(): string {
  // One statement, because these tables reference each other (sessions -> shares). No CASCADE: a
  // new reference from any other table stops the snapshot instead of emptying that table as well.
  const names = TRUNCATED_TABLES.map((table) => literal(ident(table).slice(1, -1))).join(", ");
  const truncation = `DO $st$ DECLARE tables text; BEGIN
  SELECT string_agg(format('%I', t), ', ') INTO tables FROM unnest(ARRAY[${names}]) AS t WHERE to_regclass('public.' || t) IS NOT NULL;
  IF tables IS NOT NULL THEN EXECUTE 'TRUNCATE ' || tables; END IF;
END $st$;`;
  return ["\\set ON_ERROR_STOP on", "BEGIN;", truncation, ...PRIVATE_COLUMNS.map(guardedUpdate), fileReduction(), "COMMIT;"].join(
    "\n",
  );
}

/** Prints one line per violation ("table.column: count"); no output means the snapshot is clean. */
export function verificationSql(): string {
  const columns = PRIVATE_COLUMNS.map((column) => {
    const t = ident(column.table);
    const c = ident(column.column);
    const condition = `${c} IS NOT NULL AND ${violation(column)}${column.where ? ` AND ${column.where}` : ""}`;
    const label = literal(`${column.table}.${column.column}`);
    // Secrets in NOT NULL columns get random values; only nullable ones must be empty.
    const applies =
      column.treatment === "secret"
        ? `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${literal(column.table)} AND column_name = ${literal(column.column)} AND is_nullable = 'YES'`
        : `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${literal(column.table)} AND column_name = ${literal(column.column)}`;
    return `DO $st$ DECLARE n bigint; BEGIN
  IF EXISTS (${applies}) THEN
    EXECUTE $q$SELECT count(*) FROM ${t} WHERE ${condition}$q$ INTO n;
    IF n > 0 THEN RAISE NOTICE 'VIOLATION %: %', ${label}, n; END IF;
  END IF;
END $st$;`;
  });
  const scans = SCANNED_TABLES.map(({ table, where }) => {
    const t = ident(table);
    const label = literal(`${table} (email in row)`);
    return `DO $st$ DECLARE n bigint; BEGIN
  IF to_regclass(${literal(`public.${table}`)}) IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM ${t} r WHERE ${where ? `${where} AND ` : ""}regexp_replace(row_to_json(r)::text, '${ANONYMIZED_EMAIL}', '', 'gi') ~* '${EMAIL}'$q$ INTO n;
    IF n > 0 THEN RAISE NOTICE 'VIOLATION %: %', ${label}, n; END IF;
  END IF;
END $st$;`;
  });
  return ["\\set ON_ERROR_STOP on", ...columns, ...scans].join("\n");
}

export const KEPT_FILES_SQL = "SELECT filename_disk FROM directus_files WHERE filename_disk IS NOT NULL ORDER BY 1;";

if (process.argv[1]?.endsWith("anonymize-snapshot.mts")) {
  const step = process.argv[2];
  if (step === "anonymize") process.stdout.write(anonymizationSql() + "\n");
  else if (step === "verify") process.stdout.write(verificationSql() + "\n");
  else if (step === "files") process.stdout.write(KEPT_FILES_SQL + "\n");
  else {
    process.stderr.write("Usage: anonymize-snapshot.mts anonymize|verify|files\n");
    process.exitCode = 2;
  }
}
