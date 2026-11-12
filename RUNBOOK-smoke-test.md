# Production smoke test runbook

A repeatable end-to-end test on production with real money in small amounts: a real card pays for a
real order, Stripe confirms it, and the money is refunded. Run it before go-live (the last item of
[RUNBOOK-production.md](RUNBOOK-production.md)), after any payment, checkout, or webhook change,
and whenever a customer site is first linked to checkout.

Never use real patient data. Every shopper is you, under a plus-address, and every results file is
synthetic.

Variables used below:

```bash
export APP_HOST=app.qinio.co          # the production host
export SLUG=qinio-smoke
export PKG_ID=<smoke package id>      # from Packages after setup
export RUN=1                          # increment for every run; it goes into the email and the log
```

## 1. One-time setup

1. **Business unit:** onboard an internal business unit with slug `qinio-smoke` (Part 1.1 of
   [RUNBOOK-customer-onboarding.md](RUNBOOK-customer-onboarding.md)). Its admin is an internal
   address you control.
2. **Stripe:** on its **Payments** page, connect a live Standard account that Qinio owns (with a
   real bank account, since live Connect onboarding requires one). Wait for charges enabled.
3. **Team:** add yourself, or a second internal address, as fulfillment, lab, and doctor members
   so the optional workflow in step 3 below can be walked through without involving a real lab or
   kit vendor. Do not connect any external fulfillment or lab integration to this business unit.
