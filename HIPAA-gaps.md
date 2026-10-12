# HIPAA gaps and architecture inventory

This is an engineering inventory, not a legal opinion or a BAA. Azure (or any vendor)
signing a Business Associate Agreement covers their infrastructure. It does not make
this application HIPAA-compliant. Use this file to sequence work toward a posture
that can be assessed.

Last updated: 2026-10-12.

## What HIPAA is asking of the application

At a high level, a covered entity / BA handling ePHI needs:

- **Access control** — unique users, least privilege, emergency access, automatic logoff
- **Audit controls** — record who accessed which PHI, and retain those records
- **Integrity** — PHI is not improperly altered or destroyed
- **Transmission security** — PHI in transit is encrypted
- **Encryption at rest** — addressable; expected in practice for lab PDFs and chat logs
- **Minimum necessary** — do not expose more PHI than a role needs
- **BAAs** — every vendor that can see PHI (hosting, email, LLM, payments if they store PHI)
- **Breach notification, retention, workforce training** — operational, not code

## What we already do (compliant-leaning)

| Pattern | Where | Why it helps |
|---------|--------|--------------|
| Tenant isolation in the app | `requireMembership()` in `apps/api/src/auth/context.ts` | Cross-tenant reads fail before SQL |
| Tenant + role + ownership RLS | `apps/api/drizzle/0001_rls_policies.sql`, `0003_actor_context_rls.sql` | Defense in depth if an app bug forgets a WHERE |
| App DB role cannot bypass RLS | `deploy/create-app-db-role.sql` (`nio_app` + `NOBYPASSRLS`) | Migrations use a privileged URL; the API pool cannot |
| Patient results gated until release | RLS on `lab_results` / `files` / `clinician_reviews`; patient routes in `patient.ts` | Patients cannot download a PDF in `lab_complete` or `awaiting_clinician_review` |
| PHI bytes off the web root | `apps/api/src/services/storage.ts` | Files are only served through authenticated, tenant-checked routes |
| Append-only workflow audit | `order_events` | Status changes record actor, role, from/to, message |
| Platform act-as is stamped | `orderWorkflow.ts` metadata `actingAsPlatformAdmin` | Super-admin impersonation is visible on the timeline |
| Auth0 org scoping + email verification | `auth0Provider.ts`, post-login Action | Tokens from another org cannot be reused against a BU |
| Production boot refusals | `assertDeployableConfig()` in `env.ts` | Refuses `AUTH_PROVIDER=dev`, default DB passwords, remote DB without `sslmode`, localhost `WEB_ORIGIN`, placeholder SMTP |
| Remote DB must use TLS | `env.ts` `databaseIsRemote` | PHI must not cross the network in clear text |
| SMTP TLS for non-local relays | `notifications.ts` `requireTLS` | Patient-identifying subject lines do not fall back to plaintext |
| Rate limiting | Fastify plugin in `app.ts` | Slows credential stuffing and scan abuse |
| 5xx bodies do not leak stacks | `app.ts` error handler | Reduces accidental PHI / internals in client responses |
| BAA guidance for Azure / ACS vs SendGrid | `README.md` | ACS stays inside an Azure BAA; SendGrid is documented as the quicker, uncovered path |

## Gaps

Numbered so remediations can refer back. Severity is operational, not legal.

### 1. No encryption at rest / CMK on the PHI volume

Lab PDFs live as plaintext files under `STORAGE_LOCAL_PATH` (default `./storage`). The
interface is shaped for an object-store driver, but only `local` exists. Database
columns that will hold extracted report text and patient–AI conversations are also
plaintext Postgres.

**Risk:** disk snapshot, volume theft, or a host-level compromise exposes every report.

### 2. No dedicated PHI access audit

`order_events` records status transitions, not “who opened which PDF / extraction /
conversation, when, from where.” There is no retention policy or export for access
logs.

**Risk:** cannot answer an accounting-of-disclosures request or investigate a snooping
clinician / fulfillment user.

### 3. MFA and idle session timeout are not enforced in-app

Production auth is Auth0-delegated. MFA and absolute/idle session limits are tenant
policy, not codified here. Dev auth issues long-lived JWTs stored in `localStorage`.

**Risk:** a shared workstation or stolen laptop stays signed in; MFA can be turned off
in the Auth0 tenant without the app noticing.

### 4. Dev auth and `localStorage` tokens

`AUTH_PROVIDER=dev` mints tokens for any known email with no password. The SPA stores
the access token in `localStorage` (`nio.accessToken`). XSS on the marketing HTML
(gap 7) can exfiltrate it.

**Risk:** acceptable only on throwaway local/dev. Fatal if a production deploy ever
boots with `AUTH_PROVIDER=dev` (boot guard exists; do not weaken it).

