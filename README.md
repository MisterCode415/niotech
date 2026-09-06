# NIO Tech Platform

A multi-tenant testing and lab workflow platform. A patient buys a package, a fulfillment partner
ships a kit, the patient mails a sample, a lab analyses it, and — depending on the package — a
doctor interprets the result before it reaches the patient.

Several business units run independently on the same infrastructure: each has its own storefront,
packages, fulfillment partner, lab and clinical roster, but they all share the same sequencing,
backend and front end.

## Requirements

- Node 22+
- pnpm 11+
- Docker (for Postgres and Mailpit)

## Getting started

```bash
cp .env.example .env
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres and Mailpit, applies migrations, seeds demo data, then runs the API and
the web app together.

| Service           | URL                     |
| ----------------- | ----------------------- |
| Web app           | http://localhost:5173   |
| API               | http://localhost:4000   |
| Mailpit (email)   | http://localhost:8025   |
| Postgres          | `localhost:5433`        |

Postgres and Mailpit bind to loopback only. Docker otherwise publishes to every interface, which
would expose the database and the full notification inbox on any machine with a public IP.

## Signing in

The local identity provider mints its own tokens, so no Auth0 tenant is needed. Sign in from
http://localhost:5173/login and pick a seeded account. Signing in never creates an account — the
alpha table and each business unit's roster decide who exists.

| Email                       | Role                                |
| --------------------------- | ----------------------------------- |
| `admin@niotech.test`        | Platform superadmin                 |
| `admin@vitality.test`       | Business unit admin (Vitality)      |
| `patient@vitality.test`     | Patient (Vitality)                  |
| `fulfillment@vitality.test` | Fulfillment (Vitality)              |
| `lab@vitality.test`         | Lab (Vitality)                      |
| `doctor@vitality.test`      | Doctor (Vitality)                   |
| `admin@metabolic.test`      | Business unit admin (Metabolic Co)  |

## Walking through the flow

1. **Patient** — from `/vitality`, pick *Metabolic Reset Program*, check out, and pay (simulated).
2. **Fulfillment** — the order appears in the queue. Enter your own order reference, print the QR
   sticker sheet, then mark it shipped with a carrier and tracking number.
3. **Patient** — open the order and confirm the kit arrived, then that the sample was mailed. In
   the real world both happen by scanning the sticker, which lands on `/scan/:token`.
4. **Lab** — check the sample in, upload a results PDF, and mark the analysis complete.
5. **Doctor** — the result is now in the review queue with an AI draft. Approve or reject with an
   explanation.
6. **Patient** — the results and the doctor's interpretation are now on the dashboard.

Ordering *Baseline Metabolic Check* instead skips step 5 entirely: raw results go straight back to
the patient, which is the other branch of the flow.

Every email the platform sends is captured in Mailpit rather than delivered.

## Architecture

```
apps/api        Fastify + Drizzle + Postgres
apps/web        Vite + React SPA
packages/shared Zod contracts, role enums, order state machine
```

### Multi-tenancy

One shared schema. Every tenant-owned table carries `business_unit_id`, and isolation is enforced
twice over:

- **Application** — routes resolve the business unit from the URL and confirm the caller holds an
  accepted role in it. With Auth0, the access token's `org_id` must also exactly match that business
  unit's `auth0_org_id`; database membership alone cannot cross an organization boundary.
- **Database** — row-level security on all 16 tenant tables. The API opens a transaction, declares
  the tenant, authenticated user, and role with transaction-local `set_config(...)` calls, and
  Postgres filters from there. Patient-owned orders and clinical files are restricted to that
  patient; result tables remain hidden until release; billing and notifications have role/owner
  policies. Code paths that legitimately span tenants set `app.tenant_scope` to `platform`, and
  that list is deliberately short.

The long-running API connects as the `nio_app` role, which is both `NOSUPERUSER` and `NOBYPASSRLS`.
The administrator credential exists only in the disposable migration process. `FORCE ROW LEVEL
SECURITY` remains enabled as defense in depth.

### Order state machine

`packages/shared/src/orderStatus.ts` holds the only definition of how an order may progress, as a
map of `from → [{ to, allowed roles }]`. The API refuses any transition not in that table, so no
portal can skip a step, move an order backwards, or act outside its role.

The physical lifecycle lives on **kits** (a package can require several); the order status is
rolled up from them and only advances once every kit has. Each accepted transition writes an
`order_events` row with the actor, both statuses and a message, which is what the timeline views
render.

### Authentication

`AuthProvider` (`apps/api/src/auth/provider.ts`) is the whole surface the app needs from an
identity provider: verify a token, create an organization, invite a user. Two implementations:

- `dev` — signs local HS256 tokens. Default.
- `auth0` — JWKS verification plus the Management API. A business unit maps one-to-one onto an
  Auth0 Organization.

One Auth0 identity can be a member of several Organizations and hold a different application role
in each. Selecting a workspace obtains an organization-scoped token; tenant APIs reject unscoped
tokens and tokens issued for another organization. Switching workspaces performs another Auth0
authorization redirect, normally without another password prompt because the Auth0 session remains
active. Identity rows bind permanently to Auth0's immutable `sub`; email is used only once to bind
an explicitly pre-seeded row and can never replace an existing subject.

Switch with `AUTH_PROVIDER` in `.env`. For Auth0, also set `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`,
`AUTH0_SPA_CLIENT_ID`, `AUTH0_M2M_CLIENT_ID` and `AUTH0_M2M_CLIENT_SECRET`.

The platform superadmin is a manual row in `platform_admins`, seeded from `PLATFORM_ADMIN_EMAIL`.
Nothing in the application can grant that access — it is the root of trust.

### QR codes

`kits.qr_token` is 128 bits of entropy, never a sequential id. The sticker encodes
`/scan/<token>`; the server resolves it, checks the caller's tenant and role, and returns the
actions appropriate to that person at that point in the lifecycle. Fulfillment, the patient and
the lab all scan the same code and get different things to do.

### PHI handling

Result files are written outside the web root (`storage/`, gitignored) behind a driver interface
shaped like an object store, so S3 is a driver swap. They are only ever served through an
authenticated route that re-checks tenant, ownership and whether results have been released — a
patient cannot read their own results while they are still with the doctor.

## Commands

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Database, migrations, seed, API and web             |
| `pnpm test`         | Integration tests against a live database           |
| `pnpm typecheck`    | Typecheck every package                             |
| `pnpm lint`         | ESLint                                              |
| `pnpm db:generate`  | Generate SQL migrations from the Drizzle schema     |
| `pnpm db:migrate`   | Apply migrations                                    |
| `pnpm db:seed`      | Seed demo data (idempotent)                         |
| `pnpm db:reset`     | Drop the volume and rebuild from scratch            |

`pnpm db:seed` refuses to run when `NODE_ENV=production`; it creates demo tenants and fake patient
accounts. Deployments use `db:bootstrap`, which creates only the platform admin.

### Migrations

Schema is authored in TypeScript in `apps/api/src/db/schema.ts`, but the artifact that runs against
Postgres is reviewable SQL in `apps/api/drizzle/`. Change the schema, run `pnpm db:generate`, read
the generated SQL, commit it. Policies and other non-schema DDL go in custom migrations
(`drizzle-kit generate --custom`), like `0001_rls_policies.sql`. Never use `db push` outside local
scratch work.

## Tests

`apps/api/src/test/workflow.test.ts` drives the real API against a real database:

- the clinician branch end to end, asserting the exact 12-step event trail and that the patient
  cannot see results before release;
- the direct-to-patient branch, asserting it never enters the doctor queue;
- tenant isolation across orders, portals, roles and QR scans;
- immutable identity binding, exact Auth0 organization matching, and patient ownership enforced
  directly by PostgreSQL RLS;
- a transition that skips a step being rejected.

## Deploying

The target is a single Ubuntu VM running two containers — nginx serving the built SPA and proxying
`/api` to Fastify — with PostgreSQL as a managed instance on a private network. The API publishes no
host port, and the database has no public endpoint at all.

```
        internet
           │  443 (your IP only)          80 (open, ACME challenges only)
           ▼
   ┌───────────────┐        ┌───────────────────────────────┐
   │ nginx (web)   │──/api──▶│ Fastify (api) + PHI volume    │
   │ static SPA    │        └───────────────┬───────────────┘
   └───────────────┘                        │ private VNet, TLS
                                            ▼
                              PostgreSQL Flexible Server