4. **Package:** create a test type and a package named "Smoke test (internal)", price **$1.00**
   (Stripe's minimum is $0.50), with clinician review on. Press **Sync**. Leave it in **draft**:
   active packages are listed publicly, so it is only active while a test is running.
5. **Marketing origin (for run type C):** on **Marketing page → Marketing site origins**, register an
   https origin you control, for example a staging copy of the customer's site or a one-page test
   site. The page needs a Buy button wired as in
   [RUNBOOK-third-party-site.md](RUNBOOK-third-party-site.md) and a generic thank-you page.
6. **Card and email:** a personal or company card you own, and an email provider that accepts
   plus-addresses (`you+smoke-1@example.com`).
7. **Synthetic results PDF:** a one-page PDF that says "SYNTHETIC TEST RESULT, NOT A PATIENT" and
   contains no real names or values.

Check: `https://$APP_HOST/$SLUG` loads, and with the package still in draft it does not show the
smoke package.

## 2. Each run

Do the steps in order and tick each check. Stop at the first failure and record it in the log
(section 5).

### Step 1. Preflight

```bash
curl -fsS "https://${APP_HOST}/api/health"        # status ok, database connected
curl -fsS "https://${APP_HOST}/api/auth/config"   # provider auth0, "simulationEnabled":false
```

On the VM, without printing values:

```bash
cd ~/nio-platform
grep -E '^(PAYMENT_PROVIDER|STRIPE_LIVE_MODE|SIMULATION_ENABLED|ALLOW_DEV_AUTH|STORAGE_DRIVER)=' .env.production
systemctl list-timers nio-db-dump.timer --no-pager
```

- [ ] `PAYMENT_PROVIDER=stripe`, `STRIPE_LIVE_MODE=true`, `SIMULATION_ENABLED=false`,
      `ALLOW_DEV_AUTH=false`, `STORAGE_DRIVER=azure_blob`.
- [ ] The dump timer shows a next run.
- [ ] Activate the smoke package (Packages → set to active). It now appears on
      `https://$APP_HOST/$SLUG`.

### Step 2. Pay

Use the entry point for the run type (section 3). For run type A, open
`https://$APP_HOST/$SLUG/order/$PKG_ID?utm_source=smoke&utm_campaign=run-$RUN` in a private
window. Enter `you+smoke-$RUN@example.com`, a test shipping address you own, and pay with the real
card.

- [ ] The Stripe-hosted page shows $1.00 and the business unit's name.
- [ ] The thank-you page loads after payment.
- [ ] In Stripe (live mode, **Connect → Accounts → the smoke `acct_...` → Payments**), the charge
      shows Succeeded. Note the `ch_...` or `pi_...` id.
- [ ] In Stripe **Developers → Event destinations**, the live destination shows
      `checkout.session.completed` delivered with a 200 response.
- [ ] In Qinio **Orders**, the order exists with payment status paid and attribution
      `utm_source=smoke`, `utm_campaign=run-N`. Note the order number.
- [ ] **Payments** lists the payment as succeeded.
- [ ] The activation email arrives at the plus-address, and only after payment (none if you
      abandoned on the Stripe page).

If the order stays `pending_payment` while Stripe shows the charge succeeded, the webhook did not
arrive. Check the destination's signing secret and URL, then press **Reconcile** on the payment.

### Step 3 (optional). Walk the full workflow

Do this on the first run, before go-live, and after changes to fulfillment, lab, results, or
storage. Skip it for a payment-only rerun.

1. As fulfillment, mark the kit shipped.
2. As the patient (activate the account from the email), mark the kit received and the sample sent.
3. As lab, check the sample in, start processing, and upload the **synthetic** PDF.
4. As doctor, review and approve.
5. As the patient, open the released result and download the PDF.

- [ ] Each status appears on the order timeline in order.
- [ ] The downloaded PDF matches the synthetic file.
- [ ] **Audit → accounting of disclosures** for the order lists the download.
- [ ] The PDF is in blob storage, not on the VM (see section 2 of
      [RUNBOOK-backup-restore.md](RUNBOOK-backup-restore.md) for the list command).

### Step 4. Refund

In Qinio, **Payments → Refund remaining** on the payment. For run type B, refund part of it first
(see section 3).

- [ ] Qinio says "Refund submitted. Stripe will confirm it by webhook."
- [ ] In Stripe the charge shows Refunded and `charge.refunded` was delivered with 200.
- [ ] In Qinio the payment's **Refunded** column equals the amount, and the order's payment
      status is `refunded` (or `partially_refunded` after a partial refund).
- [ ] The order timeline has a "Stripe payment fully refunded" event.

### Step 5. Cancel

A refund does not cancel the order: fulfillment would still go ahead. Open the order in **Orders**
and use **Cancel order** with the reason "Smoke test run N".

- [ ] The order status is Cancelled and the timeline records the reason.
- [ ] The patient address receives the cancellation email.
- [ ] Fulfillment members are notified if the order had been dispatched to them.

Orders can only be cancelled until the lab receives the sample. If you walked the full workflow in
step 3 the order is already finished: skip this step and note "full workflow, not cancellable" in
the log.

### Step 6. Teardown and record

- [ ] Set the smoke package back to **draft**. Confirm it is gone from `https://$APP_HOST/$SLUG`.
- [ ] Add a row to the log (section 5).

## 3. Run types

| Run | Entry point | What changes from section 2 |
|---|---|---|
| **A** | Storefront guest checkout: `/$SLUG/order/$PKG_ID` | Nothing. The baseline. Full refund. |
| **B** | Same as A | Step 4: in Stripe, open the charge on the connected account and refund **$0.40**. Check Qinio shows `partially_refunded` and $0.40 refunded. Then **Refund remaining** in Qinio and check `refunded` and $1.00. |
| **C** | The registered test site's Buy button (checkout intent with `returnUrl`) | Step 2: the Qinio checkout shows the right package; the thank-you page has a **Back to** button that returns to the `returnUrl` exactly, with no order or patient data added; attribution from the intent appears on the order. |
| **D** | Signed-in patient: activate and sign in as the plus-address from an earlier run, then open `/$SLUG/buy/$PKG_ID` | Step 2: no activation email (the account exists); the order appears in that patient's portal. |
| **E** (optional) | A verified custom domain, `https://order.<domain>/` | Step 2: the whole flow, including the thank-you page and emails' links, stays on the custom domain apart from Stripe and the Auth0 login. |

Minimum before go-live: A and B. Add C before the first customer site is linked, D after changes to
signed-in checkout, and E before the first white-label customer.

Repeat a run type as often as needed. Each run costs a few cents (section 4) and needs only a new
`RUN` number and plus-address.

## 4. Costs and limits

- Stripe keeps its processing fee when a charge is refunded: about **$0.33 per $1.00 run** (2.9% +
  30 cents on standard US cards), charged to the smoke connected account. Ten runs cost about
  $3.30.
- Many charges and refunds on one card in a short time can trip fraud rules at Stripe or the card
  issuer. Space runs out and keep the number small; use a second card if one is declined.
- Not tested in live mode: disputes and declined or 3D Secure cards. A real dispute costs a dispute
  fee and harms the account. These stay covered by test mode on dev (the test cards and
  `stripe trigger charge.dispute.created` in `COMMANDS.md`).
- Stripe pays out the net amount (negative after refunds) to the smoke account's bank. That is
  expected; reconcile it monthly.

## 5. Log

Add one row per run. Never record card numbers; Stripe object ids are fine.

| Date | Run | Type | Order number | Charge / payment intent id | Refund id | Result | Notes |
|---|---|---|---|---|---|---|---|
| | 1 | A | | | | | |
