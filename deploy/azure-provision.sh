#!/usr/bin/env bash
# Provision the Azure resources for a NIO Tech deployment:
#
#   VNet ─┬─ app subnet  ── NSG (80/443/22 from ADMIN_CIDR only) ── Ubuntu VM ── public IP
#         └─ db subnet   ── delegated ── PostgreSQL Flexible Server (private, no public endpoint)
#
# Re-runnable: every step is skipped if the resource already exists.
# Requires the Azure CLI, logged in with `az login` and the right subscription selected.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Settings ------------------------------------------------------------------------------
PREFIX="${PREFIX:-nio}"
LOCATION="${LOCATION:-eastus}"
RG="${RG:-${PREFIX}-rg}"

VM_SIZE="${VM_SIZE:-Standard_B2s}"          # 2 vCPU / 4 GiB, enough to build the images
VM_IMAGE="${VM_IMAGE:-Canonical:ubuntu-24_04-lts:server:latest}"
VM_ADMIN="${VM_ADMIN:-azureuser}"
OS_DISK_GB="${OS_DISK_GB:-64}"

PG_TIER="${PG_TIER:-Burstable}"
PG_SKU="${PG_SKU:-Standard_B1ms}"           # 1 vCPU / 2 GiB
PG_STORAGE_GB="${PG_STORAGE_GB:-32}"
PG_VERSION="${PG_VERSION:-17}"              # drop to 16 if the region has not got 17 yet
PG_ADMIN="${PG_ADMIN:-nioadmin}"
PG_DATABASE="${PG_DATABASE:-nio}"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa.pub}"

VNET="${PREFIX}-vnet"
APP_SUBNET="${PREFIX}-app-subnet"
DB_SUBNET="${PREFIX}-db-subnet"
NSG="${PREFIX}-app-nsg"
VM_NAME="${PREFIX}-app"
PUBLIC_IP="${PREFIX}-ip"

# Flexible Server names are globally unique, so a stable suffix is derived from the subscription.
SUFFIX="$(az account show --query id -o tsv 2>/dev/null | tr -d '-' | cut -c1-6)"
PG_NAME="${PG_NAME:-${PREFIX}-db-${SUFFIX}}"
DNS_ZONE="${PG_NAME}.private.postgres.database.azure.com"

SECRETS_FILE="deploy/.azure-secrets"

# --- Preflight -----------------------------------------------------------------------------
fail() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }
exists() { "$@" >/dev/null 2>&1; }

# Shared with azure-email.sh, so entries are replaced by key rather than the file overwritten.
save_secret() {
  local key="$1" value="$2"
  mkdir -p deploy
  touch "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  { grep -v "^${key}=" "$SECRETS_FILE" || true; } > "${SECRETS_FILE}.tmp"
  mv "${SECRETS_FILE}.tmp" "$SECRETS_FILE"
  echo "${key}=${value}" >> "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
}

command -v az >/dev/null || fail "the Azure CLI is not installed"
az account show >/dev/null 2>&1 || fail "not logged in; run: az login"
[[ -f "$SSH_KEY" ]] || fail "no SSH public key at $SSH_KEY (generate one with ssh-keygen, or set SSH_KEY)"

# Everything is locked to this address range. Without it the deployment would be reachable by
# anyone, and the login endpoint issues superadmin tokens without a password.
if [[ -z "${ADMIN_CIDR:-}" ]]; then
  DETECTED="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
  [[ -n "$DETECTED" ]] || fail "could not detect your IP; set ADMIN_CIDR explicitly (e.g. ADMIN_CIDR=203.0.113.42/32)"
  ADMIN_CIDR="${DETECTED}/32"
  echo "Detected your address as ${ADMIN_CIDR}. Override with ADMIN_CIDR if you need a wider range."
fi