```

Azure is assumed below because Microsoft signs a HIPAA BAA covering VMs, PostgreSQL Flexible Server
and Blob Storage. Nothing here is Azure-specific except `deploy/azure-provision.sh` — the stack is
plain Docker Compose and runs on any Ubuntu host.

### Before the first deploy

**This deployment must not be reachable from the open internet.** With `AUTH_PROVIDER=dev` the login
endpoint issues a valid token for any known email with no password, so anyone who can reach the API
can become the platform superadmin. `deploy/allowlist.conf` is what prevents that, and the API
refuses to start in production unless `ALLOW_DEV_AUTH=true` says you accepted the tradeoff. Set
`AUTH_PROVIDER=auth0` to remove the passwordless path entirely.

HTTP basic auth is deliberately *not* used as the gate. The SPA sends `Authorization: Bearer` on
every API call, which replaces the browser's `Authorization: Basic` header, so nginx would reject
every request. An IP allowlist has no such conflict and covers the API as well as the SPA.

### Provisioning Azure

`deploy/azure-provision.sh` creates everything: resource group, VNet with an app subnet and a
delegated database subnet, an NSG, the VM, and a private Flexible Server. It is re-runnable — each
step is skipped if the resource already exists — and it prints the connection string when done.

```bash
az login
ADMIN_CIDR=203.0.113.42/32 ./deploy/azure-provision.sh
```

| Resource | Default | Override with |
| --- | --- | --- |
| VM | `Standard_B2s`, Ubuntu 24.04, 64 GiB | `VM_SIZE`, `OS_DISK_GB` |
| Database | Flexible Server Burstable `Standard_B1ms`, 32 GiB, v17 | `PG_SKU`, `PG_STORAGE_GB`, `PG_VERSION` |
| Location | `eastus` | `LOCATION` |
| Names | prefixed `nio-` | `PREFIX` |

#### When a region refuses to cooperate

Azure gates subscriptions out of high-demand regions independently of quota, and newer
subscriptions are gated hard. The script checks before building anything, because the failures are
otherwise slow and wear several disguises: `location is restricted`, a bare `SkuNotAvailable`, or a
baffling `Version should be in: []`.

A region is only usable if it offers **both** a Flexible Server and a VM size — the server is
privately networked, so it must share a region with the VM it serves. `westus3` has been seen
offering the database while having no available 2-vCPU VM at all. When the preflight rejects a
region it probes the alternatives and lists the ones that pass both checks.

A region can also pass the preflight and still fail with `InternalServerError` on creation.
Retrying the same region tends to fail identically; move to another one. The cleanest retry is a
fresh resource group, which deletes nothing and leaves the failed attempt to be cleaned up in one
command afterwards:

```bash
PREFIX=nio2 LOCATION=westcentralus ADMIN_CIDR=203.0.113.42/32 ./deploy/azure-provision.sh
az group delete -n nio-rg --yes     # once the new stack is verified
```

Changing `PREFIX` changes the resource group name, so the prefix is recorded in
`deploy/.azure-secrets` and `azure-email.sh` reads it back rather than assuming `nio-`.

If every candidate region is restricted, either set `BUNDLED_DB=true` (page below) to run
PostgreSQL on the VM and skip Flexible Server entirely, or raise an Azure support request under
"Service and subscription limits".

The VM is built from `deploy/cloud-init.yaml`, which installs Docker, enables `ufw`, and adds 2GB of
swap — the web image build runs `tsc` plus Vite and wants roughly 2GB, which is uncomfortably close
to a 4GB VM's limit without it.

### On the server

```bash
git clone <your-repo> nio-platform && cd nio-platform

