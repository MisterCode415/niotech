# Customer onboarding runbook

How a new customer (a business unit) gets selling on Qinio, for each way they can sell. Pick the
scenario with the decision table, do **Part 1** once for every customer, then follow the scenario's
steps. Operator commands assume the working variables from `COMMANDS.md` (`APP_HOST`, `VM_USER`,
`VM_IP`). Placeholders: `SLUG` is the customer's storefront slug, `PKG_ID` a package id.

Who does what:

| Role | Who | Does |
|------|-----|------|
| Platform admin | Us | Creates the business unit, connects domains, owns the edge and DNS target |
| Business unit admin | The customer | Builds the catalog, connects Stripe, edits pages, registers their marketing site, chooses branding |
| Customer's web team | The customer or their agency | Adds a link, snippet, or DNS records on their own site |

## Choosing a scenario

| Scenario | The customer has | Shopper sees | Qinio handles | Extra infra |
|----------|------------------|--------------|---------------|-------------|
| **A. Qinio storefront** | No site, or a site that just links to us | `https://<qinio-host>/SLUG` | Everything | None |
| **B. Marketing site + Qinio checkout** | Their own site | Their site, then a Qinio checkout page | Checkout, payment, fulfillment, results | None |
| **C. Marketing site + catalog widget** | Their own site, no wish to build product cards | Package cards on their site, Buy goes to Qinio | Same as B | None |
| **D. API bridge** | Their own store that takes payment | Their store only; Qinio emails the patient afterwards | Fulfillment, lab, results | Platform-held integration key |
| **E. White label domain** | Any of the above plus a wish to hide Qinio | `https://order.their-clinic.com` throughout | Same as the underlying scenario | Edge enabled (`CUSTOM_DOMAINS=true`) |

Scenarios combine: B or C plus E is the usual "fully branded" setup. A is always available as the
fallback. D is separate because the customer, not Qinio, takes the money.

Payment note: B, C, and A take payment through Qinio's Stripe Connect. Until the customer has
connected Stripe and each package is synced, checkout refuses with "This storefront is not ready
to accept payments". On the dev stack `PAYMENT_PROVIDER=mock` pays instantly and creates nothing in
Stripe, which is fine for rehearsal and refused for anonymous checkout in production.

---

## Part 1. Every customer (do this first)

### 1.1 Platform admin: create the business unit

1. Sign in as the platform admin. Open **Platform** and use **Onboard a business unit**.
2. Enter company name, storefront slug (lowercase, becomes `/SLUG`; it cannot be changed casually
   because links, buy links, and QR scans use it), and the customer's first admin name and email.
3. This creates the tenant, its Auth0 organization, and the admin account, and emails the admin an
   activation link. Confirm with the customer that the email arrived; in dev, SMTP may be
   captured by Mailpit instead of delivered.

### 1.2 Customer admin: activate and set up

1. Open the activation email, set a password, and sign in. If staff MFA is on
   (`REQUIRE_STAFF_MFA=true`) enroll a second factor when prompted.
2. **Packages page:** create the test types (sample type, turnaround), then create packages from
   them. Set price, whether a clinician reviews results, and leave a package in `draft` until it is
   ready. Only `active` packages are sellable and listed publicly.
3. **Payments page:** **Connect Stripe** and complete Stripe's onboarding. When it shows charges
   enabled, press **Sync** on each package (activation fails until the package synchronizes when
   Stripe is the provider).
4. **Team page:** add fulfillment, lab, and doctor members. Each receives an invitation email.
5. **Marketing page:** write and publish the storefront page (used by scenario A and as the landing
   page for shoppers who go back to the storefront).
6. **Branding page (optional now, required for E):** display name, logo URL (https), primary color.

### 1.3 Smoke test the baseline

```bash
export SLUG=<customer-slug>
curl -fsS "https://${APP_HOST}/api/public/${SLUG}/packages" | jq '.packages[] | {id,name,priceCents}'
```

Open `https://${APP_HOST}/${SLUG}`. Every active package should appear with an **Order kit** button.
This is scenario A, complete. Place one test order before going further (use Stripe test cards on
dev) and confirm the order reaches the fulfillment queue.

