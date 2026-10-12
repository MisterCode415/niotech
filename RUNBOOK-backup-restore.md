# Backup and restore runbook

What is protected, where it lives, and how to get it back. Commands assume the working variables
from `COMMANDS.md` (`PREFIX`, `RG`, `VM_USER`, `VM_IP`) plus:

```bash
export PG_NAME=$(az postgres flexible-server list -g "$RG" --query '[0].name' -o tsv)
export SA_NAME=$(az storage account list -g "$RG" --query "[?starts_with(name,'${PREFIX//[^a-z0-9]/}phi')].name | [0]" -o tsv)   # PDFs
export BK_NAME=$(az storage account list -g "$RG" --query "[?starts_with(name,'${PREFIX//[^a-z0-9]/}bak')].name | [0]" -o tsv)   # database dumps
```

Two storage accounts: Azure does not allow a write-once policy on an account with blob
point-in-time restore, so PDFs (restore, versioning) and database dumps (write-once) are separate.

| Data | Protection | Reach back |
|------|-----------|------------|
| Database | Flexible Server automated backups, point-in-time restore (PITR) | 35 days |
| Database | Monthly `pg_dump` in `$BK_NAME/db-backups` (write-once, GRS) | 7 years |
| Lab PDFs | `$SA_NAME/phi-files` container: versioning, soft delete, blob PITR (GRS) | 29 to 30 days |

Nothing here has been run for real until you have done the quarterly restore test below. A backup
you have not restored is a hope, not a backup.

## 1. One-time setup

### 1a. Storage and PDF cutover (dev stack)

1. Provision storage (asks for confirmation, changes nothing destructive):
   ```bash
   ./deploy/azure-storage.sh          # add CMK=1 when building the production stack
   ```
   It prints the three `STORAGE_*` / `AZURE_STORAGE_*` lines for `.env.production`.
2. On the VM, edit `.env.production`: set `STORAGE_DRIVER=azure_blob`, `AZURE_STORAGE_ACCOUNT_URL`,
   and `AZURE_STORAGE_CONTAINER`. Production refuses to boot with `STORAGE_DRIVER=local`, so set
   these **before** deploying this release.
3. Deploy, then copy existing PDFs (the old volume is still mounted for this):
   ```bash
   MIGRATION_DATABASE_URL=<admin url> ./deploy/deploy.sh
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm api pnpm storage:migrate
   ```
   Expect `{"copied":N,"skipped":0,"missingLocally":0,"sizeMismatch":0}`. Re-running is safe. A
   non-zero `missingLocally` or `sizeMismatch` exits with an error: investigate before going on.
4. Spot-check: sign in as a patient with a released result and download the PDF.
5. Keep the old `nio-storage` Docker volume for 30 days, then `docker volume rm nio-prod_nio-storage`.

### 1b. Database retention and monthly dumps

1. Retention: re-running `./deploy/azure-provision.sh` sets the existing server to 35 days. Or:
   ```bash
   az postgres flexible-server update -g "$RG" -n "$PG_NAME" --backup-retention 35
   ```
   Geo-redundant backup and a customer-managed key cannot be added to an existing server. They
   apply to servers created by `azure-provision.sh` from now on (`PG_GEO_BACKUP`, `PG_CMK_*`).
2. Create the read-only dump login (on the VM, with the admin URL):
   ```bash
   BACKUP_DB_PASSWORD="$(openssl rand -hex 32)"
   docker run --rm -i postgres:17-alpine psql "$ADMIN_DATABASE_URL" \
     -v backup_password="$BACKUP_DB_PASSWORD" < deploy/create-backup-db-role.sql
   ```
3. Install the timer (the URL uses `nio_backup`, host and database from the app URL):
   ```bash
   sudo STORAGE_ACCOUNT="$BK_NAME" \
     BACKUP_DATABASE_URL="postgres://nio_backup:${BACKUP_DB_PASSWORD}@HOST:5432/nio?sslmode=require" \
     ./deploy/install-backup-timer.sh
   unset BACKUP_DB_PASSWORD
   ```
4. Take the first dump now and read the log:
   ```bash
   sudo systemctl start nio-db-dump.service && journalctl -u nio-db-dump.service --no-pager | tail
   ```
5. **Lock the write-once policy** (see section 6) once that dump is listed in section 2.

## 2. List what exists

Database point-in-time range and automated backups:

```bash
az postgres flexible-server show -g "$RG" -n "$PG_NAME" \
  --query '{earliestRestore:backup.earliestRestoreDate,retentionDays:backup.backupRetentionDays,geo:backup.geoRedundantBackup}' -o json
az postgres flexible-server backup list -g "$RG" -n "$PG_NAME" -o table
```

Monthly dumps:

```bash
az storage blob list --auth-mode login --account-name "$BK_NAME" --container-name db-backups \
  --query '[].{name:name,bytes:properties.contentLength,tier:properties.blobTier,created:properties.creationTime}' -o table
```

PDFs, including deleted ones and older versions of one file:

```bash
az storage blob list --auth-mode login --account-name "$SA_NAME" --container-name phi-files \
  --include d --query '[?deleted].{name:name,deleted:properties.deletedTime}' -o table
az storage blob list --auth-mode login --account-name "$SA_NAME" --container-name phi-files \
  --include v --prefix "<businessUnitId>/<file>.pdf" -o table
```

(Your IP must be allowed by both storage firewalls: `azure-storage.sh` adds the address it ran from.
Another address: `az storage account network-rule add -g "$RG" --account-name "$SA_NAME" --ip-address <ip>`, and the same for `$BK_NAME`.)

## 3. Restore the database