cp .env.production.example .env.production
cp deploy/allowlist.conf.example deploy/allowlist.conf

# Keep the administrator URL printed by provisioning out of .env.production. Create the restricted
# runtime login with a URL-safe password, then put its nio_app URL in .env.production.
export ADMIN_DATABASE_URL='postgres://nioadmin:...@.../nio?sslmode=require'
export APP_DATABASE_PASSWORD="$(openssl rand -hex 32)"
docker run --rm -i postgres:17-alpine psql "$ADMIN_DATABASE_URL" \
  -v app_password="$APP_DATABASE_PASSWORD" < deploy/create-app-db-role.sql

# Fill in .env.production: hostname, the nio_app DATABASE_URL, and a fresh secret for each value
# marked replace-me. Keep APP_DATABASE_PASSWORD somewhere secure.
openssl rand -base64 48   # DEV_AUTH_SECRET

# Put your own address in the allowlist, or nothing will be reachable.
curl -s https://ifconfig.me

MIGRATION_DATABASE_URL="$ADMIN_DATABASE_URL" ./deploy/deploy.sh
./deploy/certs.sh      # replaces the self-signed placeholder with Let's Encrypt
```

Point the DNS A record at the VM's public IP first, or certificate issuance will fail.

Then sign in as `PLATFORM_ADMIN_EMAIL` and create the first business unit. Redeploying a change is
`git pull && MIGRATION_DATABASE_URL="$ADMIN_DATABASE_URL" ./deploy/deploy.sh`. The administrator URL
is passed only to the disposable migration container; the running API receives only the restricted
`nio_app` credential and therefore cannot bypass row-level security.

### Why port 80 is open to everyone

The NSG restricts 443 and 22 to your address but leaves 80 open. That is deliberate: Let's Encrypt
has to reach port 80 to validate on every renewal, and the alternative is widening a firewall rule
on a schedule, which eventually gets forgotten in the open position. It is safe because the nginx
server block on port 80 contains only the ACME challenge location and a redirect to HTTPS — no
application content and no API routes are reachable there. The IP allowlist lives in the 443 block.

### Running PostgreSQL on the VM instead

Set `BUNDLED_DB=true` in `.env.production`, point `DATABASE_URL` at `postgres:5432`, and set
`POSTGRES_PASSWORD`. `deploy.sh` then adds `docker-compose.bundled-db.yml`, which runs Postgres as a
container with no published port. Cheaper, one less moving part, and backups become entirely your
problem — the managed instance is recommended mainly because it does point-in-time restore for you.

Renew certificates from cron, since Let's Encrypt certificates last 90 days:

```
0 3 * * 1 cd /path/to/nio-platform && ./deploy/certs.sh >> /var/log/nio-certs.log 2>&1
```

### Configuration that bites

- **Flexible Server private access cannot be enabled after creation.** A public-access server has to
  be rebuilt to move it into a VNet, so choose private at creation time. The provisioning script
  does.
- `WEB_ORIGIN` is stamped into QR stickers and emailed links. If it is wrong, every kit you print
  points somewhere useless — and stickers are already on physical boxes by the time you notice. The
  API refuses to start if it still says localhost.
- `DATABASE_URL` needs `?sslmode=require` for any remote host. The API refuses to start without it,
  because PHI would otherwise cross the network in clear text. Hosts that never leave the machine
  (`localhost`, the `postgres` compose service) are exempt.
- `POSTGRES_PASSWORD` only takes effect when the data volume is first created, and only applies to
  the bundled-database setup. Changing it later does nothing until the volume is recreated.
- The production stack uses its own compose project name (`nio-prod`), so `pnpm db:up` and
  `pnpm db:reset` cannot touch production containers or volumes.

### Email

Nothing in `azure-provision.sh` creates a mail service — outbound email needs a relay you sign up
for separately. Three constraints shape the choice:

- Azure blocks outbound port **25** from VMs entirely, so the relay must accept **587**.
- The connection carries a password and patient-identifying subject lines, so TLS is mandatory.
  `requireTLS` is set for any non-local host, which means the send *fails* rather than silently
  falling back to plaintext.
- `SMTP_FROM` must be an address the relay has verified, or it will reject every message.

**Azure Communication Services** keeps mail inside the BAA boundary. `deploy/azure-email.sh`
provisions all of it and prints the settings to paste into `.env.production`:

```bash
./deploy/azure-email.sh
```

It creates an Email Communication Service with an Azure-managed domain (verified instantly, no DNS
records), a Communication Services resource with that domain linked, and an Entra application whose
client secret becomes the SMTP password. ACS authenticates SMTP against an Entra app rather than a
plain password, which is why the app exists at all.

Two things about that setup are easy to get wrong by hand. The role assignment must be scoped to the
**Communication Services resource itself** — granting it on the resource group, the subscription, or
the Email Communication Service silently fails to authenticate. And the SMTP username is a named
resource you create, not a derived string; the older `<acs>|<app-id>|<tenant-id>` form still works
but runs past 90 characters. The script does both correctly.

Azure-managed domains are rate limited, meant for testing, and their sender address is fixed at
`donotreply@<guid>.azurecomm.net`. For a real sender you need a custom domain
(`--domain-management CustomerManaged`) and its SPF and DKIM records published. New Communication
Services resources also start with a low sending quota that needs a support request to raise.

**SendGrid** is the quicker path if BAA coverage is not yet a concern — create an API key and use
`smtp.sendgrid.net` with `SMTP_USER=apikey` and the key as `SMTP_PASS`.

To inspect notifications instead of delivering them, run with `--profile mailpit` and set
`SMTP_HOST=mailpit`. The UI binds to loopback only, so reach it over SSH rather than exposing it:

```bash
ssh -L 8025:127.0.0.1:8025 user@server   # then open http://localhost:8025
```

Email failures never block a clinical transition — a result is recorded whether or not the mail
server is reachable, and the in-app notification lands regardless. That makes a broken relay quiet,
so the API logs a warning at startup when a remote relay has no credentials configured.

### Backups

Two things hold state. Flexible Server backs up the database itself with 7-day point-in-time
restore, so the gap is **the PHI volume holding uploaded lab results**, which nothing backs up:

```bash
docker run --rm -v nio-prod_nio-storage:/data -v "$PWD":/out alpine \
  tar czf /out/nio-storage-$(date +%F).tar.gz -C /data .
