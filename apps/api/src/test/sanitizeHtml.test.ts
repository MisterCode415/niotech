import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { call, login } from './harness.js';
import { cleanCss, sanitizeMarketingHtml } from '../lib/sanitizeHtml.js';

describe('sanitizeMarketingHtml', () => {
  it('removes executable content', () => {
    const dirty = [
      '<p onclick="steal()">hi</p>',
      '<script>fetch("/x")</script>',
      '<a href="javascript:alert(1)">bad</a>',
      '<iframe src="https://evil.test"></iframe>',
      '<form action="https://evil.test"><input name="pw" type="password"></form>',
      '<img src="x" onerror="alert(1)">',
      '<object data="x"></object><embed src="x">',
    ].join('');
    const clean = sanitizeMarketingHtml(dirty);
    expect(clean).not.toMatch(/<script|onclick|onerror|javascript:|<iframe|<form|<object|<embed/i);
    expect(clean).not.toContain('type="password"');
    expect(clean).toContain('hi');
  });

  it('keeps layout, styles, radio controls, and labels', () => {
    const clean = sanitizeMarketingHtml(
      '<style>#a:checked ~ .b{color:red}</style><div id="a" class="x" style="color:blue">' +
        '<input type="radio" name="g" id="r1" checked><label for="r1">One</label>' +
        '<a href="https://example.com" target="_blank">ok</a></div>',
    );
    expect(clean).toContain('<style>#a:checked ~ .b{color:red}</style>');
    expect(clean).toContain('type="radio"');
    expect(clean).toContain('<label for="r1">One</label>');
    expect(clean).toContain('style="color:blue"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('turns non-checkable inputs into inert controls', () => {
    const clean = sanitizeMarketingHtml('<input type="text" name="card"><input type="password">');
    expect(clean).not.toContain('type="text"');
    expect(clean).not.toContain('type="password"');
    expect(clean).not.toContain('name="card"');
  });

  it('scrubs risky CSS but keeps https and data-image urls', () => {
    expect(cleanCss('@import url(https://evil.test/a.css); a{color:red}')).not.toContain('@import');
    expect(cleanCss('a{background:url(javascript:alert(1))}')).toContain('none');
    expect(cleanCss('a{width:expression(alert(1))}')).not.toContain('expression(');
    expect(cleanCss('a{background:url(http://tracker.test/p.gif)}')).toContain('none');
    expect(cleanCss('a{background:url(https://cdn.test/p.png)}')).toContain('https://cdn.test/p.png');
    const attr = sanitizeMarketingHtml('<div style="background:url(javascript:alert(1))">x</div>');
    expect(attr).not.toContain('javascript');
  });

  it('only allows https or data images', () => {
    const clean = sanitizeMarketingHtml(
      '<img src="http://a.test/x.png"><img src="https://a.test/x.png"><img src="javascript:1">',
    );
    expect(clean).not.toContain('http://a.test');
    expect(clean).not.toContain('javascript');
    expect(clean).toContain('https://a.test/x.png');
  });

  it('keeps the interactive storefront template working without its script', () => {
    const template = readFileSync(
      new URL('../../../../text/storefront-interactive.html', import.meta.url),
      'utf8',
    );
    const clean = sanitizeMarketingHtml(template);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toContain('<style>');
    expect(clean).toContain('type="radio"');
  });
});

describe('marketing page routes', () => {
  let app: FastifyInstance;
  let admin: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await login(app, 'admin@vitality.test');
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('sanitizes on save and when the public page is read', async () => {
    const before = await call<{
      published: { title: string; headline: string | null; bodyHtml: string } | null;
    }>(app, { method: 'GET', url: '/api/bu/vitality/marketing-page', token: admin });

    try {
      const saved = await call<{ page: { bodyHtml: string } }>(app, {
        method: 'PUT',
        url: '/api/bu/vitality/marketing-page',
        token: admin,
        payload: {
          title: 'Sanitizer check',
          bodyHtml: '<h2>Safe</h2><script>alert(1)</script><p onclick="x()">text</p>',
          publish: true,
        },
      });
      expect(saved.page.bodyHtml).toContain('<h2>Safe</h2>');
      expect(saved.page.bodyHtml).not.toMatch(/<script|onclick/i);

      const pub = await app
        .inject({ method: 'GET', url: '/api/public/vitality/page' })
        .then((r) => r.json() as { page: { bodyHtml: string } });
      expect(pub.page.bodyHtml).toContain('<h2>Safe</h2>');
      expect(pub.page.bodyHtml).not.toMatch(/<script|onclick/i);
    } finally {
      if (before.published) {
        await call(app, {
          method: 'PUT',
          url: '/api/bu/vitality/marketing-page',
          token: admin,
          payload: {
            title: before.published.title,
            headline: before.published.headline ?? undefined,
            bodyHtml: before.published.bodyHtml,
            publish: true,
          },
        });
      }
    }
  });
});
