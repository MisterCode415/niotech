#!/usr/bin/env bash
# Provision Azure Communication Services email and print ready-to-paste SMTP settings.
#
#   Email Communication Service ── Azure-managed domain (<guid>.azurecomm.net)
#              │ linked
#   Communication Services resource ──┬── SMTP username  ─┐
#                                     └── role assignment │ Entra app + client secret
#
# ACS authenticates SMTP with an Entra application, so this creates one, grants it access to the
# Communication Services resource, and registers a short SMTP username against it.
#
# Re-runnable: every step is skipped if the resource already exists.
# Run deploy/azure-provision.sh first, or set RG to an existing resource group.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Settings ------------------------------------------------------------------------------
SECRETS_FILE="deploy/.azure-secrets"

# azure-provision.sh records the prefix it actually used. Reading it back matters because a
# retry in a fresh resource group changes the prefix, and defaulting to "nio" would then point
# this script at a resource group that no longer exists.
saved() {
  [[ -f "$SECRETS_FILE" ]] || return 0
  { grep -m1 "^$1=" "$SECRETS_FILE" 2>/dev/null || true; } | cut -d= -f2-
}

PREFIX="${PREFIX:-$(saved PREFIX)}"
PREFIX="${PREFIX:-nio}"
RG="${RG:-${PREFIX}-rg}"
# Where message content is stored. Not the same thing as the VM's region, and it cannot be
# changed after creation. Match it to the data residency you need.
DATA_LOCATION="${DATA_LOCATION:-UnitedStates}"

EMAIL_SVC="${PREFIX}-email"
ACS_NAME="${PREFIX}-acs"
APP_NAME="${PREFIX}-smtp-relay"
# Azure gives the SMTP username both an ARM resource name and the actual login value, and rejects
# creation if those two strings are identical. Keep both short because the legacy generated login
# could exceed SMTP clients' username limits.
SMTP_USERNAME_RESOURCE="${SMTP_USERNAME_RESOURCE:-${PREFIX}-mailer}"
SMTP_USERNAME="${SMTP_USERNAME:-${PREFIX}-smtp}"

SECRETS_FILE="deploy/.azure-secrets"

# --- Helpers -------------------------------------------------------------------------------
fail() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
exists() { "$@" >/dev/null 2>&1; }

save_secret() {
  local key="$1" value="$2"
  touch "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  # Replace any existing entry for this key rather than leaving a stale duplicate behind.
  { grep -v "^${key}=" "$SECRETS_FILE" || true; } > "${SECRETS_FILE}.tmp"
  mv "${SECRETS_FILE}.tmp" "$SECRETS_FILE"
  echo "${key}=${value}" >> "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

# --- Preflight -----------------------------------------------------------------------------
command -v az >/dev/null || fail "the Azure CLI is not installed"
az account show >/dev/null 2>&1 || fail "not logged in; run: az login"
exists az group show -n "$RG" || fail "resource group '$RG' does not exist (run deploy/azure-provision.sh first, or set RG)"

step "Ensuring the communication CLI extension is present"
az extension add --name communication --only-show-errors 2>/dev/null || true

step "Resource provider"
if [[ "$(az provider show -n Microsoft.Communication --query registrationState -o tsv 2>/dev/null || echo Unknown)" == "Registered" ]]; then
  echo "    Microsoft.Communication: registered"
else
  echo "    Microsoft.Communication: registering (this can take a minute)"
  az provider register --namespace Microsoft.Communication --wait
fi

TENANT_ID="$(az account show --query tenantId -o tsv)"

# --- Email Communication Service -----------------------------------------------------------
step "Email Communication Service"
if exists az communication email show -n "$EMAIL_SVC" -g "$RG"; then
  echo "    exists"
else
  az communication email create -n "$EMAIL_SVC" -g "$RG" \
    --location Global --data-location "$DATA_LOCATION" -o none
fi

step "Azure-managed domain"
if exists az communication email domain show --domain-name AzureManagedDomain \
    --email-service-name "$EMAIL_SVC" -g "$RG"; then
  echo "    exists"
else
  # An Azure-managed domain is verified instantly and needs no DNS records, but the sender
  # address is fixed at donotreply@<guid>.azurecomm.net and sending limits are low. A custom
  # domain (--domain-management CustomerManaged) requires SPF and DKIM records you publish.
  az communication email domain create --domain-name AzureManagedDomain \
    --email-service-name "$EMAIL_SVC" -g "$RG" \
    --location Global --domain-management AzureManaged -o none
fi

DOMAIN_ID="$(az communication email domain show --domain-name AzureManagedDomain \
  --email-service-name "$EMAIL_SVC" -g "$RG" --query id -o tsv)"
SENDER_DOMAIN="$(az communication email domain show --domain-name AzureManagedDomain \
  --email-service-name "$EMAIL_SVC" -g "$RG" --query fromSenderDomain -o tsv)"

# --- Communication Services resource -------------------------------------------------------
step "Communication Services resource"
if exists az communication show -n "$ACS_NAME" -g "$RG"; then
  echo "    exists"
else
  az communication create -n "$ACS_NAME" -g "$RG" \
    --location Global --data-location "$DATA_LOCATION" -o none
fi

step "Linking the domain to the Communication Services resource"
az communication update -n "$ACS_NAME" -g "$RG" --linked-domains "$DOMAIN_ID" -o none

ACS_ID="$(az communication show -n "$ACS_NAME" -g "$RG" --query id -o tsv)"

# --- Entra application ---------------------------------------------------------------------
step "Entra application for SMTP authentication"
APP_ID="$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)"
if [[ -n "$APP_ID" ]]; then
  echo "    exists ($APP_ID)"
  APP_SECRET="$(grep -E '^SMTP_PASS=' "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -z "$APP_SECRET" ]]; then
    echo "    secret not in $SECRETS_FILE; issuing a new one"
    APP_SECRET="$(az ad app credential reset --id "$APP_ID" --append --years 1 --query password -o tsv)"
    save_secret SMTP_PASS "$APP_SECRET"
  fi
