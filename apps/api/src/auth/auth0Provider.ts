import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../env.js';
import { unauthorized, badRequest, HttpError } from '../lib/errors.js';
import type {
  AuthProvider,
  AuthIdentity,
  CreateOrganizationInput,
  InviteUserInput,
  InvitedUser,
} from './provider.js';

/** Long enough to survive a weekend and an ignored inbox, short enough to expire if leaked. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

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
    this.jwks = createRemoteJWKSet(new URL(`https://${this.config.domain}/.well-known/jwks.json`));
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

      /*
       * Authorisation here is keyed on the email address: it is matched against `platform_admins`
       * and `users` to decide what the caller may do. An unverified address is therefore a claim
       * to an identity, not proof of one — anyone able to sign up could assert a superadmin's
       * address. The tenant should also refuse self-signup, but this check has to hold on its own,
       * because a connection setting can be changed by anyone with dashboard access.
       */
      const emailVerified =
        payload.email_verified === true || payload['https://niotech.io/email_verified'] === true;

      if (!emailVerified) {
        throw unauthorized('Email address is not verified');
      }

      // Same reasoning as email: a plain `name` only survives if the API is configured to emit it,
      // so the namespaced claim the Action sets is the dependable source.
      const name =
        (typeof payload.name === 'string' && payload.name) ||
        (typeof payload['https://niotech.io/name'] === 'string' &&
          (payload['https://niotech.io/name'] as string)) ||
        undefined;

      return {
        subject: payload.sub,
        email,
        name,
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

    /*
     * Some management endpoints answer 204 with no body at all — adding an organization member is
     * one. Handing an empty string to JSON.parse throws, which would report a call that in fact
     * succeeded as a failure, so callers that ignore the result get undefined instead.
     */
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  async createOrganization(input: CreateOrganizationInput): Promise<{ orgId: string }> {
    try {
      const org = await this.management<{ id: string }>('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: input.slug, display_name: input.name }),
      });
      return { orgId: org.id };
    } catch (error) {
      /*
       * Onboarding writes to Auth0 before it writes to the database, and the tenant cannot be
       * rolled back with the transaction, so a failure partway through strands an organization.
       * Adopting the existing one lets a retry of the same slug succeed rather than wedging that
       * slug permanently behind a conflict. The database still decides whether the slug is free.
       */
      if (!(error instanceof HttpError) || !error.message.includes('(409)')) throw error;

      const existing = await this.management<{ id: string }>(
        `/organizations/name/${encodeURIComponent(input.slug)}`,
        { method: 'GET' },
      );
      return { orgId: existing.id };
    }
  }

  async inviteUser(input: InviteUserInput): Promise<InvitedUser> {
    const existing = await this.management<Array<{ user_id: string; email_verified?: boolean }>>(
      `/users-by-email?email=${encodeURIComponent(input.email)}`,
      { method: 'GET' },
    );

    const found = existing[0];
    let subject: string;
    let passwordSetUrl: string | undefined;

    if (found) {
      subject = found.user_id;

      /*
       * An unverified account belongs to an invitee who never completed their ticket, so reissue
       * one — otherwise an invite whose mail failed to send could never be repaired, since the
       * account exists from then on. A verified user already chose a password and must not be
       * sent an unsolicited reset just because someone typed their address.
       */
      if (!found.email_verified) {
        passwordSetUrl = await this.createPasswordSetUrl(found.user_id);
      }
    } else {
      /*
       * The password here is deliberately unknowable: the invitee sets their own through the
       * ticket below, which is also what verifies the address. Creating the account already
       * verified would let anyone who guessed an invited address inherit the role attached to it.
       */
      const created = await this.management<{ user_id: string }>('/users', {
        method: 'POST',
        body: JSON.stringify({
          email: input.email,
          name: input.name,
          connection: 'Username-Password-Authentication',
          email_verified: false,
          password: crypto.randomUUID() + 'Aa1!',
        }),
      });
      subject = created.user_id;
      passwordSetUrl = await this.createPasswordSetUrl(created.user_id);
    }

    if (input.orgId) {
      await this.management(`/organizations/${input.orgId}/members`, {
        method: 'POST',
        body: JSON.stringify({ members: [subject] }),
      });
    }

    return { subject, passwordSetUrl };
  }

  /**
   * Completing this ticket proves the invitee reads the address, so Auth0 marks it verified at the
   * same time as it sets the password. That is what the API's verified-email requirement rests on.
   */
  private async createPasswordSetUrl(userId: string): Promise<string> {
    const ticket = await this.management<{ ticket: string }>('/tickets/password-change', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        result_url: `${env.WEB_ORIGIN}/login`,
        mark_email_as_verified: true,
        ttl_sec: INVITE_TTL_SECONDS,
      }),
    });
    return ticket.ticket;
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