---

## Scenario A. Qinio storefront

The shopper uses the page Qinio hosts. Nothing else to configure.

Customer steps: share `https://<qinio-host>/SLUG` or a package deep link. Two shopper paths exist:

- **Order without an account** (`/SLUG/order/PKG_ID`): email, name, address, pay. The account and
  activation email are created only after payment clears. Results are unreadable until the
  shopper activates.
- **Register first** (`/SLUG/register`): creates the account and sends activation immediately.

Verify: complete a test purchase as a brand-new email; check that the shopper receives the
activation email only after payment, and that the order appears in the customer's **Orders** page.

---

## Scenario B. Marketing site, Qinio checkout

The customer keeps their own site. Its Buy buttons send shoppers to Qinio checkout, and Qinio can
send them back. No order, test, or patient data is ever passed to the marketing site; only the
shopper's browser moves between the two.

### B.1 Customer admin: register the marketing site

On **Marketing page → Marketing site origins** list the exact origin of the site, one per line, for
example `https://www.their-clinic.com` (https only; no paths, no credentials). Only these origins
can be a return destination. Creating an intent with a return link on any other origin is
refused with a 400, and an origin removed later stops being honored on intents already issued.

### B.2 Choose the link style

| Style | Use when | How |
|-------|----------|-----|
| **Static buy link** | A plain button or email link | **Packages → Copy buy link** on an active package gives `https://<host>/SLUG/buy/PKG_ID`. Append `?utm_source=...&utm_medium=...&utm_campaign=...` or `&ref=...` to track the source. |
| **Checkout intent** | The site wants a "Back to site" button after checkout | The site's server or browser POSTs to Qinio and redirects the shopper to the URL it gets back. |

Checkout intent call (from a server, or from the browser on a registered origin):

```bash
curl -sS -X POST "https://${APP_HOST}/api/public/${SLUG}/checkout-intents" \
  -H 'content-type: application/json' \
  --data '{
    "packageId":"PKG_ID",
    "returnUrl":"https://www.their-clinic.com/thanks",
    "attribution":{"utm_source":"newsletter","utm_campaign":"fall"}
  }'
# => {"id":"...","url":"https://<host>/SLUG/buy/PKG_ID?intent=...","expiresAt":"..."}
```

Redirect the shopper to `url`. Notes for the customer's developers:

- Intents last 24 hours. An expired link shows an expiry message; make a fresh intent per click
  rather than caching one.
