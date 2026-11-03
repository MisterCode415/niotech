# QiNio platform marketing: content source

Audience: business units that want to sell at-home lab testing through QiNio.
This file is the single source of copy for the static site in this folder. The Astro components
mirror it section by section, so change the words here first.

Status: DRAFT. Items marked **OPEN** need a decision before launch.

---

## 1. Feature inventory

Taken from the code, `README.md`, and `HIPAA-gaps.md`. "Status" is what exists in the repo today so
the copy never promises more than the platform does.

| Area | What it does | Status |
| --- | --- | --- |
| Branded storefront | One storefront per business unit at its own `/:slug`, with a marketing page editor (HTML sanitized on save and on read) | Live |
| Handoff from your own site | Send shoppers from your domain into checkout; return links are validated against an allowlist of your origins; UTM and `ref` tags carry through | Built, uncommitted |
| Packages and catalog | Draft / active / archived packages; multi-kit packages; automatic new version when a sold package changes; every order keeps an immutable snapshot of what was bought | Live |
| External products | Link a package to a product or purchase URL on a store you already run | Live |
| Checkout and payments | Stripe Connect Standard with direct charges: you are the merchant, funds land in your Stripe account, no card data touches QiNio | Test mode; live gated on Stripe approval |
| Guest checkout | Buy without an account first; an activation email follows the paid order | Built, uncommitted |
| Payment operations | Refunds (full and partial), dispute notices, reconcile with Stripe, product/price sync with drift detection | Live (test mode) |
| Purchase reconciliation API | Server-to-server endpoint to register purchases completed on another store, replay-safe | Live |
| Fulfillment portal | Order queue, QR sticker sheets, carrier and tracking entry, fulfillment charges and batching ledger | Live |
| Kit chain of custody | Unguessable QR token per kit; one scan shows each role its own next action; skipped hand-offs are caught up and logged | Live |
| Lab portal | Sample check-in, results PDF upload, mark analysis complete | Live |
| Clinician review | Optional per-package doctor step; AI draft is labelled and stored apart from the clinician's own words; approve or reject with explanation | Live (AI draft is a stub) |
| Direct-to-patient results | Packages with no clinician step go straight from lab to patient | Live |
| Patient portal | Order timeline, results held until released, report text extraction with OCR, post-release report chat | Live |
| Report chat | Answers questions about a released report; production only uses LLM providers a platform admin has marked as BAA-covered | Live, off in production until a BAA provider is approved |
| Order state machine | One definition of every legal transition and which role may make it; no skipping, no going backwards | Live |
| Team and roles | Admin, fulfillment, lab, doctor, patient roles per business unit; Auth0 Organizations; opt-in staff MFA | Live (MFA opt-in) |
| Notifications | Email and in-app messages for shipped, tracking, results ready, review requested, and similar | Live |
| Admin tools | Overview, orders, team, payments, AI settings, accounting-of-disclosures export (JSON/CSV) | Live |
| Multi-tenancy | Every business unit isolated at the app layer and by Postgres row-level security | Live |

Not offered yet (do not market): live payments, SMS, retest scheduling, affiliate programs, a
self-serve signup, a WYSIWYG page builder.

---

## 2. Page copy

### 2.1 Hero

**Eyebrow:** For health and wellness brands

**Headline:** Launch an at-home lab testing brand without building the lab stack.

**Sub:** QiNio runs the workflow behind a test kit: checkout, shipping, sample tracking, lab results,
and optional clinician review. You bring the brand and the customers.

**Primary CTA:** Talk to sales (scrolls to contact form)
**Secondary CTA:** See how it works (scrolls to section 2.2)

### 2.2 What the platform does

**Heading:** One workflow from checkout to results

**Intro:** Every kit follows the same tracked path. Each step belongs to one role, and the platform
refuses any move that skips a step or comes from the wrong person.

Steps (diagram):

1. **Customer buys** on your branded storefront or your own site.
2. **Kit ships** from fulfillment with a printed QR sticker and tracking number.
3. **Customer collects** their sample at home and mails it back with the prepaid lab label.
4. **Lab analyses** the sample and uploads the results.
5. **Clinician reviews** (optional, per package) and approves an interpretation.
6. **Customer gets results** in their dashboard, only once they are released.

Supporting points:

- **One scan, three roles.** The QR code on the kit shows fulfillment, the customer, and the lab
  different next actions.
- **Full timeline.** Every status change records who did it and when.
- **Your packages, your rules.** Choose which tests go in a kit and whether a clinician must review.
  Prices and contents are snapshotted per order, so catalog changes never alter a kit in flight.

### 2.3 Two ways to run it

**Heading:** Pick how much of the lifecycle QiNio runs

**Option A: Sell kits through QiNio**

QiNio's fulfillment partner, lab, and clinicians run the stages. Your brand is on the storefront,
the emails, and the customer experience.

- White-labeled storefront and customer portal
- Managed fulfillment, lab, and clinician network
- You focus on product, marketing, and customers

**Option B: Bring your own fulfillment, lab, and clinicians**

Use your own partners and your own people. QiNio is the software that coordinates them.

- Invite your fulfillment team, lab, and doctors into role-specific portals
- Same tracking, custody, and audit trail as managed stages
- Keep your existing partner relationships

**Note under both:** Stages can be mixed. For example, use QiNio's lab with your own clinicians.
(**OPEN:** confirm mixing is a real offering before launch.)

### 2.4 Feature grid

**Heading:** Everything a testing brand needs, already connected

Cards (title: benefit line):

- **Branded storefront:** Your name, your page, your packages. Edit the page content yourself.
- **Works with your site:** Send shoppers from your own domain and bring them back, with campaign
  tags preserved.
