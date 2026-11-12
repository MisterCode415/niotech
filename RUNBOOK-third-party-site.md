# Linking your website to Qinio checkout

For the developer of a website that already exists and now needs to sell a business unit's test kits
through Qinio. You keep your site; Qinio handles checkout, payment, fulfillment, the lab, and
results. Your site only sends the shopper to Qinio, and optionally gets them back.

What never reaches your site: order details, test results, or anything about the shopper. That is
deliberate, so your site stays outside the health-data boundary. Do not try to collect shopper
details and pass them along.

The business unit's admin does their side using Scenarios B and C of
[RUNBOOK-customer-onboarding.md](RUNBOOK-customer-onboarding.md). This guide is the website side.

## 1. What you get from Qinio

Ask the business unit's admin (or Qinio) for:

| Item | Example | Where it comes from |
|---|---|---|
| Qinio host | `https://app.qinio.co` (or the business unit's own domain, such as `https://order.your-clinic.com`) | Qinio |
| Business unit slug | `your-clinic` | Qinio |
| Package ids | `0b6c…-…` (a UUID per product) | Admin: **Packages → Copy buy link** on an active package. The id is the last part of the link |
| Your origin registered | `https://www.your-clinic.com` | Admin: **Marketing page → Marketing site origins** |

The origin must match exactly: scheme, host, and port. `https://your-clinic.com` and
`https://www.your-clinic.com` are different origins, so register both if both serve pages. Up to 10
origins can be registered. A change can take up to 30 seconds to apply.

Below, `QINIO` is the host and `SLUG` the slug.

## 2. Pick an option

| Option | Effort | Shopper returns to your site | Use when |
|---|---|---|---|
| 1. Static buy links | Minutes, HTML only | No | Simple buttons, emails, ads |
| 2. Checkout intents | A small server endpoint | Yes, with a **Back to** button | You want shoppers to come back after paying |
| 3. Catalog widget | One snippet | Yes | You do not want to build product cards |

You can mix them, for example the widget on a shop page and static links in emails.

## 3. Option 1: static buy links

```html
<a class="button" href="https://QINIO/SLUG/buy/PACKAGE_ID?utm_source=website&utm_medium=button&utm_campaign=fall">
  Order the kit
</a>
```

- Tags you can add: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and
  `ref`. Each is up to 200 characters. Others are ignored. They show on the order in Qinio so sales
  can be attributed to your site.
- The link never expires. If the package is deactivated the page says it is unavailable.
- Price and product details always come from Qinio, so editing the link cannot change what is
  charged.
- After paying, the shopper stays on Qinio's thank-you page. There is no way back to your site;
  use option 2 or 3 if you need one.

## 4. Option 2: checkout intents

On each Buy click your server asks Qinio for a one-time checkout link, then redirects the shopper to
it. The link carries your return address, so Qinio's thank-you page shows a **Back to** button.

### Request

```
POST https://QINIO/api/public/SLUG/checkout-intents
Content-Type: application/json

{
  "packageId": "PACKAGE_ID",
  "returnUrl": "https://www.your-clinic.com/thanks",
  "attribution": { "utm_source": "website", "utm_campaign": "fall" }
}
```

Only `packageId` is required. `returnUrl` must be on a registered origin. No API key is needed:
the call is public and creates nothing but a short-lived link.

### Response (201)

```json
{
  "id": "6f1c…",
  "url": "https://QINIO/SLUG/buy/PACKAGE_ID?intent=6f1c…",
  "expiresAt": "2026-11-12T18:04:11.000Z"
}
```

Redirect the shopper's browser to `url` exactly as returned. Do not build it yourself: for a
business unit with its own domain, Qinio returns that domain.

### Server example (Node 18+, Express)

```js
import express from 'express';

const QINIO = 'https://app.qinio.co';
const SLUG = 'your-clinic';
const app = express();

// <a href="/buy/PACKAGE_ID?utm_source=...">Order the kit</a> on your pages points here.
app.get('/buy/:packageId', async (req, res) => {
  const attribution = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) {
    if (typeof req.query[key] === 'string') attribution[key] = req.query[key].slice(0, 200);
  }

  try {
    const response = await fetch(`${QINIO}/api/public/${SLUG}/checkout-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        packageId: req.params.packageId,
        returnUrl: 'https://www.your-clinic.com/thanks',
        attribution,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Qinio answered ${response.status}`);
    const { url } = await response.json();
    res.redirect(303, url);
  } catch (error) {
    console.error('checkout intent failed', error);
    // A static buy link still works, just without the return button.
    res.redirect(303, `${QINIO}/${SLUG}/buy/${encodeURIComponent(req.params.packageId)}`);
  }
});

app.listen(3000);
```

The same call from a terminal, for testing:

```bash
curl -sS -X POST "https://QINIO/api/public/SLUG/checkout-intents" \
  -H 'content-type: application/json' \
  --data '{"packageId":"PACKAGE_ID","returnUrl":"https://www.your-clinic.com/thanks"}'
```

### Browser variant (no server)

The call also works from page JavaScript, but only on a registered origin. Browsers on any other
origin are blocked by CORS.

```html
<button type="button" data-package="PACKAGE_ID" class="qinio-buy">Order the kit</button>
<script>
  document.querySelectorAll('.qinio-buy').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const params = new URLSearchParams(location.search);
      const attribution = {};
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) {
        if (params.get(key)) attribution[key] = params.get(key).slice(0, 200);
      }
      try {
        const response = await fetch('https://QINIO/api/public/SLUG/checkout-intents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({
            packageId: button.dataset.package,
            returnUrl: location.origin + '/thanks',
            attribution,
          }),
        });
        if (!response.ok) throw new Error(String(response.status));
        location.assign((await response.json()).url);
      } catch {
        location.assign('https://QINIO/SLUG/buy/' + button.dataset.package);
      }
    });
  });
</script>
```

### Rules

- Create a **fresh intent on every click**. Intents last 24 hours, so a cached or emailed intent
  link will expire. Use static links (option 1) for emails.
- `returnUrl` must be an https URL on a registered origin, up to 2000 characters. Anything else is
  refused with 400.
- Only the six attribution keys above are kept. Others are dropped.
- The price always comes from Qinio. Nothing in the request can change what is charged.
- **Never send shopper details** (name, email, address, health information). The endpoint does not
  accept them and your site should not handle them.
- Rate limit: 30 intents per minute per IP address. From a server, all shoppers share your
  server's address, so for heavy traffic use the browser variant, which spreads the calls across
  shoppers' addresses.

### Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | `returnUrl` is not on a registered origin, or the body is malformed | Check the origin with the admin; check `packageId` is a UUID |
| 404 | The package is not active, or the slug is wrong | Ask the admin to activate it; fall back to the storefront `https://QINIO/SLUG` |
| 410 | The intent expired (the shopper opened an old link) | Create a new intent |
| 429 | Rate limited | Retry after a minute, or fall back to the static link |
| 5xx or timeout | Qinio unavailable | Fall back to the static link |

## 5. The return page

When the shopper finishes, Qinio's thank-you page shows **Back to your-clinic.com**, which goes to
your `returnUrl` exactly as you sent it. Qinio adds nothing to it: no order number, no status, no
email.

So build a generic page, for example "Thanks for your order. Check your email to activate your
account and track your kit." Do not:

- expect or parse query parameters to tell whether a payment succeeded;
- fire a "purchase" conversion on it with order values (you do not have them; count visits instead,
  or ask the admin for the attribution tags recorded on orders in Qinio);
- show anything personal.

The shopper may also never come back (closing the tab after paying is normal), so nothing on your
side should depend on it.

## 6. Option 3: the catalog widget

Paste this where the product cards should appear, on a registered origin:

```html
<div id="qinio-catalog"></div>
<script async src="https://QINIO/embed.js"
        data-business-unit="SLUG"
        data-target="#qinio-catalog"></script>
```

| Attribute | Required | Meaning |
|---|---|---|
| `data-business-unit` | Yes | The slug |
| `data-target` | No | CSS selector for the container. Without it, cards render right after the script tag |
| `data-label` | No | Button text, default "Buy now" |
| `data-api` | No | Qinio host, default the host `embed.js` was loaded from |

What it does: lists active packages with prices, uses the business unit's brand color, and on Buy
creates a checkout intent whose return link is the page the shopper was on. It passes along the
`utm_*` and `ref` tags in your page's URL. It renders inside a closed shadow root, so your CSS does
not reach it and your scripts cannot read it. It has no events or callbacks.

If your site sends a Content Security Policy, allow the Qinio host:

```
Content-Security-Policy: script-src 'self' https://QINIO; connect-src 'self' https://QINIO
```

Merge these into your existing policy rather than replacing it. With a nonce-based `script-src`,
add the nonce to the script tag as well.

## 7. Testing

1. **Dev first.** Ask Qinio for the dev host (dev.qinio.co), a test slug, a package id, and your
   staging origin registered there. Payments on dev are not real: if the page goes to Stripe, pay
   with `4242 4242 4242 4242`, any future expiry, any CVC.
2. Check each option you use:
   - [ ] The Qinio page shows the right product and price.
   - [ ] Payment completes and the thank-you page loads.
   - [ ] Options 2 and 3: the **Back to** button returns to your `returnUrl`.
   - [ ] The admin confirms the order shows your attribution tags.
   - [ ] Widget: cards render on your origin. On any other origin it says "The catalog is not
         available right now", which is the intended refusal.
3. **Production.** Qinio runs one real $1 purchase and refund through your live site (run type C of
   [RUNBOOK-smoke-test.md](RUNBOOK-smoke-test.md)). Coordinate a time with Qinio.

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 400 "Return URL is not on this business unit's marketing-site allowlist" | Origin not registered or not exact (`www`, `http`, a port). Registration can take 30 seconds |
| Browser console shows a CORS error | The page's origin is not registered, or you called from `localhost`. Use the server variant for local development |
| 404 "Package not available" | The package is in draft or belongs to another slug |
| Shopper sees "This checkout link has expired" | An intent link was cached or emailed. Create one per click |
| No **Back to** button on the thank-you page | A static link was used, or `returnUrl` was not sent |
| "This storefront is not ready to accept payments" | The business unit has not finished connecting Stripe. The admin fixes this |
| Widget says "No kits are on sale right now" | No active packages |
| Widget does not appear and the console shows a CSP violation | Add the Qinio host to `script-src` and `connect-src` |
| Attribution missing on orders | Tags had other names, were longer than 200 characters, or were not passed through to the intent |

## 9. Go-live checklist

- [ ] Every production origin (with and without `www`) registered by the admin.
- [ ] Buy buttons point at production package ids, not dev ones.
- [ ] Option 2: a fresh intent per click, a fallback to the static link on any error, and a 5-second
      timeout.
- [ ] A generic return page that reads no query parameters and shows nothing personal.
- [ ] CSP updated, if you use the widget.
- [ ] No shopper details collected for, or sent to, Qinio.
- [ ] The production smoke run (run type C) passed.