- `returnUrl` is optional but, when given, must be on a registered origin (otherwise 400).
- Only `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and `ref` are kept.
- The call is rate-limited to 30 per minute per IP. Never send shopper details to this endpoint.
- The server does not trust the caller for price; the price always comes from the package.

### B.3 Shopper flow to expect

Buy button → Qinio checkout (signed-in patients see the normal checkout, everyone else the
pay-first form) → Stripe → "Thank you" page, with a **Back to <their site>** button when an intent
was used → activation email to the shopper.

### B.4 Verify

1. Click the buy link from the real marketing site.
2. Confirm the page shows the right package and price.
3. Pay with a test card (or mock on dev).
4. Confirm the order's attribution in the customer's **Orders** page matches the tags used, the
   "Back to" button returns to the registered origin, and the activation email arrives.

---

## Scenario C. Marketing site with the catalog widget

Same as B, but the customer pastes one snippet instead of building product cards.

1. Complete **B.1** (register the marketing site origin). The widget only works from registered
   origins.
2. The customer copies the snippet from **Marketing page → Catalog widget**:

   ```html
   <div id="qinio-catalog"></div>
   <script async src="https://<qinio-host>/embed.js"
     data-business-unit="SLUG"
     data-target="#qinio-catalog"></script>
   ```

   Optional attributes: `data-label="Buy now"` for the button text, and `data-api` to point at
   a different Qinio origin than the script's own.
3. The widget lists active packages, uses the business unit's primary color, and on Buy asks Qinio
   for a checkout intent (return link is the page the button was on), then redirects.

Verify: load the page from the registered origin and confirm cards render. From any other origin
the widget shows "The catalog is not available right now", which is the intended refusal. If the
customer's page has a strict Content Security Policy, allow the Qinio host in `script-src` and
`connect-src`.

Limits: the widget is read-only and unstyled beyond its card layout. Customers who want full design
control should use B.

---

## Scenario D. API bridge (customer's own store takes payment)

The customer sells and charges on their store; Qinio fulfills. Qinio never touches the money, so
Stripe Connect is **not** needed. The store reports each paid purchase to Qinio from its server.

> **Platform-wide key.** There is a single `INTEGRATION_API_SECRET` for the whole platform, not one
> per customer. Whoever holds it can create orders in **any** business unit. Run the integration
> from a server we control, or give the key only to a party we would trust with every tenant. A
> per-tenant key is an open follow-up.

### D.1 Platform admin

1. Confirm the key exists on the VM (do not print it): `grep -Eq '^INTEGRATION_API_SECRET=.+' .env.production && echo set`.
   If missing, generate it as in `COMMANDS.md` ("Generate the alpha server-to-server commerce key")
   and recreate the API container.
2. Decide who will run the integration and how the key reaches them (a secret manager, never email).

### D.2 Customer admin

On **Packages**, set each package's **External product id** to the SKU the store uses. Packages
must be `active`. The external id must match exactly, because it is how a purchase finds its package.

### D.3 The call

From the store's server, after payment succeeds:

```bash
curl -fsS -X POST "https://${APP_HOST}/api/integrations/${SLUG}/purchases" \
  -H 'Content-Type: application/json' \
  -H "X-Qinio-Integration-Key: ${QINIO_INTEGRATION_KEY}" \
  --data '{
    "source":"custom_store",
    "externalOrderId":"store-order-1001",
    "externalPaymentId":"store-payment-1001",
    "packageReference":"external-product-id-from-package-admin",
    "patient":{"email":"patient@example.com","name":"Example Patient"},
    "shippingAddress":{"line1":"44 Cedar Street","city":"Portland","region":"OR","postalCode":"97205","country":"US"},
    "shippingMethod":"ground"
  }'
```

- It returns `201` for a new order and `200 {"replayed":true}` for a repeat of the same `source` plus
  `externalOrderId`, so the store can safely retry on timeouts.
- The order lands directly in the fulfillment queue, already marked paid. The patient receives an
  invitation email immediately.
- Always call the **platform host**. Custom domains refuse this route by design.
- It is rate-limited to 120 per minute.

### D.4 Verify

Send one test order with a throwaway email, confirm `201`, and check the order in the customer's
**Orders** page and fulfillment queue. Send it again and confirm `replayed: true`.

---

## Scenario E. White label domain

The customer's storefront, checkout, and patient portal run on their own hostname such as
`order.their-clinic.com`. Add this to any of A to C. It does not apply to D (server calls).

### E.0 One-time platform prerequisite

The edge must be on: `CUSTOM_DOMAINS=true` in the VM's `.env.production`, then a redeploy. This
swaps the public listener to Caddy, which issues certificates on demand. It also requires Docker
Compose 2.24.4 or newer and, in Auth0 mode, that the management client has `read:clients` and
`update:clients`. See `COMMANDS.md`, "Custom domains (white label)", for the full list and the
effect on certificate handling. `SERVER_NAME` must be a hostname customers can CNAME to.

### E.1 Platform admin: add the domain

1. **Platform → Custom domains**, choose the business unit, enter the bare hostname (no `https://`,
   path, or port), and press **Add domain**.
2. The page shows the two DNS records for the customer. Send them over (they are also on the
   customer's **Branding** page):
   - `TXT` at `_qinio.<hostname>` with value `qinio-verify=<token>` proves ownership;
   - `CNAME` from `<hostname>` to the platform's `SERVER_NAME`. Use ALIAS or ANAME if the hostname
     is a root domain.

### E.2 Customer's web team: publish DNS

Create the two records at the customer's DNS provider. Prefer a subdomain (`order.`, `shop.`,
`test.`) over a root domain; root domains need ALIAS support. Propagation can take minutes to hours.

