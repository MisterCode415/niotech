/* global exports */

/**
 * Auth0 post-login Action. Deploy into the tenant that AUTH0_DOMAIN points at.
 *
 * Why this is mandatory: an Auth0 access token carries no `email` claim by default, but the API
 * rejects any token without one (see verifyToken in apps/api/src/auth/auth0Provider.ts) because
 * email is how a token is matched to a row in `users` or `platform_admins`. Without this Action
 * every login fails with "Token is missing subject or email claim".
 *
 * The claim must be namespaced. Auth0 silently drops custom claims on non-namespaced keys, so
 * `email` alone would vanish and the failure would look identical to not having deployed at all.
 * The namespace below is matched literally by the API and the two must stay in step.
 *
 * Actions are tenant-wide: this runs for every application in the tenant, not just Qinio's.
 *
 * Deploy with:
 *   auth0 actions create --name "Add email claim" --trigger post-login \
 *     --code "$(cat deploy/auth0-post-login-action.js)"
 *   auth0 actions deploy <action-id>
 *
 * Creating an Action does not activate it — it has to be deployed and then bound to the
 * post-login trigger in the flow.
 */
exports.onExecutePostLogin = async (event, api) => {
  if (!event.user.email) return;

  api.accessToken.setCustomClaim('https://niotech.io/email', event.user.email);

  // The API keys authorisation on the email address, so it refuses tokens whose address is
  // unproven. Without this claim every login is rejected as unverified.
  api.accessToken.setCustomClaim(
    'https://niotech.io/email_verified',
    event.user.email_verified === true,
  );

  if (event.user.name) {
    api.accessToken.setCustomClaim('https://niotech.io/name', event.user.name);
  }

  /*
   * MFA step-up. The API cannot see how a session authenticated unless the token says so, and
   * Auth0 does not put `amr` in access tokens by default, so the Action stamps a claim. Staff
   * roles (see assertStaffMfa in apps/api/src/auth/context.ts) are refused with MFA_REQUIRED
   * when REQUIRE_STAFF_MFA=true and this claim is not true. The SPA then sends the user back
   * through login asking for the MFA authentication context below, which triggers the challenge.
   *
   * Patients log in without that request, so they are never challenged by this Action.
   */
  const MFA_ACR = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';
  const requested = event.transaction?.acr_values ?? [];
  const alreadyMfa = (event.authentication?.methods ?? []).some((method) => method.name === 'mfa');

  // Asking for the MFA context challenges the user (OTP or a recovery code). Auth0 will not issue
  // a token for this login until the challenge succeeds, so a token that exists after we asked
  // for one is a token from an MFA-verified login, and the claim can safely say so here.
  const challenged = requested.includes(MFA_ACR) && !alreadyMfa;
  if (challenged) {
    if ((event.user.enrolledFactors ?? []).length > 0) {
      api.authentication.challengeWithAny([{ type: 'otp' }, { type: 'recovery-code' }]);
    } else {
      // First staff login: enroll an authenticator app before the session can be used.
      api.authentication.enrollWith({ type: 'otp' });
    }
  }

  api.accessToken.setCustomClaim('https://niotech.io/mfa', alreadyMfa || challenged);
};
