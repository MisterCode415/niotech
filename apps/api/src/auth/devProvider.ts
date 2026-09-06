import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';
import { unauthorized } from '../lib/errors.js';
import type {
  AuthProvider,
  AuthIdentity,
  CreateOrganizationInput,
  InviteUserInput,
  InvitedUser,
} from './provider.js';

const ISSUER = 'nio-dev';
const AUDIENCE = 'nio-api';

function secret(): Uint8Array {
  return new TextEncoder().encode(env.DEV_AUTH_SECRET);
}

/**
 * Local-only identity provider so the platform runs end to end without an Auth0 tenant.
 * It mints its own HS256 tokens; the shape of what it returns is identical to the Auth0 path.
 */
export class DevAuthProvider implements AuthProvider {
  readonly name = 'dev' as const;

  async issueToken(identity: AuthIdentity, ttlSeconds = 60 * 60 * 12): Promise<string> {
    return new SignJWT({ email: identity.email, name: identity.name, org_id: identity.orgId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(secret());
  }

  async verifyToken(token: string): Promise<AuthIdentity> {
    try {
      const { payload } = await jwtVerify(token, secret(), {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw unauthorized('Token is missing subject or email');
      }
      return {
        provider: 'dev',
        subject: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        orgId: typeof payload.org_id === 'string' ? payload.org_id : undefined,
      };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  }

  async createOrganization(input: CreateOrganizationInput): Promise<{ orgId: string }> {
    return { orgId: `org_dev_${input.slug}` };
  }

  /** No password link: the dev provider mints tokens for any known email without one. */
  async inviteUser(input: InviteUserInput): Promise<InvitedUser> {
    return { subject: `dev|${input.email}` };
  }

  publicConfig(): Record<string, unknown> {
    return { provider: 'dev', loginPath: '/api/auth/dev/login' };
  }
}
