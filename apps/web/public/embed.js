/*
 * Qinio catalog widget. Drop it into a marketing site to list a business unit's packages with a
 * Buy button that hands the shopper to checkout on Qinio:
 *
 *   <div id="qinio-catalog"></div>
 *   <script async src="https://<qinio-host>/embed.js"
 *           data-business-unit="your-slug" data-target="#qinio-catalog"></script>
 *
 * Optional attributes: data-label="Buy now", data-api="https://<qinio-host>" (defaults to the
 * origin this script was loaded from).
 *
 * What it does and does not do:
 *  - Read-only. It fetches the public catalog and, on click, asks Qinio for a checkout link.
 *  - The page's origin must be listed under "Marketing site origins" for the business unit; the
 *    API refuses cross-origin calls from any other site.
 *  - Nothing about an order, a test, or a patient ever reaches the host page. The widget exposes no
 *    events or callbacks and renders in a closed shadow root, so the page cannot read it either.
 *  - Campaign tags (utm_* and ref) from the page URL are passed along so sales can be attributed.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var slug = script.getAttribute('data-business-unit');
  if (!slug) {
    console.error('[qinio] data-business-unit is required');
    return;
  }

  var api;
  try {
    api = new URL(script.getAttribute('data-api') || script.src).origin;
  } catch {
    console.error('[qinio] could not determine the API origin');
    return;
  }
  var buyLabel = script.getAttribute('data-label') || 'Buy now';

  var mount = null;
  var selector = script.getAttribute('data-target');
  if (selector) {
    try {
      mount = document.querySelector(selector);
    } catch {
      mount = null;
    }
  }
  if (!mount) {
    mount = document.createElement('div');
    script.parentNode.insertBefore(mount, script.nextSibling);
  }

  var root = mount.attachShadow({ mode: 'closed' });
  var HEX = /^#[0-9a-fA-F]{6}$/;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent only: catalog text is data, never markup.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function money(cents) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
      cents / 100,
    );
  }

  function attribution() {
    var params = new URLSearchParams(location.search);
    var out = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'].forEach(
      function (key) {
        var value = params.get(key);
        if (value) out[key] = value.slice(0, 200);
      },
    );
    return out;
  }

  function style(color) {
    var css = el('style');
    css.textContent =
      ':host{all:initial;display:block;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#17202a}' +
      '*{box-sizing:border-box}' +
      '.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}' +
      '.card{border:1px solid #d9dee5;border-radius:12px;padding:18px;background:#fff;display:flex;flex-direction:column;gap:10px}' +
      '.focus{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5f6b76}' +
      'h3{margin:0;font-size:18px}' +
      'p{margin:0;color:#44505c;font-size:14px}' +
      'ul{margin:0;padding-left:18px;font-size:13px;color:#44505c}' +
      '.row{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:12px}' +
      '.price{font-size:20px;font-weight:700}' +
      'button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;color:#fff;background:' +
      color +
      '}' +
      'button[disabled]{opacity:.6;cursor:default}' +
      '.note{font-size:14px;color:#5f6b76}';
    return css;
  }

  function show(message) {
    root.replaceChildren(style('#2563eb'), el('div', 'note', message));
  }

  function buy(button, pkg) {
    button.disabled = true;
    var original = button.textContent;
    button.textContent = 'One moment…';

    fetch(api + '/api/public/' + encodeURIComponent(slug) + '/checkout-intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No credentials: the call is anonymous by design.
      credentials: 'omit',
      body: JSON.stringify({
        packageId: pkg.id,
        returnUrl: location.href.split('#')[0],
        attribution: attribution(),
      }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('intent');
        return response.json();
      })
      .then(function (body) {
        // Only ever navigate to a web address Qinio itself returned.
        var target = new URL(body.url);
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('url');
        location.assign(target.href);
      })
      .catch(function () {
        button.disabled = false;
        button.textContent = original;
        window.alert('Sorry, checkout could not be started. Please try again in a moment.');
      });
  }

  function render(catalog) {
    var brand = catalog.businessUnit && catalog.businessUnit.brand;
    var color = brand && HEX.test(brand.primaryColor || '') ? brand.primaryColor : '#2563eb';
    var packages = catalog.packages || [];

    if (packages.length === 0) {
      show('No kits are on sale right now.');
      return;
    }

    var grid = el('div', 'grid');
    packages.forEach(function (pkg) {
      var card = el('div', 'card');
      card.appendChild(el('div', 'focus', pkg.focusArea || 'Health testing'));
      card.appendChild(el('h3', '', pkg.name));
      if (pkg.description) card.appendChild(el('p', '', pkg.description));

      if (pkg.tests && pkg.tests.length > 0) {
        var list = el('ul');
        pkg.tests.forEach(function (test) {
          list.appendChild(el('li', '', test.name + (test.quantity > 1 ? ' × ' + test.quantity : '')));
        });
        card.appendChild(list);
      }

      var row = el('div', 'row');
      row.appendChild(el('div', 'price', money(pkg.priceCents)));
      var button = el('button', '', buyLabel);
      button.type = 'button';
      button.addEventListener('click', function () {
        buy(button, pkg);
      });
      row.appendChild(button);
      card.appendChild(row);
      grid.appendChild(card);
    });

    root.replaceChildren(style(color), grid);
  }

  show('Loading…');
  fetch(api + '/api/public/' + encodeURIComponent(slug) + '/packages', { credentials: 'omit' })
    .then(function (response) {
      if (!response.ok) throw new Error('catalog');
      return response.json();
    })
    .then(render)
    .catch(function () {
      show('The catalog is not available right now.');
    });
})();
