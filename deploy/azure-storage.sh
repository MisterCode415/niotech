#!/usr/bin/env bash
# Provision encrypted, recoverable storage for PHI. Two storage accounts, because Azure refuses a
# write-once policy on any account that has blob point-in-time restore enabled:
#
#   PDF account    (GRS, private, Entra-only)   container phi-files
#                  versioning, 30-day soft delete, 29-day point-in-time restore
#   Backup account (GRS, private, Entra-only)   container db-backups
#                  monthly pg_dump files, write-once for 7 years, tiered to Cool/Archive
#   VM managed identity ── Storage Blob Data Contributor on those two containers only
#
# Re-runnable: every step is skipped or converged if it already exists. Nothing here deletes data.
# Requires the Azure CLI, logged in with `az login` (as an Owner or equivalent on the resource
# group), and a stack created by deploy/azure-provision.sh.
#
# Optional: CMK=1 puts both accounts' encryption key in your own Key Vault (purge-protected). The
# dev stack does not need it; Microsoft-managed keys already encrypt at rest. Use CMK=1 when
# building the production stack.
set -euo pipefail

cd "$(dirname "$0")/.."

SECRETS_FILE="deploy/.azure-secrets"
fail() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
exists() { "$@" >/dev/null 2>&1; }
secret() { grep -E "^$1=" "$SECRETS_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

command -v az >/dev/null || fail "the Azure CLI is not installed"
az account show >/dev/null 2>&1 || fail "not logged in; run: az login"

PREFIX="${PREFIX:-$(secret PREFIX)}"; PREFIX="${PREFIX:-nio}"
LOCATION="${LOCATION:-$(secret LOCATION)}"; LOCATION="${LOCATION:-eastus}"
RG="${RG:-${PREFIX}-rg}"
VM_NAME="${VM_NAME:-${PREFIX}-app}"
VNET="${PREFIX}-vnet"
APP_SUBNET="${PREFIX}-app-subnet"

SUFFIX="$(az account show --query id -o tsv | tr -d '-' | cut -c1-6)"
# Account names: 3-24 characters, lowercase letters and digits, globally unique.
CLEAN_PREFIX="$(tr -dc 'a-z0-9' <<<"$PREFIX")"
SA_NAME="${SA_NAME:-${CLEAN_PREFIX}phi${SUFFIX}}"; SA_NAME="${SA_NAME:0:24}"
BK_NAME="${BK_NAME:-${CLEAN_PREFIX}bak${SUFFIX}}"; BK_NAME="${BK_NAME:0:24}"
PHI_CONTAINER="${PHI_CONTAINER:-phi-files}"
BACKUP_CONTAINER="${BACKUP_CONTAINER:-db-backups}"

SOFT_DELETE_DAYS=30
PITR_DAYS=29                      # must be shorter than SOFT_DELETE_DAYS
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-2555}"   # 7 years
CMK="${CMK:-0}"
KV_NAME="${KV_NAME:-${CLEAN_PREFIX}kv${SUFFIX}}"; KV_NAME="${KV_NAME:0:24}"
KEY_NAME="${KEY_NAME:-nio-phi-cmk}"
CMK_IDENTITY="${PREFIX}-storage-cmk-id"

exists az group show -n "$RG" || fail "resource group $RG not found; run deploy/azure-provision.sh first"
exists az vm show -g "$RG" -n "$VM_NAME" || fail "VM $VM_NAME not found in $RG"

OPERATOR_IP="${OPERATOR_IP:-$(curl -fsS https://ifconfig.me 2>/dev/null || true)}"

cat <<PLAN
Subscription:     $(az account show --query name -o tsv)
Resource group:   $RG ($LOCATION)
PDF account:      $SA_NAME  container $PHI_CONTAINER (versioning, ${SOFT_DELETE_DAYS}-day soft delete, ${PITR_DAYS}-day point-in-time restore)
Backup account:   $BK_NAME  container $BACKUP_CONTAINER (write-once ${BACKUP_RETENTION_DAYS} days, UNLOCKED until you lock it)
Both accounts:    Standard_GRS, shared-key access off, public network default-deny
VM identity:      $VM_NAME gets Storage Blob Data Contributor on those two containers
Encryption key:   $([[ "$CMK" == "1" ]] && echo "customer-managed, Key Vault $KV_NAME" || echo "Microsoft-managed")
Operator access:  ${OPERATOR_IP:-none} added to both storage firewalls so you can run restores from here
PLAN
echo
read -r -p "Create or converge these resources? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 0

step "Resource provider"
az provider register --namespace Microsoft.Storage --wait

