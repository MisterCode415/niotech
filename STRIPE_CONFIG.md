# Stripe Connect Configuration

Working record for the Qinio Stripe sandbox. Keep credentials in `.env` or the deployment secret
store—never put keys or webhook signing secrets in this file.

## Architecture

- Processor: Stripe
- Integration: Stripe Connect
- Connected account type: Standard
- Charge model: Direct charges
- Checkout: Stripe-hosted Checkout
- Catalog source of truth: Qinio
- Application fee: `0` basis points during sandbox testing
- Mode: Test

Each business unit connects its own Stripe account and is the merchant for its patient purchases.
Qinio creates Products, Prices, and Checkout Sessions in that connected account.

## Dev event destination

- Destination name: `Transactions Dev`
- Events from: Connected accounts
- Payload style: Snapshot
- API version: `2026-08-26.dahlia`
- Endpoint URL: `https://dev.qinio.co/api/webhooks/stripe`
- Signing secret: stored as `STRIPE_WEBHOOK_SECRET`; do not record its value here

### Subscribed events

The destination should listen to these 13 events:

```text
account.updated
product.updated
product.deleted
price.updated
checkout.session.completed
checkout.session.expired
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.dispute.created
charge.dispute.closed
```

Do not subscribe to all events. The application stores accepted events for audit and idempotency,
so unrelated events add noise and database growth.

## Connect OAuth callbacks

Register both callback URLs in Stripe Connect settings:

```text
http://localhost:4000/api/payments/stripe/callback
https://dev.qinio.co/api/payments/stripe/callback
```

## Environment variables

```dotenv
PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_REDACTED
STRIPE_CONNECT_CLIENT_ID=ca_REDACTED
STRIPE_WEBHOOK_SECRET=whsec_REDACTED
STRIPE_CURRENCY=usd
STRIPE_PLATFORM_FEE_BPS=0
STRIPE_LIVE_MODE=false
```

Key meanings:

- `STRIPE_SECRET_KEY`: server-only Stripe API key beginning with `sk_test_` in sandbox.
- `STRIPE_CONNECT_CLIENT_ID`: Connect application identifier beginning with `ca_`.
- `STRIPE_WEBHOOK_SECRET`: destination signing secret beginning with `whsec_`.
- A publishable key beginning with `pk_test_` is not currently needed because Checkout is hosted.

## Local webhook forwarding

```bash
stripe login
stripe listen --forward-connect-to localhost:4000/api/webhooks/stripe
```

The CLI prints a temporary `whsec_...` value. Use that as the local
`STRIPE_WEBHOOK_SECRET` while the listener is running.

## Where sandbox charges appear

Checkout creates a **direct charge on the connected Standard account**. In the Stripe
Dashboard:

1. Confirm the toggle is **Test mode** when `STRIPE_SECRET_KEY` starts with `sk_test_`.
2. Open **Connect → Accounts → the connected `acct_...`**, not the platform account's
   Payments list. The business-unit Payments page links there.
3. If `PAYMENT_PROVIDER=mock` (the default in `.env.example`), no Stripe objects are
   created at all.

Webhooks without `event.account` are ignored. The destination must listen to events
from connected accounts. If Checkout completed in Stripe but Qinio is still
`pending_payment`, the webhook never arrived — use the Reconcile button or fix the
listener secret.

## Sandbox test cards

```text
Successful card: 4242 4242 4242 4242
Declined card:   4000 0000 0000 0002
3DS challenge:   4000 0025 0000 3155
Expiry/CVC:      any future date / any three digits
```

## Remaining setup

- Confirm all 13 connected-account events are selected.
- Save the event destination and copy its `whsec_...` signing secret into the dev environment.
- Register both Connect OAuth callbacks.
- Add the test secret key and Connect client ID to local and Azure dev environments.
- Connect a Standard test account from a business unit's Payments page.
- Verify Qinio package creation creates the corresponding Stripe Product and Price.
- Complete successful, declined, 3DS, refund, dispute, replay, and cross-tenant isolation tests.
- Obtain Stripe's written approval for the exact health-testing business model before live mode.

## Change log

- 2026-09-19: Recorded the initial Standard Connect, direct-charge, hosted-Checkout sandbox
  configuration and dev connected-account event destination.
