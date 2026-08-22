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
  accepted role in it before touching data.
- **Database** — row-level security on all 16 tenant tables. The API opens a transaction, declares
  the tenant with `set_config('app.business_unit_id', ...)`, and Postgres filters from there. Code
  paths that legitimately span tenants (migrations, seeding, platform superadmin, QR token lookup)
  set `app.tenant_scope` to `platform` instead, and that list is deliberately short.

`FORCE ROW LEVEL SECURITY` is set because the application connects as the table owner, who would
otherwise bypass policies.

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
- a transition that skips a step being rejected.

## Deploying

The production stack is three containers behind nginx: the SPA is served as static files, `/api` is
proxied to Fastify, and Postgres and the PHI volume are reachable only from inside the compose
network. Neither the database nor the API publishes a host port.

### Before the first deploy

**This deployment must not be reachable from the open internet.** With `AUTH_PROVIDER=dev` the login
endpoint issues a valid token for any known email with no password, so anyone who can reach the API
can become the platform superadmin. `deploy/allowlist.conf` is what prevents that, and the API
refuses to start in production unless `ALLOW_DEV_AUTH=true` says you accepted the tradeoff. Set
`AUTH_PROVIDER=auth0` to remove the passwordless path entirely.

HTTP basic auth is deliberately *not* used as the gate. The SPA sends `Authorization: Bearer` on
every API call, which replaces the browser's `Authorization: Basic` header, so nginx would reject
every request. An IP allowlist has no such conflict and covers the API as well as the SPA.

### On the server

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone <your-repo> nio-platform && cd nio-platform

cp .env.production.example .env.production
cp deploy/allowlist.conf.example deploy/allowlist.conf

# Fill in .env.production: hostname, and a fresh secret for each value marked replace-me.
openssl rand -base64 48   # DEV_AUTH_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD (also goes in DATABASE_URL)

# Put your own address in the allowlist, or nothing will be reachable.
curl -s https://ifconfig.me

./deploy/deploy.sh     # builds, migrates, creates the platform admin, starts everything
./deploy/certs.sh      # replaces the self-signed placeholder with Let's Encrypt
```

Point the DNS A record at the server and open only 80 and 443:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Then sign in as `PLATFORM_ADMIN_EMAIL` and create the first business unit. Redeploying a change is
`git pull && ./deploy/deploy.sh`.

Renew certificates from cron, since Let's Encrypt certificates last 90 days:

```
0 3 * * 1 cd /path/to/nio-platform && ./deploy/certs.sh >> /var/log/nio-certs.log 2>&1
```

### Configuration that bites

- `WEB_ORIGIN` is stamped into QR stickers and emailed links. If it is wrong, every kit you print
  points somewhere useless — and stickers are already on physical boxes by the time you notice. The
  API refuses to start if it still says localhost.
- `DATABASE_URL` must use the compose service name (`postgres:5432`), not `localhost:5433`.
- `POSTGRES_PASSWORD` only takes effect when the data volume is first created. Changing it later
  does nothing until the volume is recreated.
- The production stack uses its own compose project name (`nio-prod`), so `pnpm db:up` and
  `pnpm db:reset` cannot touch production containers or volumes.

### Email

`SMTP_HOST` should point at a real relay. To inspect notifications instead of delivering them, run
with `--profile mailpit` and set `SMTP_HOST=mailpit`; the UI binds to loopback only, so reach it
over SSH rather than exposing it:

```bash
ssh -L 8025:127.0.0.1:8025 user@server   # then open http://localhost:8025
```

### Backups

Two things hold state and both matter: the Postgres volume and the PHI volume holding uploaded lab
results. Neither is backed up automatically.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T postgres pg_dump -U nio nio | gzip > nio-$(date +%F).sql.gz
docker run --rm -v nio-prod_nio-storage:/data -v "$PWD":/out alpine \
  tar czf /out/nio-storage-$(date +%F).tar.gz -C /data .
```

### Still missing for real production

This is a private test deployment, not a HIPAA-ready one. Before real patient data: replace dev auth
with Auth0, encrypt PHI at rest, add audit log retention and offsite backups, sanitize the marketing
page HTML, and put a real payment provider behind `PaymentProvider`.

## Not in this pass

- Real payments. `PaymentProvider` has a mock implementation that captures instantly; Stripe drops
  in without touching order logic.
- AI interpretation. `draftInterpretation()` returns a clearly-labelled stub the doctor reviews;
  the draft is stored separately from the clinician's own words.
- SMS notifications, retest scheduling and affiliate programs.
- The marketing page editor takes raw HTML with a live preview rather than a WYSIWYG builder. That
  HTML is rendered unsanitized on the storefront, which is fine while business unit admins are
  trusted operators but should be sanitized before self-serve onboarding.