# --- Storage accounts ----------------------------------------------------------------------
create_account() {
  local name="$1"
  if exists az storage account show -g "$RG" -n "$name"; then
    echo "    $name exists"
  else
    # Created with the firewall open so the containers can be made below; it is closed at the end.
    az storage account create -g "$RG" -n "$name" -l "$LOCATION" \
      --sku Standard_GRS --kind StorageV2 --access-tier Hot \
      --https-only true --min-tls-version TLS1_2 \
      --allow-blob-public-access false --allow-shared-key-access false \
      --default-action Allow -o none
    echo "    $name created"
  fi
}
create_container() {
  local account="$1" container="$2"
  if exists az storage container-rm show --storage-account "$account" -g "$RG" --name "$container"; then
    echo "    $account/$container exists"
  else
    az storage container-rm create --storage-account "$account" -g "$RG" --name "$container" \
      --public-access off -o none
    echo "    $account/$container created"
  fi
}

step "Storage accounts"
create_account "$SA_NAME"
create_account "$BK_NAME"
SA_ID="$(az storage account show -g "$RG" -n "$SA_NAME" --query id -o tsv)"
BK_ID="$(az storage account show -g "$RG" -n "$BK_NAME" --query id -o tsv)"
SA_URL="$(az storage account show -g "$RG" -n "$SA_NAME" --query primaryEndpoints.blob -o tsv)"; SA_URL="${SA_URL%/}"

# --- PDF account data protection -----------------------------------------------------------
step "PDF account: versioning, soft delete, and point-in-time restore"
az storage account blob-service-properties update -g "$RG" --account-name "$SA_NAME" \
  --enable-versioning true --enable-change-feed true \
  --enable-delete-retention true --delete-retention-days "$SOFT_DELETE_DAYS" \
  --enable-container-delete-retention true --container-delete-retention-days "$SOFT_DELETE_DAYS" \
  --enable-restore-policy true --restore-days "$PITR_DAYS" -o none

step "Backup account: soft delete (no versioning or point-in-time restore, which block write-once)"
az storage account blob-service-properties update -g "$RG" --account-name "$BK_NAME" \
  --enable-delete-retention true --delete-retention-days "$SOFT_DELETE_DAYS" \
  --enable-container-delete-retention true --container-delete-retention-days "$SOFT_DELETE_DAYS" -o none

step "Containers"
create_container "$SA_NAME" "$PHI_CONTAINER"
create_container "$BK_NAME" "$BACKUP_CONTAINER"

step "Write-once policy on $BK_NAME/$BACKUP_CONTAINER (${BACKUP_RETENTION_DAYS} days, not locked)"
if [[ -n "$(az storage container immutability-policy show --account-name "$BK_NAME" -g "$RG" \
      --container-name "$BACKUP_CONTAINER" --query etag -o tsv 2>/dev/null || true)" ]]; then
  echo "    policy exists (inspect with: az storage container immutability-policy show ...)"
else
  az storage container immutability-policy create --account-name "$BK_NAME" -g "$RG" \
    --container-name "$BACKUP_CONTAINER" --period "$BACKUP_RETENTION_DAYS" -o none
fi

step "Lifecycle: tier monthly dumps to Cool (30 days) and Archive (180 days); never delete"
POLICY="$(mktemp)"
cat > "$POLICY" <<JSON
{
  "rules": [
    {
      "enabled": true,
      "name": "db-backups-tiering",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": { "daysAfterModificationGreaterThan": 30 },
            "tierToArchive": { "daysAfterModificationGreaterThan": 180 }
          }
        },
        "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["${BACKUP_CONTAINER}/"] }
      }
    }
  ]
}
JSON
az storage account management-policy create --account-name "$BK_NAME" -g "$RG" \
  --policy "@$POLICY" -o none
rm -f "$POLICY"

# --- Identity and roles --------------------------------------------------------------------
step "VM managed identity"
VM_PRINCIPAL="$(az vm identity assign -g "$RG" -n "$VM_NAME" --query systemAssignedIdentity -o tsv)"
[[ -n "$VM_PRINCIPAL" ]] || fail "could not read the VM's managed identity"
assign_role() {
  az role assignment create --assignee-object-id "$VM_PRINCIPAL" \
    --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" --scope "$1" -o none
  echo "    $2: Storage Blob Data Contributor"
}
assign_role "$SA_ID/blobServices/default/containers/$PHI_CONTAINER" "$SA_NAME/$PHI_CONTAINER"
assign_role "$BK_ID/blobServices/default/containers/$BACKUP_CONTAINER" "$BK_NAME/$BACKUP_CONTAINER"

# Owner on the resource group does not include blob data access, so without this the runbook's
# list and restore commands fail from the operator's own login.
step "Operator access to blob data (for the runbook's list and restore commands)"
OPERATOR_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
if [[ -n "$OPERATOR_ID" ]]; then
  for scope_label in "$SA_ID/blobServices/default/containers/$PHI_CONTAINER|$SA_NAME/$PHI_CONTAINER" \
                     "$BK_ID/blobServices/default/containers/$BACKUP_CONTAINER|$BK_NAME/$BACKUP_CONTAINER"; do
    az role assignment create --assignee-object-id "$OPERATOR_ID" --assignee-principal-type User \
      --role "Storage Blob Data Contributor" --scope "${scope_label%%|*}" -o none
    echo "    ${scope_label##*|}: Storage Blob Data Contributor (you)"
  done
