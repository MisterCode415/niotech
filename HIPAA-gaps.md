# HIPAA gaps and architecture inventory

This is an engineering inventory, not a legal opinion or a BAA. Azure (or any vendor)
signing a Business Associate Agreement covers their infrastructure. It does not make
this application HIPAA-compliant. Use this file to sequence work toward a posture
that can be assessed.

Last updated: 2026-10-12 (steps 1 and 2 of the code work: access audit, log hygiene, `aiDraft` strip, provider approval gate; then marketing HTML sanitizing, idle logout, per-tab tokens, opt-in staff MFA, and the disclosures export).

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
| Append-only PHI access audit | `phi_access_events` (`0012_phi_access.sql`), `services/phiAudit.ts` | Patient order view (released only), result PDF, extracted text, and report chat; doctor review and result PDF; lab order view. Written in the same transaction as the read, so a failed audit write fails the read. Stores ids, role, act-as flag, request id, and IP, never report text. UPDATE/DELETE blocked by trigger and revoked from `nio_app`; only `bu_admin` and platform scope can read |
| Request ids and redacted logs | `genReqId` + pino `redact`/`req` serializer in `app.ts`, `lib/logSafe.ts` | UUID request ids are echoed as `x-request-id` and tie log lines to audit rows. Auth/cookie/integration/Stripe headers and `*.email` are redacted, URLs log as route patterns, and production error logs carry only error name/code/status |
| Patient API omits `aiDraft` / `aiModel` | `routes/patient.ts` | The model's draft is the clinician's working note and is no longer in the patient payload |
| PHI-approved LLM providers only in production | `phi_approved` on `platform_llm_providers`, `eligibleProviderRows()` in `reportChat.ts`, Platform AI page | With `NODE_ENV=production`, chat skips every provider a platform admin has not marked as BAA-covered (with a reference note). With none approved, chat reports as not configured and no PHI leaves the system |
| Marketing HTML is sanitized on write and on read | `lib/sanitizeHtml.ts`, used by `routes/businessUnit.ts` and `routes/public.ts` | An allowlist drops scripts, iframes, forms, event handlers, and `javascript:` links. `<style>` is kept but CSS is scrubbed of `@import`, `expression()`, and non-https `url()`. Old pages are cleaned when served, so nothing stored earlier reaches a browser unfiltered. The admin preview shows the server-cleaned copy |
| Idle logout in the SPA | `apps/web/src/lib/idleLogout.ts`, mounted in `Layout.tsx` | Signs out after 15 idle minutes (`VITE_IDLE_TIMEOUT_MINUTES`) with a 60-second warning. Activity is shared across tabs, so one busy tab keeps the others alive |
| Tokens are per tab, not persistent | `apps/web/src/lib/api.ts` | The dev token lives in `sessionStorage`, and any older `localStorage` token is deleted at load. Dev tokens now last 8 hours instead of 12 |
| Staff MFA, opt-in | `assertStaffMfa()` in `auth/context.ts`, `deploy/auth0-post-login-action.js`, `auth.tsx`, `deploy/auth0-hardening.sh` | With `REQUIRE_STAFF_MFA=true`, an Auth0 session without MFA gets `403 MFA_REQUIRED` for `bu_admin`, `doctor`, `lab`, `fulfillment`, and platform admin (including act-as). The SPA then sends the user through login asking for MFA, and the Action enrolls or challenges. Patients and the dev provider are never blocked. Default is off so deploying the code cannot lock anyone out |
| Accounting of disclosures export | `routes/audit.ts`, `AdminAudit.tsx` (`/w/:slug/admin/audit`) | A `bu_admin` can look up a patient email or order and get a time-ordered timeline merged from `phi_access_events`, `order_events`, and `report_conversations`, as JSON or CSV. CSV cells that start with a formula character are neutralised. Every lookup and export is itself recorded (`disclosure_export`) in the same transaction |

## Gaps

Numbered so remediations can refer back. Severity is operational, not legal.

### 1. No encryption at rest / CMK on the PHI volume