else
  # Many corporate tenants block self-service app registration. If this fails with an
  # authorisation error, an administrator has to create the app.
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
  APP_SECRET="$(az ad app credential reset --id "$APP_ID" --append --years 1 --query password -o tsv)"
  save_secret SMTP_PASS "$APP_SECRET"
  echo "    created ($APP_ID); secret written to $SECRETS_FILE"
fi

step "Service principal"
SP_OBJECT_ID="$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv 2>/dev/null || true)"
if [[ -n "$SP_OBJECT_ID" ]]; then
  echo "    exists"
else
  SP_OBJECT_ID="$(az ad sp create --id "$APP_ID" --query id -o tsv)"
  echo "    created; waiting for directory replication"
  sleep 20
fi

step "Granting the application access to the Communication Services resource"
# The scope must be the Communication Services resource itself. A role granted on the resource
# group, the subscription, or the Email Communication Service does not work.
if az role assignment list --assignee "$APP_ID" --scope "$ACS_ID" \
     --query "[0].id" -o tsv 2>/dev/null | grep -q .; then
  echo "    already assigned"
else
  az role assignment create \
    --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
    --role "Communication and Email Service Owner" \
    --scope "$ACS_ID" -o none
fi

# --- SMTP username -------------------------------------------------------------------------
step "SMTP username"
if exists az communication smtp-username show --comm-service-name "$ACS_NAME" \
    -g "$RG" --smtp-username "$SMTP_USERNAME_RESOURCE"; then
  echo "    exists"
else
  az communication smtp-username create \
    -g "$RG" --comm-service-name "$ACS_NAME" \
    --smtp-username "$SMTP_USERNAME_RESOURCE" \
    --username "$SMTP_USERNAME" \
    --entra-application-id "$APP_ID" \
    --tenant-id "$TENANT_ID" -o none
fi

save_secret SMTP_USER "$SMTP_USERNAME"

# --- Summary -------------------------------------------------------------------------------
cat <<SUMMARY

────────────────────────────────────────────────────────────────────────────
Email provisioned. Add these to .env.production on the VM:

SMTP_HOST=smtp.azurecomm.net
SMTP_PORT=587
SMTP_USER=${SMTP_USERNAME}
SMTP_PASS=${APP_SECRET}
SMTP_FROM="NIO Tech <donotreply@${SENDER_DOMAIN}>"

Credentials are also in $SECRETS_FILE (gitignored, chmod 600).

Notes:

  - The client secret above expires in 1 year. Rotate with:
      az ad app credential reset --id $APP_ID --append --years 1

  - Azure-managed domains are rate limited and meant for testing. The sender address is fixed
    at donotreply@${SENDER_DOMAIN} and cannot be changed. For a real sender address, add a
    custom domain with --domain-management CustomerManaged and publish its SPF and DKIM records.

  - New Communication Services resources start with a low sending quota. Raise it through
    Azure support before relying on this for anything beyond a test.

  - Role assignments can take a minute to propagate. If the first send returns
    "535 authentication unsuccessful", wait and retry before assuming the config is wrong.
────────────────────────────────────────────────────────────────────────────
SUMMARY
