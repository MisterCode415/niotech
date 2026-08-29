\set ON_ERROR_STOP on

\if :{?app_password}
\else
  \echo 'error: pass the application password with -v app_password=...'
  \quit
\endif

-- Run this as the database administrator after migrations. The API must use this login instead of
-- the owner/admin login: PostgreSQL superusers and BYPASSRLS roles ignore row-level security even
-- when a table uses FORCE ROW LEVEL SECURITY.
SELECT format(
  'CREATE ROLE nio_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nio_app')
\gexec

-- Re-running the bootstrap rotates the password and repairs any privilege flags that drifted.
SELECT format(
  'ALTER ROLE nio_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_password'
)
\gexec

ALTER ROLE nio_app SET row_security = on;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE nio TO nio_app;
GRANT USAGE ON SCHEMA public TO nio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nio_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nio_app;

-- These defaults apply to objects created by the administrator running this file. Run this file as
-- the same role used for Drizzle migrations so future tables, sequences, and functions remain
-- available to the runtime role without granting it DDL privileges.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nio_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nio_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO nio_app;