Lab PDFs live as plaintext files under `STORAGE_LOCAL_PATH` (default `./storage`). The
interface is shaped for an object-store driver, but only `local` exists. Database
columns that will hold extracted report text and patient–AI conversations are also
plaintext Postgres.

**Risk:** disk snapshot, volume theft, or a host-level compromise exposes every report.

### 2. PHI access audit: partly addressed

**Done:** `phi_access_events` records who opened which order, PDF, extraction, or
conversation, when, and from which request id and IP (see the table above).

**Still open:**

- No retention policy. The accounting-of-disclosures export now exists for `bu_admin`
  (per patient or order, capped at 5,000 rows per source). There is no platform-wide export
  and no export across several patients.
- Fulfillment users do not read PHI today, but the list and queue endpoints that return
  patient names (`doctor/queue`, `lab/queue`, `bu_admin` order list) are not audited.
- The audit write is a plain insert; there is no tamper-evident chaining or off-box copy, so a
  database administrator can still drop the trigger.

**Risk:** the audit trail can be rewritten by someone with schema privileges, and exports
are manual.

### 3. MFA and session limits: code is in, enforcement depends on configuration

**Done in code:** the SPA signs out after idle time, and the API can refuse staff sessions
that did not complete MFA (`REQUIRE_STAFF_MFA`).

**Still open, and honest about the limits:**

- Enforcement is **off until `REQUIRE_STAFF_MFA=true` is set** and the updated post-login
  Action is deployed. Until then nothing is enforced.
- MFA is only as real as the Auth0 side. The Action sets the claim only after a challenge,
  and the API trusts that claim. Someone who can edit the Action or the tenant can weaken it.
  The Action's Management API calls (`challengeWithAny`, `enrollWith`) were written from the
  documentation and have **not been run against a live tenant**; test with a throwaway staff
  user first.
- Idle and absolute session limits are Auth0 tenant settings. `deploy/auth0-hardening.sh`
  sets them (dry run by default) but nobody has run it; the app cannot see the tenant values.
- Idle logout is browser-side. It does not revoke the token; a copied token is valid until
  it expires.
- `deploy/auth0-hardening.sh` and the Action update are for you to run; see `COMMANDS.md`.

**Risk:** a stolen but unexpired token still works; MFA can be loosened in the tenant.

### 4. Dev auth: partly addressed

`AUTH_PROVIDER=dev` mints tokens for any known email with no password.

**Done:** the SPA no longer keeps the token in `localStorage` (it is per-tab
`sessionStorage`, and an older `localStorage` token is purged), and dev tokens expire after
8 hours. XSS on marketing HTML is closed off by the sanitizer (gap 7).

**Still open:** a token in `sessionStorage` is still readable by any script that runs on the
page, so an XSS elsewhere would still reach it. The Auth0 path uses the SDK's default in-memory
cache, which is not persisted but is also reachable by script on the page.

**Risk:** acceptable only on throwaway local/dev. Fatal if a production deploy ever
boots with `AUTH_PROVIDER=dev` (boot guard exists; do not weaken it).

### 5. Log hygiene: partly addressed

**Done:** the invitation message id is no longer logged, notification failures log only the
notification type plus error name/code in production, Fastify request logs use route patterns
and redact credential headers and `*.email`, and the error handler logs name/code/status only
in production.

**Still open:** `payment_events.payload` stores the full Stripe event JSON (PII, not usually
clinical PHI, but still regulated in combination). Mailpit in dev displays patient names and
order numbers. Seed scripts print account emails (they refuse to run in production).
Redaction is path-based, not a general PHI denylist, so a new log line that interpolates
patient data would still leak it.

**Risk:** ops tools, log drains, and support screenshots become a second PHI store
without a BAA or retention control.

### 6. Offsite PHI backups and retention

Azure Flexible Server has 7-day PITR for the database. The PHI file volume is not
backed up by the provisioner. There is no documented retention / destruction schedule
for `order_events`, notifications, payment payloads, or (new) chat logs.

**Risk:** ransomware or disk loss loses lab PDFs; over-retention of chat logs expands
breach scope.

