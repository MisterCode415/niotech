import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../env.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import type {
  AuthProvider,
  AuthIdentity,
  CreateOrganizationInput,
  InviteUserInput,
} from './provider.js';

interface Auth0Config {
  domain: string;
  audience: string;
  spaClientId: string;
  m2mClientId: string;
  m2mClientSecret: string;
}

function requireConfig(): Auth0Config {
  const missing = (
    [
      ['AUTH0_DOMAIN', env.AUTH0_DOMAIN],
      ['AUTH0_AUDIENCE', env.AUTH0_AUDIENCE],
      ['AUTH0_SPA_CLIENT_ID', env.AUTH0_SPA_CLIENT_ID],
      ['AUTH0_M2M_CLIENT_ID', env.AUTH0_M2M_CLIENT_ID],
      ['AUTH0_M2M_CLIENT_SECRET', env.AUTH0_M2M_CLIENT_SECRET],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`AUTH_PROVIDER=auth0 requires: ${missing.join(', ')}`);
  }

  return {
    domain: env.AUTH0_DOMAIN!,
    audience: env.AUTH0_AUDIENCE!,
    spaClientId: env.AUTH0_SPA_CLIENT_ID!,
    m2mClientId: env.AUTH0_M2M_CLIENT_ID!,
    m2mClientSecret: env.AUTH0_M2M_CLIENT_SECRET!,
  };
}

export class Auth0Provider implements AuthProvider {
  readonly name = 'auth0' as const;
  private readonly config: Auth0Config;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private managementToken: { value: string; expiresAt: number } | null = null;

  constructor() {
    this.config = requireConfig();
    this.jwks = createRemoteJWKSet(
      new URL(`https://${this.config.domain}/.well-known/jwks.json`),
    );
  }

  async verifyToken(token: string): Promise<AuthIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: `https://${this.config.domain}/`,
        audience: this.config.audience,
      });

      // Auth0 access tokens carry email only when the API is configured to include it, so fall
      // back to the namespaced custom claim an Action would add.
      const email =
        (typeof payload.email === 'string' && payload.email) ||
        (typeof payload['https://niotech.io/email'] === 'string' &&
          (payload['https://niotech.io/email'] as string)) ||
        null;

      if (typeof payload.sub !== 'string' || !email) {
        throw unauthorized('Token is missing subject or email claim');
      }

      return {
        subject: payload.sub,
        email,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        orgId: typeof payload.org_id === 'string' ? payload.org_id : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'HttpError') throw error;
      throw unauthorized('Invalid or expired token');
    }
  }

  private async getManagementToken(): Promise<string> {
    if (this.managementToken && this.managementToken.expiresAt > Date.now() + 30_000) {
      return this.managementToken.value;
    }

    const response = await fetch(`https://${this.config.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.m2mClientId,
        client_secret: this.config.m2mClientSecret,
        audience: `https://${this.config.domain}/api/v2/`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Auth0 management token request failed: ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.managementToken = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return body.access_token;
  }

  private async management<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getManagementToken();
    const response = await fetch(`https://${this.config.domain}/api/v2${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw badRequest(`Auth0 request failed (${response.status}): ${detail}`);
    }
    return (await response.json()) as T;
  }

  async createOrganization(input: CreateOrganizationInput): Promise<{ orgId: string }> {
    const org = await this.management<{ id: string }>('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: input.slug, display_name: input.name }),
    });
    return { orgId: org.id };
  }

  async inviteUser(input: InviteUserInput): Promise<{ subject: string }> {
    const existing = await this.management<Array<{ user_id: string }>>(
      `/users-by-email?email=${encodeURIComponent(input.email)}`,
      { method: 'GET' },
    );

    const subject =
      existing[0]?.user_id ??
      (
        await this.management<{ user_id: string }>('/users', {
          method: 'POST',
          body: JSON.stringify({
            email: input.email,
            name: input.name,
            connection: 'Username-Password-Authentication',
            email_verified: false,
            password: crypto.randomUUID() + 'Aa1!',
          }),
        })
      ).user_id;

    if (input.orgId) {
      await this.management(`/organizations/${input.orgId}/members`, {
        method: 'POST',
        body: JSON.stringify({ members: [subject] }),
      });
    }

    return { subject };
  }

  publicConfig(): Record<string, unknown> {
    return {
      provider: 'auth0',
      domain: this.config.domain,
      clientId: this.config.spaClientId,
      audience: this.config.audience,
    };
  }
}