- **Packages that stay honest:** Change a price or test list and sold packages keep their history.
- **Payments to your account:** Stripe Connect puts you as merchant. Refunds and disputes are
  handled from your admin.
- **Guest checkout:** Customers can buy first and activate their account from the confirmation email.
- **Fulfillment tooling:** Queue, QR stickers, tracking, and a charges ledger.
- **Chain of custody:** Every hand-off from your warehouse to the lab is scanned and logged.
- **Lab results handling:** Check-in, PDF upload, and release controls.
- **Clinician review:** Optional doctor sign-off with an AI-assisted draft the clinician controls.
- **Patient results and Q&A:** Results appear only when released; customers can ask questions about
  their report.
- **Team roles:** Give each person only the portal and data their job needs.
- **Notifications:** Customers and staff are told what happened as it happens.
- **Audit and disclosure reports:** Look up everything that happened to a patient's data and export it.

### 2.5 Pricing

**Heading:** Simple, per-business-unit pricing

**Intro:** Final figures are set during onboarding. This is how pricing is structured.

| | |
| --- | --- |
| **Platform fee** | **$350 / month** per business unit. Includes your branded site and support. |
| **QiNio-managed stage** | **50% fee** on each stage QiNio provides (fulfillment, lab, clinician). All-inclusive: no separate vendor contracts. |
| **Bring-your-own stage** | **10% markup** on each stage you run with your own partners. Covers coordination, tracking, and audit. |

**Footnote:** Payment processing fees from Stripe are separate and paid by your Stripe account.
(**OPEN:** confirm whether to mention Stripe fees here.)

**OPEN decisions for pricing copy:**

1. "50% fee" and "10% markup": of what? Options: the stage's cost, or the retail price, or the
   package price. The copy above avoids saying. Needs one sentence once decided.
2. Mixed stages: assumed each stage is priced independently by who runs it.
3. Whether to show "exact pricing in onboarding" or "starting at". Draft uses the former.
4. Currently `STRIPE_PLATFORM_FEE_BPS=0` in code, so these fees are not yet collected automatically;
   the site must not imply automated billing.

### 2.6 Security and HIPAA (sub-section)

**Heading:** Built toward HIPAA requirements

**Intro:** Handling lab results means handling protected health information. QiNio is engineered
around HIPAA's safeguards, and we are open about where that work stands. This is not a legal
opinion, and each business unit remains responsible for its own compliance program.

**What is in place:**

- **Tenant isolation.** Each business unit's data is separated in the application and again by
  database row-level security.
- **Results held until release.** A customer cannot read results while the lab or clinician still
  has them.
- **Access audit trail.** Views of results, files, and reports are recorded with who, when, and
  from which request, in an append-only table.
- **Disclosure reports.** Admins can export an accounting of disclosures for a patient or order.
- **Encryption.** Data in transit uses TLS; lab files and database are encrypted at rest on Azure
  infrastructure covered by a Microsoft BAA.
- **Staff MFA and idle logout.** Multi-factor sign-in can be required for all staff roles; idle
  sessions sign out automatically.
- **Minimal PHI elsewhere.** No clinical details go to the payment provider; only opaque IDs.
- **AI with guardrails.** In production, report chat only uses providers approved as BAA-covered.
- **Backups.** Database point-in-time restore plus long-term archives, and versioned lab files.

**What we say plainly:**

- QiNio is working toward a posture that can be formally assessed. We do not claim certification.
- A BAA is arranged with each customer during onboarding. (**OPEN:** confirm that this is the
  intended process and who signs.)

**Wording rules for the site:** never say "HIPAA compliant" or "HIPAA certified". Say "built toward",
"BAA-covered infrastructure", "safeguards".

**OPEN (internal, from `HIPAA-gaps.md`, do not publish):** several items are scripted but not yet
verified or enforced: staff MFA is off until configured, no restore has been tested, retention and
destruction schedules are missing, customer-managed keys have not been run. Confirm the public
bullets above are true on the production stack at launch, particularly MFA and backups.

### 2.7 How onboarding works

**Heading:** We work with a small number of businesses, on purpose

**Intro:** There is no self-serve signup. Lab testing is regulated and sensitive, so we talk to
every business unit before it goes live.

1. **Tell us about your idea.** Send the form below.
2. **We review.** We look at your use case, product intent, and market fit for our lab lifecycle.
3. **We reach back out.** If it fits, we agree the model (managed or bring-your-own) and pricing.
4. **Onboarding.** We set up your business unit, storefront, team, and payments.

### 2.8 Contact form

**Heading:** Talk to us

**Sub:** Tell us what you want to sell. We will reply by email.

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| Name | yes | |
| Work email | yes | We reply here |
| Company | yes | |
| Website | no | |
| What are you planning to sell? | yes | Product intent, tests, audience. 20 to 2000 characters |
| Model of interest | yes | Sell through QiNio / Bring our own partners / Not sure yet |

Hidden: a honeypot field named `company_url`, which real visitors never see.

**Submit button:** Send

**Success:** Thanks. We review every request and will email you soon.

**Error:** Something went wrong. Please try again, or email us directly.

**Privacy line under form:** Do not include patient information in this form.

### 2.9 Footer

QiNio. Contact link. (**OPEN:** privacy policy and terms pages, company legal name, sales address.)

---

## 3. Open questions summary

1. Basis for the 50% and 10% fees.
2. Is mixing managed and BYO stages offered?
3. Mention Stripe processing fees?
4. BAA process wording.
5. Privacy policy, terms, legal entity name, and the sales inbox address.
6. Confirm security bullets match production configuration at launch.
