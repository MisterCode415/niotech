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

## Not in this pass

- Real payments. `PaymentProvider` has a mock implementation that captures instantly; Stripe drops
  in without touching order logic.
- AI interpretation. `draftInterpretation()` returns a clearly-labelled stub the doctor reviews;
  the draft is stored separately from the clinician's own words.
- SMS notifications, retest scheduling and affiliate programs.
- The marketing page editor takes raw HTML with a live preview rather than a WYSIWYG builder. That
  HTML is rendered unsanitized on the storefront, which is fine while business unit admins are
  trusted operators but should be sanitized before self-serve onboarding.
