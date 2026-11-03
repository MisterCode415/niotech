import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { closeDb } from '../db/client.js';
import { env } from '../env.js';
import type * as Notifications from '../services/notifications.js';

const sendSalesLeadEmail = vi.hoisted(() => vi.fn());

vi.mock('../services/notifications.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  sendSalesLeadEmail,
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

afterEach(() => {
  sendSalesLeadEmail.mockReset();
});

const valid = {
  name: 'Ada Lovelace',
  email: 'Ada@Example.com',
  company: 'Analytical Labs',
  website: 'https://analytical.example',
  model: 'managed',
  message: 'We want to sell a thyroid panel kit to wellness clients.',
};

// Each test uses its own forwarded address so the per-IP rate limit never couples them together.
let counter = 0;
function post(payload: Record<string, unknown>) {
  counter += 1;
  return app.inject({
    method: 'POST',
    url: '/api/public/leads',
    remoteAddress: `10.9.0.${counter}`,
    payload,
  });
}

describe('POST /api/public/leads', () => {
  it('mails a valid lead to the sales inbox and normalises the email', async () => {
    sendSalesLeadEmail.mockResolvedValue(undefined);

    const response = await post(valid);

    expect(response.statusCode).toBe(202);
    expect(sendSalesLeadEmail).toHaveBeenCalledTimes(1);
    const call = sendSalesLeadEmail.mock.calls[0]![0];
    expect(call.to).toBeTruthy();
    expect(call.lead.email).toBe('ada@example.com');
    expect(call.lead.company).toBe('Analytical Labs');
    expect(call.lead).not.toHaveProperty('company_url');
  });

  it('accepts a lead without a website', async () => {
    sendSalesLeadEmail.mockResolvedValue(undefined);
    const { website: _website, ...withoutWebsite } = valid;

    const response = await post(withoutWebsite);

    expect(response.statusCode).toBe(202);
    expect(sendSalesLeadEmail.mock.calls[0]![0].lead.website).toBeUndefined();
  });

  it('rejects an invalid email, a short message, an unknown model, and a non-http website', async () => {
    for (const bad of [
      { ...valid, email: 'not-an-email' },
      { ...valid, message: 'too short' },
      { ...valid, model: 'free-trial' },
      { ...valid, website: 'javascript:alert(1)' },
      { ...valid, name: '' },
    ]) {
      const response = await post(bad);
      expect(response.statusCode).toBe(400);
    }
    expect(sendSalesLeadEmail).not.toHaveBeenCalled();
  });

  it('collapses newlines in single-line fields so they cannot reach a mail header', async () => {
    sendSalesLeadEmail.mockResolvedValue(undefined);

    const response = await post({ ...valid, company: 'Evil\r\nBcc: victim@example.com' });

    expect(response.statusCode).toBe(202);
    expect(sendSalesLeadEmail.mock.calls[0]![0].lead.company).toBe('Evil Bcc: victim@example.com');
  });

  it('answers a honeypot hit like a real lead but sends nothing', async () => {
    const response = await post({ ...valid, company_url: 'http://spam.example' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });
    expect(sendSalesLeadEmail).not.toHaveBeenCalled();
  });

  it('tells the visitor to retry when mail delivery fails', async () => {
    sendSalesLeadEmail.mockRejectedValue(new Error('smtp down'));

    const response = await post(valid);

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('smtp down');
  });

  it('allows the marketing origin on this route only, without credentials', async () => {
    const previous = env.MARKETING_SITE_ORIGIN;
    env.MARKETING_SITE_ORIGIN = 'https://www.example.com';
    try {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/public/leads',
        headers: {
          origin: 'https://www.example.com',
          'access-control-request-method': 'POST',
        },
      });
      expect(preflight.headers['access-control-allow-origin']).toBe('https://www.example.com');
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

      const other = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin: 'https://www.example.com' },
      });
      expect(other.headers['access-control-allow-origin']).not.toBe('https://www.example.com');
    } finally {
      env.MARKETING_SITE_ORIGIN = previous;
    }
  });

  it('rate limits repeated submissions from one address', async () => {
    sendSalesLeadEmail.mockResolvedValue(undefined);
    counter += 1;
    const remoteAddress = `10.9.1.${counter}`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/public/leads',
        remoteAddress,
        payload: valid,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