Every restore creates a **new** server or database. Nothing overwrites production.

### 3a. Point in time (last 35 days)

```bash
az postgres flexible-server restore -g "$RG" -n "${PG_NAME}-restore" --source-server "$PG_NAME" \
  --restore-time "2026-10-10T12:00:00Z" \
  --vnet "${PREFIX}-vnet" --subnet "${PREFIX}-db-subnet" \
  --private-dns-zone "${PG_NAME}.private.postgres.database.azure.com"
```

Pick a time just before the damage, in UTC. If Azure rejects the shared database subnet, create
another delegated subnet in the same VNet and pass it instead.

### 3b. Region loss (geo-restore)

Only for servers created with geo-redundant backup. Needs a VNet and delegated subnet in the
paired region:

```bash
az postgres flexible-server geo-restore -g "$RG" -n "${PG_NAME}-geo" \
  --source-server "$PG_NAME" -l <paired-region> --vnet <vnet> --subnet <subnet>
```

### 3c. From a monthly dump (older than 35 days, or no server to restore from)

1. On the VM, fetch the dump. If its tier is `Archive`, rehydrate first and wait (hours):
   ```bash
   az login --identity --allow-no-subscriptions -o none
   az storage blob set-tier --auth-mode login --account-name "$BK_NAME" --container-name db-backups \
     --name 2026/09/nio-<stamp>.dump --tier Cool --rehydrate-priority Standard
   az storage blob download --auth-mode login --account-name "$BK_NAME" --container-name db-backups \
     --name 2026/09/nio-<stamp>.dump --file /tmp/nio.dump
   ```
2. On a **scratch** database (not production): create it, create the roles, then restore.
   ```bash
   psql "$ADMIN_URL_TO_SCRATCH_SERVER/postgres" -c 'create database nio'
   psql "$ADMIN_URL_TO_SCRATCH_SERVER/nio" -v app_password="$(openssl rand -hex 32)" -f deploy/create-app-db-role.sql
   docker run --rm -i postgres:17-alpine pg_restore --no-owner --dbname "$ADMIN_URL_TO_SCRATCH_SERVER/nio" < /tmp/nio.dump
   ```
3. `shred -u /tmp/nio.dump` when done. The dump is PHI.

### 3d. Cutting production over to a restored server

1. On the restored server, run `deploy/create-app-db-role.sql` (it also re-removes UPDATE/DELETE on
   the append-only audit table) and `deploy/create-backup-db-role.sql`.
2. Update `DATABASE_URL` in `.env.production` with the new host, and `BACKUP_DATABASE_URL` in
   `/etc/nio/backup.env`.
3. `MIGRATION_DATABASE_URL=<new admin url> ./deploy/deploy.sh`, then check `/api/health`.

## 4. Restore lab PDFs

Undelete a deleted PDF (within 30 days):

```bash
az storage blob undelete --auth-mode login --account-name "$SA_NAME" --container-name phi-files --name "<key>"
```

Bring back an earlier version of one PDF (current content is kept as a version):

```bash
az storage blob download --auth-mode login --account-name "$SA_NAME" --container-name phi-files \
  --name "<key>" --version-id "<versionId>" --file /tmp/restore.pdf
az storage blob upload --auth-mode login --account-name "$SA_NAME" --container-name phi-files \
  --name "<key>" --file /tmp/restore.pdf --overwrite true && shred -u /tmp/restore.pdf
```

Roll the whole container back to a moment (within 29 days; use for mass deletion or corruption):

```bash
az storage blob restore -g "$RG" --account-name "$SA_NAME" \
  --time-to-restore "2026-10-10T12:00:00Z" --blob-range phi-files phi-files0
```

(Range end is exclusive and `phi-files0` sorts just after every `phi-files/...` name. Confirm in
the quarterly test that this restores what you expect.)

Region loss: Azure can fail the account over to its paired copy
(`az storage account failover -g "$RG" -n "$SA_NAME"`). Recent writes can be lost and the account
becomes locally redundant afterwards, and Microsoft limits failover for some feature combinations
(versioning, change feed). Check their current rules and treat this as a last resort.

## 5. Quarterly restore test

Record the date and result in your ops log. All scratch resources are deleted afterwards.

- [ ] Section 2: earliest restore time is about 35 days ago, and last month's dump is listed.
- [ ] Restore the database to a scratch server at a time two days ago (3a).
- [ ] On it: `select count(*) from orders;` and `select count(*) from phi_access_events;` are
      plausible against production.
- [ ] Restore last month's dump into a scratch database (3c) and compare the same counts.
- [ ] Upload a throwaway test file with the app's key format, delete it, undelete it (4), and
      confirm the bytes match.
- [ ] Run the container restore command (4) against a scratch account or a time with no activity
      and confirm which blobs it affects.
- [ ] Delete the scratch server and database: `az postgres flexible-server delete -g "$RG" -n "${PG_NAME}-restore" --yes`.

## 6. Locking the write-once policy

Until it is locked, the 7-year policy can be shortened or removed by an administrator. Locking is
**irreversible**: dumps cannot be deleted or overwritten for 2,555 days, and the policy can only be
extended. Do it once, after the first dump listed in section 2 looks right:

```bash
ETAG=$(az storage container immutability-policy show --account-name "$BK_NAME" -g "$RG" \
  --container-name db-backups --query etag -o tsv)
az storage container immutability-policy lock --account-name "$BK_NAME" -g "$RG" \
  --container-name db-backups --if-match "$ETAG"
```

Because dumps cannot be deleted, a bad dump stays for 7 years. Keep the dump script's size and
table-count checks, and do not test with real data you would not want retained.