### 5. Log hygiene

Notification failures log the recipient email. Invitation sends log message ids.
`payment_events.payload` stores the full Stripe event JSON (PII, not usually clinical
PHI, but still regulated in combination). Mailpit in dev displays patient names and
order numbers. Application logs are not scrubbed against a PHI denylist.

**Risk:** ops tools, log drains, and support screenshots become a second PHI store
without a BAA or retention control.

### 6. Offsite PHI backups and retention

Azure Flexible Server has 7-day PITR for the database. The PHI file volume is not
backed up by the provisioner. There is no documented retention / destruction schedule
for `order_events`, notifications, payment payloads, or (new) chat logs.

**Risk:** ransomware or disk loss loses lab PDFs; over-retention of chat logs expands
breach scope.

### 7. Unsanitized marketing HTML

BU admins can publish raw HTML that the storefront renders as-is. Trusted operators
only, for now.

**Risk:** stored XSS → token theft (gap 4) → PHI via the patient API.

### 8. New with patient report AI

These land when Phase 4 of the current work ships. Treat them as **open gaps from
day one of the feature**, not as later surprises.

| Gap | Detail |
|-----|--------|
| Third-party LLM BAA | Chat sends extracted report text and the patient’s question to whatever URL is configured. OpenAI / Anthropic / a random gateway is a BA only if a BAA is in place. Do not enable production PHI chat without one. |
| Extracted text and conversations are PHI | `file_extractions.extracted_text`, `report_messages.content`, and clinician interpretation copied into the prompt are ePHI at rest. |
| API keys in the database | Provider keys are encrypted with `APP_ENCRYPTION_KEY`, but that key must be managed like a secret, rotated, and never logged. |
| Prompt / response logging | Application logs must not print user questions, report text, or model replies. Token counts and provider ids are enough. |
| Client round-trip of extraction | The extract endpoint returns text to the browser (product request). The chat endpoint **reloads from the DB cache** and ignores client-supplied report text so a tampered browser cannot inject a fake report. The extract response is still PHI in the browser. |
| Minimum necessary to the model | The full PDF text is sent, not a redacted subset. That is convenient and not minimum-necessary. |

### 9. Other known gaps (lower urgency, still real)

- Patient order detail API can include `aiDraft` after release; the UI hides it, the API does not strip it.
- Stripe Dashboard / webhook payloads may contain patient email and shipping address.
- Integrations API (`INTEGRATION_API_SECRET`) can create orders server-to-server — treat that secret as production-grade.
- No automatic logoff in the SPA.
- No emergency-access (“break-glass”) procedure documented.

## Recommended sequence

Do these in order. Later items assume earlier ones exist so PHI is not copied into a
new store we cannot audit.

1. **Access audit + log hygiene** — append-only `phi_access_events` (actor, role, resource type/id, action, request id, timestamp). Scrub emails and payloads from application logs. Strip `aiDraft` from the patient API. Do this before any production PHI chat.
2. **Encryption at rest** — CMK (or platform-managed key with rotation) on the PHI volume; encrypted Postgres (Flexible Server + customer key if required); keep `APP_ENCRYPTION_KEY` in the secret store, not the repo.
3. **Session / MFA policy** — require Auth0 MFA for `bu_admin`, `doctor`, `lab`, `fulfillment`, and platform admins. Idle timeout + absolute session lifetime. Remove `localStorage` tokens when Auth0 is the only provider.
4. **Backups and retention** — offsite encrypted backup of the PHI volume; tested restore; retention/destruction for chat, extractions, notifications, and payment events.
5. **Sanitize marketing HTML** — allowlist tags before self-serve onboarding.
6. **LLM BAAs before production PHI chat** — do not point the cascade at a vendor without a BAA. Prefer a self-hosted or BAA-covered endpoint. Document which provider rows are approved. Keep the feature dark (no enabled providers) until this is signed.
7. **Operational** — workforce training, incident runbook, accounting-of-disclosures export from `phi_access_events` + `order_events` + `report_conversations`.

## Current-pass choices that limit (not close) AI gaps

The report-discussion agent is designed so it does not make gaps 1–8 worse than they
have to be:

- Chat is available only after `results_released`, same gate as the PDF.
- Platform rails are injected last and never sent to the browser.
- Deterministic hijack checks run before any model call.
- A yes/no relevance check rejects off-topic prompts so tokens (and PHI) are not spent on chat.
- The server seeds report context from `file_extractions`, not from the client body.
- Conversations are audit rows in the tenant database; there is no extra admin chat browser.
- Token spend is stored as counts and estimated cost, not as raw prompts in a metrics system.
- SMTP is skipped for `isMock` orders so simulation traffic does not leak into a real inbox.

None of that replaces a BAA, CMK, or an access-audit table.