### E.3 Platform admin: verify and go live

1. Press **Check DNS**. The TXT record is what verifies. If the CNAME is not published yet the
   page says the domain is verified but does not route; that is fine until DNS catches up.
2. A verified first domain becomes **primary**, which is the address used in emails, buy links, and
   handoff links. Use **Make primary** to change it when a customer has several.
3. Open `https://<hostname>`. The first request obtains the certificate and can take a few
   seconds. The root redirects to the customer's storefront.
4. The platform page warns if sign-in could not be enabled for that domain (Auth0 registration
   failed); fix the scopes and press **Re-check**.

### E.4 Customer admin: brand it

On **Branding** set display name, logo, and primary color. These apply to the storefront, checkout,
login, and portal on both the custom domain and the platform URL. Re-copy buy links afterwards:
they now use the primary custom domain.

### E.5 Verify

- `https://<hostname>` shows the customer's brand and storefront, with no Qinio wordmark.
- A test purchase returns to `https://<hostname>` after Stripe, and the activation email links to it.
- Sign-in works from the domain (Auth0 briefly shows its own login page; that is expected, see
  `COMMANDS.md`).
- `https://<hostname>/api/platform/business-units` answers 404 and another tenant's slug does too:
  the domain serves only its own tenant.

### E.6 Change or remove a domain

- **Disable** stops serving immediately and removes the Auth0 allowance. Verifying again re-enables.
- **Remove** deletes it and its links stop working. If it was primary, another verified domain is
  promoted automatically.
- Suspending the business unit closes all of its domains at once.
- QR stickers always point at the platform host, so removing a domain never breaks printed labels.

---

## Common problems

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "This storefront is not ready to accept payments" | Stripe not connected, or charges not enabled | Customer completes Payments → Connect Stripe |
| "This package is not synchronized with Stripe" | Package edited or never synced | Payments page → Sync, then re-activate |
| Buy link shows "not available" | Package is `draft` or `archived` | Activate the package |
| Intent call returns 400, or "Back to site" button missing | Return origin not registered (or removed since the intent was made), or not https | Add the exact origin on the Marketing page and create a fresh intent |
| Link says it expired | Intent older than 24 hours | Create a fresh intent per click |
| Widget shows "catalog is not available" | Page origin not registered, or CSP blocks the script | Register the origin; allow the Qinio host in the CSP |
| 429 from intents or guest checkout | Rate limit (30 per minute, 10 orders per hour per IP) | Retry later; check a bot is not hammering it |
| Shopper never got the activation email | Payment not yet confirmed, or SMTP problem | Check the order is paid; the system retries unsent invites each minute |
| Domain stuck pending | TXT record missing, wrong token, or not propagated | Compare with the values on the page; `dig TXT _qinio.<host>` |
| Domain verified but site unreachable | CNAME missing, or edge not enabled | Publish the CNAME; confirm `CUSTOM_DOMAINS=true` and a redeploy |
| Sign-in from the domain fails | Domain not registered with Auth0 | Grant the M2M client `read:clients` and `update:clients`, then Re-check |
| Integration call returns 403 | Wrong or missing key, or integration disabled | Confirm `INTEGRATION_API_SECRET` is set on the VM and the header matches |
| Integration call returns 404 | `packageReference` does not match any active package's external product id | Fix the id on the Packages page |

## Go-live checklist

- [ ] Business unit created; admin activated and (if enabled) enrolled in MFA
- [ ] Test types and packages created; at least one package active
- [ ] Stripe connected, charges enabled, packages synced (scenarios A to C)
- [ ] Team members invited (fulfillment, lab, doctor as needed)
- [ ] Storefront page published
- [ ] Marketing site origin registered (B, C)
- [ ] External product ids set and key handled safely (D)
- [ ] Domain verified, primary, branded, and a purchase tested end to end (E)
- [ ] One real purchase placed, shipped, resulted, and released before announcing
