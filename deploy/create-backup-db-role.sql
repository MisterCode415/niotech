\set ON_ERROR_STOP on

\if :{?backup_password}
\else
  \echo 'error: pass the backup password with -v backup_password=...'
  \quit
\endif

-- Creates the login used only by deploy/db-dump.sh. Run as the database administrator, with the
-- same role used for Drizzle migrations, after create-app-db-role.sql:
--
--   psql "<admin url>" -v backup_password="$(openssl rand -hex 24)" -f deploy/create-backup-db-role.sql
--
-- A dump taken as nio_app would be empty: every PHI table uses row-level security, which hides
-- all rows from a role with no tenant context. nio_backup therefore has BYPASSRLS, and compensates
-- by being read-only (SELECT only, no INSERT/UPDATE/DELETE/DDL) and by never being given to the API.
-- Its connection URL belongs in /etc/nio/backup.env on the VM (root-only), never in .env.production.
SELECT format(
  'CREATE ROLE nio_backup LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'backup_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nio_backup')
\gexec

-- Re-running rotates the password and repairs drifted flags.
SELECT format(
  'ALTER ROLE nio_backup WITH LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'backup_password'
)
\gexec

ALTER ROLE nio_backup SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE nio TO nio_backup;
GRANT USAGE ON SCHEMA public TO nio_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nio_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO nio_backup;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nio_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO nio_backup;
