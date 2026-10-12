import { describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import { assertStaffMfa } from '../auth/context.js';
import { DevAuthProvider, DEV_TOKEN_TTL_SECONDS } from '../auth/devProvider.js';
import type { AuthIdentity } from '../auth/provider.js';

function actor(provider: 'dev' | 'auth0', mfa?: boolean) {
  const identity: AuthIdentity = {
    provider,
    subject: 'sub',
    email: 'staff@example.test',
    ...(mfa === undefined ? {} : { mfa }),
  };
  return { identity };
}

describe('staff MFA guard', () => {
  const STAFF_ROLES = ['bu_admin', 'doctor', 'lab', 'fulfillment', 'platform_admin'] as const;

  it('does nothing while the flag is off', () => {
    for (const role of STAFF_ROLES) {
      expect(() => assertStaffMfa(actor('auth0', false), role, false)).not.toThrow();
    }
  });

  it('refuses every staff role on an Auth0 session without MFA when the flag is on', () => {
    for (const role of STAFF_ROLES) {
      try {
        assertStaffMfa(actor('auth0', false), role, true);
        expect.unreachable(`${role} should need MFA`);
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 403, code: 'MFA_REQUIRED' });
      }
    }
  });

  it('also refuses a token that carries no MFA claim at all', () => {
    expect(() => assertStaffMfa(actor('auth0'), 'doctor', true)).toThrow(/Multi-factor/);
  });

  it('lets an MFA session through', () => {
    for (const role of STAFF_ROLES) {
      expect(() => assertStaffMfa(actor('auth0', true), role, true)).not.toThrow();
    }
  });

  it('never blocks patients', () => {
    expect(() => assertStaffMfa(actor('auth0', false), 'patient', true)).not.toThrow();
  });

  it('exempts the dev provider, which has no MFA to offer', () => {
    expect(() => assertStaffMfa(actor('dev'), 'bu_admin', true)).not.toThrow();
  });
});

describe('dev session lifetime', () => {
  it('issues tokens that last eight hours', async () => {
    const token = await new DevAuthProvider().issueToken({
      provider: 'dev',
      subject: 'dev|someone',
      email: 'someone@example.test',
    });
    const { exp, iat } = decodeJwt(token);
    expect(DEV_TOKEN_TTL_SECONDS).toBe(8 * 60 * 60);
    expect(exp! - iat!).toBe(8 * 60 * 60);
  });
});
