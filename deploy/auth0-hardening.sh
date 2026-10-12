#!/usr/bin/env bash
# Auth0 hardening for Qinio: session limits, the OTP factor, and the MFA step-up Action.
#
# Run this yourself against the tenant; nothing here is run by the deploy. It prints what it
# would do and changes nothing until you set APPLY=1:
#
#   ./deploy/auth0-hardening.sh                # show the plan
#   APPLY=1 ./deploy/auth0-hardening.sh        # make the changes
#
# Prerequisites: the auth0 CLI, jq, and a CLI session with these scopes:
#   auth0 login --domain <tenant>.us.auth0.com --scopes \
#     'read:tenant_settings update:tenant_settings read:guardian_factors update:guardian_factors read:actions create:actions update:actions'
#
# Order of operations for turning MFA on (see COMMANDS.md, "Staff MFA"):
#   1. Run this script with APPLY=1 (deploys the Action that stamps the MFA claim).
#   2. Set REQUIRE_STAFF_MFA=true on the VM and redeploy. Each staff member is then sent through
#      Auth0 to enroll an authenticator app on their next request, and challenged after that.
#   Rollback if anyone is locked out: set REQUIRE_STAFF_MFA=false and redeploy.
set -euo pipefail

cd "$(dirname "$0")/.."

# Hours. Idle cannot exceed the absolute lifetime. Override from the environment if needed.
IDLE_SESSION_HOURS="${IDLE_SESSION_HOURS:-8}"
ABSOLUTE_SESSION_HOURS="${ABSOLUTE_SESSION_HOURS:-24}"
ACTION_NAME="${ACTION_NAME:-Add email claim}"
ACTION_FILE="deploy/auth0-post-login-action.js"

fail() { echo "error: $*" >&2; exit 1; }

(( IDLE_SESSION_HOURS <= ABSOLUTE_SESSION_HOURS )) ||
  fail "IDLE_SESSION_HOURS ($IDLE_SESSION_HOURS) cannot exceed ABSOLUTE_SESSION_HOURS ($ABSOLUTE_SESSION_HOURS)"
[[ -f "$ACTION_FILE" ]] || fail "missing $ACTION_FILE"

if [[ "${APPLY:-0}" != "1" ]]; then
  cat <<EOF
Dry run. Nothing will be changed. With APPLY=1 this will:

  1. Set tenant session limits: idle ${IDLE_SESSION_HOURS}h, absolute ${ABSOLUTE_SESSION_HOURS}h
       auth0 api patch tenants/settings
  2. Enable the one-time-password (authenticator app) MFA factor
       auth0 api put guardian/factors/otp
  3. Update and deploy the post-login Action "${ACTION_NAME}" from ${ACTION_FILE}
       (it must already be bound to the post-login flow; it is if login works today)

Re-run with APPLY=1 to proceed.
EOF
  exit 0
fi

command -v auth0 >/dev/null || fail "the auth0 CLI is not installed"
command -v jq >/dev/null || fail "jq is not installed"

echo "==> Tenant session limits (idle ${IDLE_SESSION_HOURS}h, absolute ${ABSOLUTE_SESSION_HOURS}h)"
auth0 api patch tenants/settings --data \
  "{\"idle_session_lifetime\": ${IDLE_SESSION_HOURS}, \"session_lifetime\": ${ABSOLUTE_SESSION_HOURS}}" \
  | jq '{idle_session_lifetime, session_lifetime}'

echo "==> Enabling the OTP factor"
auth0 api put guardian/factors/otp --data '{"enabled": true}' | jq .

echo "==> Updating the post-login Action: ${ACTION_NAME}"
ACTION_ID="$(
  auth0 actions list --json |
    jq -r --arg name "$ACTION_NAME" '[.[] | select(.name == $name)][0].id // empty'
)"

if [[ -z "$ACTION_ID" ]]; then
  echo "    not found; creating it"
  auth0 actions create --name "$ACTION_NAME" --trigger post-login \
    --code "$(cat "$ACTION_FILE")"
  ACTION_ID="$(
    auth0 actions list --json |
      jq -r --arg name "$ACTION_NAME" '[.[] | select(.name == $name)][0].id // empty'
  )"
  [[ -n "$ACTION_ID" ]] || fail "created the Action but could not find its id"
  echo "    created. It still has to be bound to the post-login flow in the Auth0 dashboard"
  echo "    (Actions > Triggers > post-login) before any login will use it."
else
  auth0 actions update "$ACTION_ID" --code "$(cat "$ACTION_FILE")"
fi

auth0 actions deploy "$ACTION_ID"

cat <<EOF

Done. Next:
  - Keep one browser session signed in as a platform admin until you have verified the flow.
  - Set REQUIRE_STAFF_MFA=true in ~/nio-platform/.env.production on the VM and run
    ./deploy/deploy.sh. Staff are sent to Auth0 to enroll on their next request.
  - If anyone is locked out, set REQUIRE_STAFF_MFA=false and redeploy.
EOF
