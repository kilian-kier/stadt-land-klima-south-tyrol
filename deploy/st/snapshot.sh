#!/usr/bin/env bash
# Anonymized copy of a running stack's data for a staging environment (docs/st/STAGING.md).
#
#   snapshot.sh <database container> <database> <uploads volume> <work directory>  > snapshot.tar
#
# Writes a tar stream with manifest.json, database.dump (pg_dump -Fc) and uploads.tar to stdout;
# logs go to stderr. The source database is only read: its dump is restored into a temporary
# database, anonymized there (anonymize-snapshot.mts) and verified fail-closed before anything
# is written. Installed root-owned in /usr/local/libexec/slk-st and called by deploy-command;
# CI runs it against the test stack (bin/test_suite/src/st/snapshot-anonymization.sh).
set -Eeuo pipefail
trap 'slk_status=$?; echo "${BASH_SOURCE[0]##*/}: line $LINENO: \"$BASH_COMMAND\" failed with status $slk_status" >&2' ERR
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/st/lib.sh
source "$here/lib.sh"

(($# == 4)) || die "Usage: snapshot.sh <database container> <database> <uploads volume> <work directory>" 2
db="$1" database="$2" uploads="$3" parent="$4"
temp=slk_st_snapshot
sql="$here/anonymize-snapshot.mts"
[[ "$db" =~ ^[0-9a-f]{12,64}$ ]] || die "Expected a database container ID" 2
[[ "$database" =~ ^[A-Za-z0-9_]{1,63}$ && "$database" != "$temp" ]] || die "Unexpected database name" 2
[[ "$uploads" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Unexpected uploads volume name" 2
[[ -d "$parent" ]] || die "Missing work directory $parent" 2
exec 3>&1 1>&2

# A shell command in the database container with its private settings, like
# bin/cli/release-backup.ts; $1 is the source and $2 the temporary database name.
in_db() {
  pm exec -i "$db" sh -ec 'if command -v slk-env >/dev/null 2>&1; then exec slk-env sh -ec "$1" st-snapshot "$2" "$3"; fi; exec sh -ec "$1" st-snapshot "$2" "$3"' \
    st-snapshot "$1" "$database" "$temp"
}
drop_temp() { in_db 'exec psql -X -q -U "${POSTGRES_USER:?}" -d postgres -c "DROP DATABASE IF EXISTS \"$2\""' > /dev/null 2>&1 || true; }
work="$(mktemp -d "$parent/snapshot.XXXXXX")"
trap 'drop_temp; rm -rf "$work"' EXIT

log "Dumping the database $database"
in_db 'exec pg_dump -U "${POSTGRES_USER:?}" -d "$1" -Fc' > "$work/source.dump" || die "Dumping $database failed"
log "Restoring it into the temporary database $temp"
drop_temp
in_db 'exec psql -X -q -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:?}" -d postgres -c "CREATE DATABASE \"$2\" TEMPLATE template0"' ||
  die "Creating the temporary database failed"
in_db 'exec pg_restore -U "${POSTGRES_USER:?}" -d "$2" --no-owner --no-acl --exit-on-error' < "$work/source.dump" ||
  die "Restoring into the temporary database failed"
rm -f "$work/source.dump"

log "Anonymizing"
node "$sql" anonymize | in_db 'exec psql -X -q -U "${POSTGRES_USER:?}" -d "$2" -f -' > /dev/null ||
  die "Anonymizing failed; no snapshot was produced"
log "Verifying that no personal data remains"
node "$sql" verify | in_db 'exec psql -X -q -U "${POSTGRES_USER:?}" -d "$2" -f -' > "$work/verify.log" 2>&1 ||
  { cat "$work/verify.log" >&2; die "The verification could not run; no snapshot was produced"; }
if grep -q 'VIOLATION' "$work/verify.log"; then
  grep 'VIOLATION' "$work/verify.log" | sed 's/^.*NOTICE: *//' >&2
  die "Personal data remains after anonymizing; no snapshot was produced"
fi

log "Exporting the anonymized database and the files public content uses"
in_db 'exec pg_dump -U "${POSTGRES_USER:?}" -d "$2" --no-owner --no-acl -Fc' > "$work/database.dump" ||
  die "Dumping the anonymized database failed"
node "$sql" files | in_db 'exec psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:?}" -d "$2" -f -' > "$work/files.txt" ||
  die "Listing the kept files failed"
# Only plain file names from the database, so no entry can reach outside the volume.
grep -E '^[A-Za-z0-9._-]+$' "$work/files.txt" > "$work/files.list" || true
image="$(pm container inspect --format '{{.Image}}' "$db")"
# GNU tar in the database image; an empty list gives a valid empty archive.
pm run --rm --network none -i -v "$uploads:/uploads:ro" --entrypoint sh "$image" \
  -ec 'cd /uploads; while IFS= read -r f; do if [ -f "$f" ]; then printf "%s\n" "$f"; fi; done | tar -cf - --no-recursion -T -' \
  < "$work/files.list" > "$work/uploads.tar" || die "Exporting the kept files failed"
files="$(tar -tf "$work/uploads.tar" | wc -l | tr -d ' ')"
printf '{"created":"%s","files":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$files" > "$work/manifest.json"
tar -C "$work" -cf - manifest.json database.dump uploads.tar >&3
log "RESULT: anonymized snapshot with $files of $(wc -l < "$work/files.list" | tr -d ' ') referenced files"