else
  echo "    could not read the signed-in user; grant yourself Storage Blob Data Contributor manually"
fi

# --- Optional customer-managed key ---------------------------------------------------------
if [[ "$CMK" == "1" ]]; then
  step "Customer-managed key in Key Vault $KV_NAME"
  if ! exists az keyvault show -n "$KV_NAME"; then
    az keyvault create -n "$KV_NAME" -g "$RG" -l "$LOCATION" \
      --enable-rbac-authorization true --enable-purge-protection true --retention-days 90 -o none
  fi
  KV_ID="$(az keyvault show -n "$KV_NAME" --query id -o tsv)"
  KV_URI="$(az keyvault show -n "$KV_NAME" --query properties.vaultUri -o tsv)"

  if ! exists az identity show -g "$RG" -n "$CMK_IDENTITY"; then
    az identity create -g "$RG" -n "$CMK_IDENTITY" -l "$LOCATION" -o none
  fi
  ID_RESOURCE="$(az identity show -g "$RG" -n "$CMK_IDENTITY" --query id -o tsv)"
  ID_PRINCIPAL="$(az identity show -g "$RG" -n "$CMK_IDENTITY" --query principalId -o tsv)"

  ME="$(az ad signed-in-user show --query id -o tsv)"
  az role assignment create --assignee-object-id "$ME" --assignee-principal-type User \
    --role "Key Vault Crypto Officer" --scope "$KV_ID" -o none
  az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Crypto Service Encryption User" --scope "$KV_ID" -o none
  echo "    waiting for role assignments to propagate"
  sleep 60

  if ! exists az keyvault key show --vault-name "$KV_NAME" -n "$KEY_NAME"; then
    az keyvault key create --vault-name "$KV_NAME" -n "$KEY_NAME" --kty RSA --size 3072 -o none
  fi
  # No key version is pinned, so storage follows the newest version after a rotation.
  for account in "$SA_NAME" "$BK_NAME"; do
    az storage account update -g "$RG" -n "$account" \
      --identity-type UserAssigned --user-identity-id "$ID_RESOURCE" \
      --encryption-key-source Microsoft.Keyvault \
      --encryption-key-vault "$KV_URI" --encryption-key-name "$KEY_NAME" \
      --key-vault-user-identity-id "$ID_RESOURCE" -o none
    echo "    $account encrypted with $KV_URI keys/$KEY_NAME"
  done
fi

# --- Network lockdown ----------------------------------------------------------------------
step "Network rules: only the app subnet (and this machine) can reach the accounts"
az network vnet subnet update -g "$RG" --vnet-name "$VNET" -n "$APP_SUBNET" \
  --service-endpoints Microsoft.Storage -o none
APP_SUBNET_ID="$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$APP_SUBNET" --query id -o tsv)"
for account in "$SA_NAME" "$BK_NAME"; do
  az storage account network-rule add -g "$RG" --account-name "$account" --subnet "$APP_SUBNET_ID" -o none
  if [[ -n "$OPERATOR_IP" ]]; then
    az storage account network-rule add -g "$RG" --account-name "$account" --ip-address "$OPERATOR_IP" -o none
  fi
  az storage account update -g "$RG" -n "$account" --default-action Deny --bypass AzureServices -o none
done

cat <<DONE

────────────────────────────────────────────────────────────────────────────
Storage ready.

  PDF account     $SA_NAME   ($SA_URL)
  Backup account  $BK_NAME

1. Put this in .env.production on the VM:

   STORAGE_DRIVER=azure_blob
   AZURE_STORAGE_ACCOUNT_URL=$SA_URL
   AZURE_STORAGE_CONTAINER=$PHI_CONTAINER

2. Follow the cutover steps in RUNBOOK-backup-restore.md (deploy, then pnpm storage:migrate).

3. Install the monthly database dump on the VM (deploy/install-backup-timer.sh). Use:

   STORAGE_ACCOUNT=$BK_NAME   BACKUP_CONTAINER=$BACKUP_CONTAINER

4. After the first dump succeeds, lock the write-once policy. This is IRREVERSIBLE: until then
   the policy is not enforced against deletion. See RUNBOOK-backup-restore.md.
$([[ "$CMK" == "1" ]] && cat <<CMKNOTE

Key rotation:  az keyvault key rotate --vault-name $KV_NAME -n $KEY_NAME
CMKNOTE
)
────────────────────────────────────────────────────────────────────────────
DONE