# --- Region and size availability ----------------------------------------------------------
# Subscriptions are gated out of high-demand regions and VM sizes independently of quota. At
# creation time this surfaces as "location is restricted", a baffling "Version should be in: []",
# or SkuNotAvailable, each leaving a half-built stack behind. Both APIs report the gating up
# front, so check first. A region only counts if it offers *both* a Flexible Server and a VM to
# put in front of it: the server is privately networked, so it cannot outlive its region.
pg_available() {
  local reason
  reason="$(az postgres flexible-server list-skus -l "$1" --query "[0].reason" -o tsv 2>/dev/null || true)"
  [[ -z "$reason" || "$reason" == "None" ]]
}

# 2 vCPU sizes with no subscription restriction. ARM64 sizes carry a 'p' in the size token and
# are left out to keep the build architecture matching local development.
vm_sizes_available() {
  az vm list-skus -l "$1" --resource-type virtualMachines --all \
    --query "[?(starts_with(name,'Standard_B2') || starts_with(name,'Standard_D2')) && !contains(name,'p') && length(restrictions)==\`0\`].name" \
    -o tsv 2>/dev/null || true
}

suggest_regions() {
  echo >&2
  echo "Probing other regions for a working combination..." >&2
  local tmp candidate
  tmp="$(mktemp -d)"
  for candidate in northcentralus westcentralus centralus westus westus3 canadacentral northeurope uksouth; do
    (
      if pg_available "$candidate" && [[ -n "$(vm_sizes_available "$candidate")" ]]; then
        echo "$candidate" > "$tmp/$candidate"
      fi
    ) &
  done
  wait
  for candidate in northcentralus westcentralus centralus westus westus3 canadacentral northeurope uksouth; do
    [[ -s "$tmp/$candidate" ]] && echo "  usable: $candidate" >&2
  done
  rm -rf "$tmp"
  echo >&2
  echo "Alternatively set BUNDLED_DB=true in .env.production to run PostgreSQL on the VM," >&2
  echo "which needs no Flexible Server and so only requires an available VM size." >&2
}

step "Checking availability in $LOCATION (this takes a moment)"
AVAILABLE_SIZES="$(vm_sizes_available "$LOCATION")"

if ! pg_available "$LOCATION"; then
  echo >&2
  echo "error: '$LOCATION' is restricted for Flexible Server on this subscription." >&2
  suggest_regions
  exit 1
fi

if [[ -z "$AVAILABLE_SIZES" ]]; then
  echo >&2
  echo "error: no unrestricted 2-vCPU VM size is available in '$LOCATION'." >&2
  suggest_regions
  exit 1
fi

if ! grep -qx -- "$VM_SIZE" <<<"$AVAILABLE_SIZES"; then
  echo >&2
  echo "error: VM size '$VM_SIZE' is not available to this subscription in '$LOCATION'." >&2
  echo "Available 2-vCPU sizes there:" >&2
  sed 's/^/  /' <<<"$AVAILABLE_SIZES" >&2
  echo >&2
  echo "Re-run with one of those, for example:" >&2
  echo "  LOCATION=$LOCATION VM_SIZE=$(head -1 <<<"$AVAILABLE_SIZES") ADMIN_CIDR=$ADMIN_CIDR $0" >&2
  exit 1
fi
echo "    Flexible Server available, VM size $VM_SIZE available"

echo
echo "Subscription: $(az account show --query name -o tsv)"
echo "Resource group: $RG    Location: $LOCATION"
echo "VM: $VM_NAME ($VM_SIZE)    Postgres: $PG_NAME ($PG_SKU, v$PG_VERSION)"
echo "Inbound access restricted to: $ADMIN_CIDR"
echo
read -r -p "Create these resources? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 0

# --- Resource providers --------------------------------------------------------------------
# A subscription that has never used a service cannot create it. The CLI auto-registers some
# namespaces but not all, so a fresh subscription otherwise fails partway through with
# MissingSubscriptionRegistration.
step "Resource providers"
for namespace in Microsoft.Network Microsoft.Compute Microsoft.DBforPostgreSQL; do
  state="$(az provider show -n "$namespace" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
  if [[ "$state" == "Registered" ]]; then
    echo "    $namespace: registered"
  else
    echo "    $namespace: registering (this can take a minute)"
    az provider register --namespace "$namespace" --wait
  fi
