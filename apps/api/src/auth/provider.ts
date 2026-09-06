/**
 * The application never talks to Auth0 directly. Everything it needs from an identity provider
 * is expressed here, so the dev implementation and the Auth0 implementation are interchangeable
 * and the rest of the codebase cannot drift towards vendor specifics.
 */
export interface AuthIdentity {
  provider: 'dev' | 'auth0';
  /** Stable provider-side subject, stored as `users.auth0_user_id`. */
  subject: string;
  email: string;
  name?: string;
  /** Auth0 Organization id, when the token was issued in an organization context. */
  orgId?: string;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export interface InviteUserInput {
  orgId: string | null;
  email: string;
  name: string;
  /** App-relative login page, including the business-unit slug used to scope Auth0 login. */
  loginPath: string;
}

export interface InvitedUser {
  subject: string;
  /**
   * One-time link for a newly provisioned user to choose their password, which also proves they
   * control the address. Absent when the user already existed and therefore already has a way in.
   * Callers must deliver it: without it the account is unreachable, since invited users are
   * created with a throwaway password nobody knows.
   */
  passwordSetUrl?: string;
  /** Stable app link the invitee can use after the one-time password ticket expires. */
  signInUrl?: string;
}

export interface AuthProvider {
  readonly name: 'dev' | 'auth0';
  /** Verifies signature, expiry, issuer and audience, and returns the caller's identity. */
  verifyToken(token: string): Promise<AuthIdentity>;
  /** A business unit maps one-to-one onto an identity-provider organization. */
  createOrganization(input: CreateOrganizationInput): Promise<{ orgId: string }>;
  /** Provisions (or looks up) the provider-side user for a business unit member. */
  inviteUser(input: InviteUserInput): Promise<InvitedUser>;
  /** Client-side configuration the SPA needs to start a login flow. */
  publicConfig(): Record<string, unknown>;
}