```

With `BUNDLED_DB=true` the database is your responsibility too:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.bundled-db.yml \
  --env-file .env.production exec -T postgres pg_dump -U nio nio | gzip > nio-$(date +%F).sql.gz
```

A backup you have never restored is a hypothesis, not a backup. Restore one into a scratch database
before you rely on it.

### Still missing for real production

This is a private test deployment, not a HIPAA-ready one. Azure signing a BAA covers the
infrastructure; it says nothing about how this application is configured. Before real patient data:
replace dev auth with Auth0, encrypt PHI at rest with a customer-managed key, add audit log
retention and offsite backups, confirm no PHI reaches application logs, sanitize the marketing page
HTML, and put a real payment provider behind `PaymentProvider`.

## Not in this pass

- Real payments. `PaymentProvider` has a mock implementation that captures instantly; Stripe drops
  in without touching order logic.
- AI interpretation. `draftInterpretation()` returns a clearly-labelled stub the doctor reviews;
  the draft is stored separately from the clinician's own words.
- SMS notifications, retest scheduling and affiliate programs.
- The marketing page editor takes raw HTML with a live preview rather than a WYSIWYG builder. That
  HTML is rendered unsanitized on the storefront, which is fine while business unit admins are
  trusted operators but should be sanitized before self-serve onboarding.
