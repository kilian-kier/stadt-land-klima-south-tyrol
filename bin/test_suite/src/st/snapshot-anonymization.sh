#!/usr/bin/env bash
# The staging snapshot against the seeded test stack, after the live suites have filled it:
# the verification must find the personal data of the source, deploy/st/snapshot.sh must
# produce a snapshot, and its restored dump must be clean while public content is unchanged.
# Usage (from bin/test_suite): src/st/snapshot-anonymization.sh [copy of the snapshot]
set -Eeuo pipefail
root="$(git rev-parse --show-toplevel)"
st="$root/deploy/st"
project=slk-podman-development
db="$(podman ps -q --filter "label=io.podman.compose.project=$project" --filter label=io.podman.compose.service=db)"
[[ "$db" =~ ^[0-9a-f]{12,64}$ ]] || { echo "Expected one running test database container" >&2; exit 1; }
database="$(sed -n 's/^DB_DATABASE=//p' "$root/src/directus/.env" | tail -n 1)"
work="$(mktemp -d)"
check=slk_st_snapshot_check
sql() {
  podman exec -i "$db" sh -ec 'if command -v slk-env >/dev/null 2>&1; then exec slk-env sh -ec "$1" st-check "$2"; fi; exec sh -ec "$1" st-check "$2"' \
    st-check 'exec psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:?}" -d "$1" -f -' "$1"
}
cleanup() { echo "DROP DATABASE IF EXISTS $check;" | sql postgres > /dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

echo "== The verification detects the personal data of the unchanged source"
node "$st/anonymize-snapshot.mts" verify | sql "$database" > "$work/source-verify.log" 2>&1
grep -c VIOLATION "$work/source-verify.log" | sed 's/^/violations in the source: /'
grep -q 'VIOLATION directus_users.email' "$work/source-verify.log" ||
  { cat "$work/source-verify.log"; echo "The verification did not report the source's user emails" >&2; exit 1; }

echo "== snapshot.sh"
bash "$st/snapshot.sh" "$db" "$database" "${project}_uploads" "$work" > "$work/snapshot.tar"
tar -C "$work" -xf "$work/snapshot.tar"
cat "$work/manifest.json"
[[ "$(tar -tf "$work/snapshot.tar" | sort | tr '\n' ' ')" == "database.dump manifest.json uploads.tar " ]] ||
  { echo "Unexpected snapshot entries" >&2; exit 1; }

echo "== The restored snapshot is clean"
printf 'DROP DATABASE IF EXISTS %s;\nCREATE DATABASE %s TEMPLATE template0;\n' "$check" "$check" | sql postgres
podman exec -i "$db" sh -ec 'if command -v slk-env >/dev/null 2>&1; then exec slk-env sh -ec "$1" st-check "$2"; fi; exec sh -ec "$1" st-check "$2"' \
  st-check 'exec pg_restore -U "${POSTGRES_USER:?}" -d "$1" --no-owner --no-acl --exit-on-error' "$check" < "$work/database.dump"
node "$st/anonymize-snapshot.mts" verify | sql "$check" > "$work/snapshot-verify.log" 2>&1
if grep VIOLATION "$work/snapshot-verify.log"; then echo "The snapshot still contains personal data" >&2; exit 1; fi

echo "== Public content is unchanged, private content is gone"
counts="SELECT json_build_object(
  'published_measures', (SELECT count(*) FROM measures WHERE status = 'published'),
  'municipalities', (SELECT count(*) FROM municipalities),
  'published_articles', (SELECT count(*) FROM articles WHERE status = 'published'),
  'users', (SELECT count(*) FROM directus_users),
  'team_page_names', (SELECT string_agg(coalesce(first_name, '') || ' ' || coalesce(last_name, ''), ',' ORDER BY id) FROM directus_users WHERE show_on_team_page IS TRUE));"
source_counts="$(echo "$counts" | sql "$database")"
snapshot_counts="$(echo "$counts" | sql "$check")"
echo "source:   $source_counts"
echo "snapshot: $snapshot_counts"
[[ "$source_counts" == "$snapshot_counts" ]] || { echo "Public content differs in the snapshot" >&2; exit 1; }
private="SELECT json_build_object(
  'sessions', (SELECT count(*) FROM directus_sessions),
  'revisions', (SELECT count(*) FROM directus_revisions),
  'real_user_emails', (SELECT count(*) FROM directus_users WHERE email NOT LIKE '%@example.invalid'),
  'passwords', (SELECT count(*) FROM directus_users WHERE password IS NOT NULL));"
private_counts="$(echo "$private" | sql "$check")"
echo "private:  $private_counts"
[[ "$private_counts" == '{"sessions" : 0, "revisions" : 0, "real_user_emails" : 0, "passwords" : 0}' ]] ||
  { echo "Private data remains in the snapshot" >&2; exit 1; }

echo "== Only files referenced by the kept file records are exported"
echo "SELECT filename_disk FROM directus_files WHERE filename_disk IS NOT NULL;" | sql "$check" | sort > "$work/kept.txt"
tar -tf "$work/uploads.tar" | sort > "$work/exported.txt"
comm -13 "$work/kept.txt" "$work/exported.txt" > "$work/unexpected.txt"
[[ ! -s "$work/unexpected.txt" ]] || { cat "$work/unexpected.txt"; echo "Unreferenced files were exported" >&2; exit 1; }
echo "kept file records: $(wc -l < "$work/kept.txt"), exported files: $(wc -l < "$work/exported.txt")"
[[ -z "${1:-}" ]] || cp "$work/snapshot.tar" "$1"
echo "OK"