### 7. Marketing HTML: addressed, with limits

BU admins' HTML is now run through an allowlist sanitizer on save and when served.

**Limits:** it is an allowlist, not a proof; a future allowed tag or attribute needs review.
Allowed `<style>` blocks can still restyle the whole page (for example to fake a login
form's look), though they cannot run script or load non-https resources. The page is still
rendered inline, not in a sandboxed iframe, so a sanitizer bug would be an XSS.

**Risk:** reduced from stored XSS to a defacement/phishing-by-styling risk.

### 8. New with patient report AI

These land when Phase 4 of the current work ships. Treat them as **open gaps from
day one of the feature**, not as later surprises.

| Gap | Detail |
|-----|--------|
| Third-party LLM BAA | Chat sends extracted report text and the patient’s question to the configured provider. OpenAI / Anthropic / a random gateway is a BA only if a BAA is in place. **Mitigated in code, not in law:** production chat only uses providers a platform admin marked “Approved for PHI”; the flag is an attestation, not proof. Nothing verifies that a BAA exists, covers that model, or that the URL really belongs to that vendor. Development and test ignore the flag. |
| Extracted text and conversations are PHI | `file_extractions.extracted_text`, `report_messages.content`, and clinician interpretation copied into the prompt are ePHI at rest. |
| API keys in the database | Provider keys are encrypted with `APP_ENCRYPTION_KEY`, but that key must be managed like a secret, rotated, and never logged. |
| Prompt / response logging | Application logs must not print user questions, report text, or model replies. Token counts and provider ids are enough. |
| Client round-trip of extraction | The extract endpoint returns text to the browser (product request). The chat endpoint **reloads from the DB cache** and ignores client-supplied report text so a tampered browser cannot inject a fake report. The extract response is still PHI in the browser. |
| Minimum necessary to the model | The full PDF text is sent, not a redacted subset. That is convenient and not minimum-necessary. |

### 9. Other known gaps (lower urgency, still real)

- ~~Patient order detail API can include `aiDraft` after release~~ Fixed: the patient API drops `aiDraft` and `aiModel`. Doctors still receive both.
- Stripe Dashboard / webhook payloads may contain patient email and shipping address.
- Integrations API (`INTEGRATION_API_SECRET`) can create orders server-to-server — treat that secret as production-grade.
- ~~No automatic logoff in the SPA~~ Added (15 minutes idle, see gap 3 for its limits).
- No emergency-access (“break-glass”) procedure documented.

## Recommended sequence

Do these in order. Later items assume earlier ones exist so PHI is not copied into a
new store we cannot audit.

1. **Access audit + log hygiene (done, with the open items in gaps 2 and 5)** — append-only `phi_access_events` (actor, role, resource type/id, action, request id, timestamp). Scrub emails and payloads from application logs. Strip `aiDraft` from the patient API. Do this before any production PHI chat.
2. **Encryption at rest** — CMK (or platform-managed key with rotation) on the PHI volume; encrypted Postgres (Flexible Server + customer key if required); keep `APP_ENCRYPTION_KEY` in the secret store, not the repo.
3. **Session / MFA policy (code done; needs the Auth0 steps in `COMMANDS.md` and `REQUIRE_STAFF_MFA=true`)** — MFA guard, idle logout, and the `localStorage` removal are shipped. Absolute session lifetime and the MFA Action still have to be applied to the tenant.
4. **Backups and retention** — offsite encrypted backup of the PHI volume; tested restore; retention/destruction for chat, extractions, notifications, and payment events.
5. **Sanitize marketing HTML (done, see gap 7)** — allowlist on write and read.
6. **LLM BAAs before production PHI chat** — do not point the cascade at a vendor without a BAA. Prefer a self-hosted or BAA-covered endpoint. Record the agreement in each provider's BAA reference field and tick “Approved for PHI” only then; the production gate (see above) keeps unapproved providers dark.
7. **Operational** — workforce training, incident runbook. The accounting-of-disclosures export from `phi_access_events` + `order_events` + `report_conversations` is done (per patient or order, for `bu_admin`).

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