done

# --- Resource group ------------------------------------------------------------------------
step "Resource group"
if exists az group show -n "$RG"; then
  echo "    exists"
else
  az group create -n "$RG" -l "$LOCATION" -o none
fi

# --- Network -------------------------------------------------------------------------------
step "Virtual network and app subnet"
if exists az network vnet show -g "$RG" -n "$VNET"; then
  echo "    exists"
else
  # -l is explicit: without it the VNet inherits the resource group's region, which silently
  # breaks a retry in a different region because Flexible Server needs its delegated subnet
  # to be in the same region as the server.
  az network vnet create -g "$RG" -n "$VNET" -l "$LOCATION" \
    --address-prefix 10.20.0.0/16 \
    --subnet-name "$APP_SUBNET" --subnet-prefix 10.20.1.0/24 -o none
fi

VNET_LOCATION="$(az network vnet show -g "$RG" -n "$VNET" --query location -o tsv)"
if [[ "$VNET_LOCATION" != "$LOCATION" ]]; then
  cat >&2 <<MISMATCH

error: the existing network is in '$VNET_LOCATION' but LOCATION is '$LOCATION'.

A Flexible Server must sit in the same region as its delegated subnet, so the network cannot
stay where it is. The VNet and NSG are free and nothing else depends on them yet, so delete
them and re-run:

  az network vnet delete -g $RG -n $VNET
  az network nsg delete -g $RG -n $NSG
  LOCATION=$LOCATION ADMIN_CIDR=$ADMIN_CIDR $0

MISMATCH
  exit 1
fi

step "Database subnet (delegated to PostgreSQL)"
if exists az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$DB_SUBNET"; then
  echo "    exists"
else
  # Flexible Server injects itself into this subnet, which is why it must be delegated and
  # must not be shared with anything else.
  az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "$DB_SUBNET" \
    --address-prefixes 10.20.2.0/24 \
    --delegations Microsoft.DBforPostgreSQL/flexibleServers -o none
fi

step "Network security group"
if exists az network nsg show -g "$RG" -n "$NSG"; then
  echo "    exists"
else
  az network nsg create -g "$RG" -n "$NSG" -l "$LOCATION" -o none
  # Port 80 stays open to the world so Let's Encrypt can validate on renewal without anyone
  # editing firewall rules on a schedule. It is safe because the nginx server block on 80 only
  # serves ACME challenge files and a redirect: no app content and no API are reachable there.
  az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-acme \
    --priority 100 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes Internet --destination-port-ranges 80 -o none
  # The application itself is restricted, because the login endpoint issues superadmin tokens
  # without a password while AUTH_PROVIDER=dev.
  az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-https \
    --priority 110 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "$ADMIN_CIDR" --destination-port-ranges 443 -o none
  az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-ssh \
    --priority 120 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "$ADMIN_CIDR" --destination-port-ranges 22 -o none
fi
az network vnet subnet update -g "$RG" --vnet-name "$VNET" -n "$APP_SUBNET" \
  --network-security-group "$NSG" -o none

# --- PostgreSQL ----------------------------------------------------------------------------
step "PostgreSQL Flexible Server (this takes several minutes)"
if exists az postgres flexible-server show -g "$RG" -n "$PG_NAME"; then
  echo "    exists"
  PG_PASSWORD="$(grep -E '^PG_PASSWORD=' "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  [[ -n "$PG_PASSWORD" ]] || echo "    note: password unknown (not in $SECRETS_FILE); reset it with 'az postgres flexible-server update --admin-password'"
