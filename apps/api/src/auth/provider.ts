/**
 * The application never talks to Auth0 directly. Everything it needs from an identity provider
 * is expressed here, so the dev implementation and the Auth0 implementation are interchangeable
 * and the rest of the codebase cannot drift towards vendor specifics.
 */
export interface AuthIdentity {
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
}

export interface AuthProvider {
  readonly name: 'dev' | 'auth0';
  /** Verifies signature, expiry, issuer and audience, and returns the caller's identity. */
  verifyToken(token: string): Promise<AuthIdentity>;
  /** A business unit maps one-to-one onto an identity-provider organization. */
  createOrganization(input: CreateOrganizationInput): Promise<{ orgId: string }>;
  /** Provisions (or looks up) the provider-side user for a business unit member. */
  inviteUser(input: InviteUserInput): Promise<{ subject: string }>;
  /** Client-side configuration the SPA needs to start a login flow. */
  publicConfig(): Record<string, unknown>;
}
