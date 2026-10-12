#!/usr/bin/env bash
# Take a full logical dump of the database and store it in the write-once db-backups container.
# Run on the application VM (by the monthly timer, or by hand with sudo). It prints sizes and the
# blob name only; the dump itself is never printed and the local copy is deleted afterwards.
#
# Reads /etc/nio/backup.env (root-only, mode 600):
#   BACKUP_DATABASE_URL=postgres://nio_backup:...@<server>:5432/nio?sslmode=require
#   STORAGE_ACCOUNT=<account name from deploy/azure-storage.sh>
#   BACKUP_CONTAINER=db-backups
#
# Authentication to storage is the VM's managed identity (no keys).
set -euo pipefail
umask 077

CONFIG="${BACKUP_ENV_FILE:-/etc/nio/backup.env}"
fail() { echo "error: $*" >&2; exit 1; }

[[ -r "$CONFIG" ]] || fail "cannot read $CONFIG (run deploy/install-backup-timer.sh first)"
# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a
: "${BACKUP_DATABASE_URL:?missing in $CONFIG}"
: "${STORAGE_ACCOUNT:?missing in $CONFIG}"
BACKUP_CONTAINER="${BACKUP_CONTAINER:-db-backups}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"

command -v docker >/dev/null || fail "docker is not installed"
command -v az >/dev/null || fail "the Azure CLI is not installed (run deploy/install-backup-timer.sh)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BLOB="$(date -u +%Y/%m)/nio-${STAMP}.dump"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILE="$WORK/nio.dump"

echo "==> Dumping database"
# The URL travels as an environment variable so it never appears in the process list.
docker run --rm -e BACKUP_DATABASE_URL "$PG_IMAGE" \
  sh -c 'pg_dump --format=custom --no-owner --dbname "$BACKUP_DATABASE_URL"' > "$FILE"

SIZE="$(stat -c %s "$FILE")"
[[ "$SIZE" -gt 1024 ]] || fail "dump is suspiciously small ($SIZE bytes); not uploading"

echo "==> Checking the dump is readable"
TABLES="$(docker run --rm -i "$PG_IMAGE" pg_restore --list < "$FILE" | grep -c ' TABLE DATA ' || true)"
[[ "$TABLES" -gt 0 ]] || fail "dump has no table data entries; not uploading"
echo "    $TABLES tables with data, $SIZE bytes"

echo "==> Uploading to ${STORAGE_ACCOUNT}/${BACKUP_CONTAINER}/${BLOB}"
az login --identity --allow-no-subscriptions -o none
# No --overwrite: the container is write-once, and an existing name must never be replaced.
az storage blob upload --auth-mode login \
  --account-name "$STORAGE_ACCOUNT" --container-name "$BACKUP_CONTAINER" \
  --name "$BLOB" --file "$FILE" --overwrite false --only-show-errors -o none

REMOTE_SIZE="$(az storage blob show --auth-mode login \
  --account-name "$STORAGE_ACCOUNT" --container-name "$BACKUP_CONTAINER" \
  --name "$BLOB" --query properties.contentLength -o tsv)"
[[ "$REMOTE_SIZE" == "$SIZE" ]] || fail "uploaded size $REMOTE_SIZE does not match local size $SIZE"

echo "==> Done: ${BACKUP_CONTAINER}/${BLOB} (${SIZE} bytes)"