else
  PG_PASSWORD="$(openssl rand -hex 24)"
  PG_ERR="$(mktemp)"
  # Private access has to be chosen at creation time. A public-access server cannot be
  # converted to VNet integration afterwards; it has to be rebuilt.
  if ! az postgres flexible-server create \
    -g "$RG" -n "$PG_NAME" -l "$LOCATION" \
    --tier "$PG_TIER" --sku-name "$PG_SKU" \
    --storage-size "$PG_STORAGE_GB" --version "$PG_VERSION" \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --database-name "$PG_DATABASE" \
    --vnet "$VNET" --subnet "$DB_SUBNET" \
    --private-dns-zone "$DNS_ZONE" \
    --yes -o none 2>"$PG_ERR"; then

    cat "$PG_ERR" >&2
    # The preflight already screens out regions the capability API flags, so reaching here means
    # the region claims to be usable and fails anyway. Seen on subscriptions that are gated in
    # ways the API does not report; the only remedy is a different region.
    cat >&2 <<FAILED

Creating the server failed even though '$LOCATION' reports itself as available.

Retrying the same region usually fails the same way. Move to another one, remembering that the
network has to move with it: a privately networked server must share a region with its VM. The
simplest clean retry is a separate resource group, which deletes nothing:

  PREFIX=${PREFIX}2 LOCATION=<other-region> ADMIN_CIDR=$ADMIN_CIDR $0

FAILED
    suggest_regions
    rm -f "$PG_ERR"
    exit 1
  fi
  rm -f "$PG_ERR"

  save_secret PG_PASSWORD "$PG_PASSWORD"
  echo "    password written to $SECRETS_FILE (gitignored, chmod 600)"
fi

# Recorded so azure-email.sh targets the same deployment. A retry in a fresh resource group
# changes the prefix, and without this the email script would silently look for the old one.
save_secret PREFIX "$PREFIX"
save_secret LOCATION "$LOCATION"

PG_FQDN="$(az postgres flexible-server show -g "$RG" -n "$PG_NAME" --query fullyQualifiedDomainName -o tsv)"

# --- Virtual machine -----------------------------------------------------------------------
step "Application VM"
if exists az vm show -g "$RG" -n "$VM_NAME"; then
  echo "    exists"
else
  # --nsg "" leaves the NIC without its own NSG so the subnet NSG above is the single
  # place where inbound rules live.
  az vm create -g "$RG" -n "$VM_NAME" -l "$LOCATION" \
    --image "$VM_IMAGE" --size "$VM_SIZE" \
    --admin-username "$VM_ADMIN" --ssh-key-values "$SSH_KEY" \
    --vnet-name "$VNET" --subnet "$APP_SUBNET" \
    --public-ip-address "$PUBLIC_IP" --public-ip-sku Standard \
    --os-disk-size-gb "$OS_DISK_GB" \
    --nsg "" \
    --custom-data deploy/cloud-init.yaml -o none
fi

VM_IP="$(az vm show -d -g "$RG" -n "$VM_NAME" --query publicIps -o tsv)"

# --- Summary -------------------------------------------------------------------------------
cat <<SUMMARY

────────────────────────────────────────────────────────────────────────────
Provisioned.

  VM public IP   $VM_IP
  Postgres       $PG_FQDN (private; no public endpoint)
  Inbound        443 and 22 from $ADMIN_CIDR only; 80 open for ACME challenges

Next:

1. Point your DNS A record at $VM_IP and wait for it to resolve.

2. Copy this into DATABASE_URL in .env.production on the VM:

   postgres://${PG_ADMIN}:${PG_PASSWORD:-<see $SECRETS_FILE>}@${PG_FQDN}:5432/${PG_DATABASE}?sslmode=require

3. Deploy (cloud-init needs a minute or two to finish installing Docker first):

   ssh ${VM_ADMIN}@${VM_IP}
   git clone <your-repo> nio-platform && cd nio-platform
   cp .env.production.example .env.production      # fill in, including the URL above
   cp deploy/allowlist.conf.example deploy/allowlist.conf
   ./deploy/deploy.sh
   ./deploy/certs.sh

4. Provision outbound email, which is not created here:

   ./deploy/azure-email.sh

Put $ADMIN_CIDR in deploy/allowlist.conf too. The NSG and nginx gate the same traffic on
purpose: with the passwordless login enabled, one misconfigured layer should not be enough.
────────────────────────────────────────────────────────────────────────────
SUMMARY
