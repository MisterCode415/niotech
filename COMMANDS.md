# Qinio Platform Operations Commands

This is the command-oriented companion to the deployment explanation in `README.md`. It records
the repeatable path and the recovery commands used while bringing up the Azure development
environment. Replace example values before running commands. Never paste credentials into this
file, shell history, Git, CI logs, or issue trackers.

## Working variables

Set these once per shell session. The values below describe the current Azure development stack:

```bash
export PREFIX=nio2
export RG="${PREFIX}-rg"
export LOCATION=westcentralus
export VM_NAME="${PREFIX}-app"
export VM_IP=13.78.138.36
export VM_USER=azureuser
export APP_HOST=dev.qinio.co
export ADMIN_CIDR="$(curl -fsS https://ifconfig.me)/32"
```

Confirm the active Azure account before making changes:

```bash
az account show --query '{subscription:name,tenant:tenantId,user:user.name}' -o json
az group show -n "$RG" --query '{name:name,location:location,state:properties.provisioningState}'
```

## Provision Azure infrastructure

The project script registers providers, checks regional PostgreSQL and VM availability, and creates
the resource group, VNet, delegated database subnet, NSG, VM, private DNS, and PostgreSQL Flexible
Server:

```bash
az login
PREFIX="$PREFIX" LOCATION="$LOCATION" ADMIN_CIDR="$ADMIN_CIDR" \
  ./deploy/azure-provision.sh
```

The generated administrator database credential is stored in the gitignored
`deploy/.azure-secrets` with mode `0600`.

Inspect what was created:

```bash
az resource list -g "$RG" \
  --query '[].{name:name,type:type,location:location}' -o table

az vm list-ip-addresses -g "$RG" \
  --query '[].virtualMachine.{name:name,publicIp:network.publicIpAddresses[0].ipAddress,privateIp:network.privateIpAddresses[0]}' \
  -o table

az postgres flexible-server show -g "$RG" -n "${PREFIX}-db-d49f71" \
  --query '{name:name,fqdn:fullyQualifiedDomainName,state:state,version:version}' -o json
```

The generated PostgreSQL suffix is not stable. Discover it instead of copying the example:

```bash
export PG_SERVER="$(
  az postgres flexible-server list -g "$RG" --query '[0].name' -o tsv
)"
az postgres flexible-server show -g "$RG" -n "$PG_SERVER" \
  --query fullyQualifiedDomainName -o tsv
```

## Network access

List current NSG rules:

```bash
az network nsg rule list -g "$RG" --nsg-name "${PREFIX}-app-nsg" \
  --query '[].{name:name,priority:priority,port:destinationPortRange,source:sourceAddressPrefix,access:access}' \
  -o table
```

HTTPS is public; only update SSH when the administrator's public IP changes:

```bash
export ADMIN_CIDR="$(curl -fsS https://ifconfig.me)/32"

az network nsg rule update -g "$RG" --nsg-name "${PREFIX}-app-nsg" \
  -n allow-ssh --source-address-prefixes "$ADMIN_CIDR"
```

Converge web access to the scalable configuration if an older test deployment still has IP gates:

```bash
az network nsg rule update -g "$RG" --nsg-name "${PREFIX}-app-nsg" \
  -n allow-https --source-address-prefixes Internet
```

Ports 80 and 443 are public by design. Auth0, application authorization, and RLS protect tenant
data. Never add application testers to `allow-ssh`.

## DNS

Create an `A` record with the DNS provider:

```text
dev.qinio.co  A  13.78.138.36
```

Verify global resolution before requesting a certificate:

```bash
dig +short A "$APP_HOST"
```

An Azure-provided hostname is an alternative when no custom DNS zone is available:

```bash
az network public-ip update -g "$RG" -n "${PREFIX}-ip" \
  --dns-name "${PREFIX}-dev"

az network public-ip show -g "$RG" -n "${PREFIX}-ip" \
  --query dnsSettings.fqdn -o tsv
```

## Connect and synchronize source

```bash
ssh "${VM_USER}@${VM_IP}"
```

For the normal Git-based process:

```bash
git clone git@github.com:MisterCode415/niotech.git nio-platform
cd nio-platform
git pull --ff-only
```

Before CI/CD exists, uncommitted reviewed work can be synchronized without copying credentials,
certificates, uploads, or dependencies:

```bash
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.env.production' \
  --exclude='node_modules/' \
  --exclude='apps/*/node_modules/' \
  --exclude='packages/*/node_modules/' \
  --exclude='apps/*/dist/' \
  --exclude='deploy/.azure-secrets*' \
  --exclude='deploy/.auth0-secrets*' \
  --exclude='deploy/certs/' \
  --exclude='deploy/letsencrypt/' \
  --exclude='storage/' \
  ./ "${VM_USER}@${VM_IP}:~/nio-platform/"
```

Review every exclusion before using `--delete`. Prefer committed Git deployments once the branch is
ready.

## Production environment

Create the uncommitted files on the VM:

```bash
cd ~/nio-platform
cp .env.production.example .env.production
chmod 600 .env.production
```

Required public values:

```dotenv
SERVER_NAME=dev.qinio.co
WEB_ORIGIN=https://dev.qinio.co
API_PUBLIC_URL=https://dev.qinio.co
AUTH_PROVIDER=auth0
PLATFORM_ADMIN_EMAIL=papaviking@gmail.com
```

All five Auth0 values, the restricted database URL, and SMTP credentials must also be populated.
Generate the alpha server-to-server commerce key directly on the VM:

```bash
printf 'INTEGRATION_API_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.production
```

Inspect whether keys exist without printing their values:

```bash
for key in \
  SERVER_NAME WEB_ORIGIN API_PUBLIC_URL DATABASE_URL \
  AUTH_PROVIDER AUTH0_DOMAIN AUTH0_AUDIENCE AUTH0_SPA_CLIENT_ID \
  AUTH0_M2M_CLIENT_ID AUTH0_M2M_CLIENT_SECRET \
  PLATFORM_ADMIN_EMAIL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM \
  INTEGRATION_API_SECRET
do
  grep -Eq "^${key}=.+" .env.production && echo "$key=set" || echo "$key=missing"
done
```

After deployment, reconcile a mock external purchase from a trusted server (not browser code):

```bash
export QINIO_INTEGRATION_KEY='value-from-the-VM-environment'
curl -fsS -X POST "https://${APP_HOST}/api/integrations/vitality/purchases" \
  -H 'Content-Type: application/json' \
  -H "X-Qinio-Integration-Key: ${QINIO_INTEGRATION_KEY}" \
  --data '{
    "source":"custom_store",
    "externalOrderId":"store-order-1001",
    "externalPaymentId":"store-payment-1001",
    "packageReference":"external-product-id-from-package-admin",
    "patient":{"email":"patient@example.com","name":"Example Patient"},
    "shippingAddress":{
      "line1":"44 Cedar Street","city":"Portland","region":"OR",
      "postalCode":"97205","country":"US"
    },
    "shippingMethod":"ground"
  }'
```

Sending the same `source` and `externalOrderId` again is an idempotent replay.

## Restricted PostgreSQL runtime role

Keep the administrator URL outside `.env.production`. On the VM:

```bash
export ADMIN_DATABASE_URL='postgres://ADMIN:REDACTED@HOST:5432/nio?sslmode=require'
export APP_DATABASE_PASSWORD="$(openssl rand -hex 32)"

docker run --rm -i postgres:17-alpine \
  psql "$ADMIN_DATABASE_URL" \
  -v app_password="$APP_DATABASE_PASSWORD" \
  < deploy/create-app-db-role.sql
```

Construct the runtime URL with username `nio_app` and put only that URL in `.env.production`:

```text
postgres://nio_app:APP_DATABASE_PASSWORD@HOST:5432/nio?sslmode=require
```

The runtime role should report `NOSUPERUSER` and `NOBYPASSRLS`:

```bash
docker run --rm postgres:17-alpine psql "$ADMIN_DATABASE_URL" -c \
  "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'nio_app';"
```

## Azure Communication Services email

From the workstation:

```bash
PREFIX="$PREFIX" ./deploy/azure-email.sh
```

Copy the emitted SMTP settings into the VM's `.env.production`. The script creates:

- an Email Communication Service and Azure-managed sender domain;
- a linked Communication Services resource;
- an Entra application and service principal;
- a resource-scoped `Communication and Email Service Owner` assignment;
- distinct Azure resource and SMTP login names.

Inspect resources without printing credentials:

```bash
az communication list -g "$RG" -o table
az communication email list -g "$RG" -o table
az role assignment list --resource-group "$RG" \
  --query '[].{role:roleDefinitionName,principal:principalName,scope:scope}' -o table
```

Check aggregated delivery outcomes. Azure Monitor can lag several minutes and SMTP does not expose
recipient addresses in this metric:

```bash
export ACS_ID="$(
  az communication show -g "$RG" -n "${PREFIX}-acs" --query id -o tsv
)"

az monitor metrics list --resource "$ACS_ID" \
  --metric DeliveryStatusUpdate --interval PT5M --aggregation Count \
  --filter "MessageStatus eq '*' and Result eq '*' and SmtpStatusCode eq '*'" \
  -o json
```

Secrets are stored in gitignored `deploy/.azure-secrets`. The Entra client secret expires after one
year and must be rotated:

```bash
az ad app credential reset --id '<smtp-entra-app-id>' --append --years 1
```

After rotation, update `SMTP_PASS` on the VM and recreate the API container.

## Auth0 deployment configuration

Reauthorize the CLI if its session expires:

```bash
auth0 login --domain qinio-dev.us.auth0.com \
  --scopes 'read:clients update:clients read:resource_servers update:resource_servers'
```

Preserve localhost while adding production SPA URLs:

```bash
export AUTH0_SPA_CLIENT_ID='<spa-client-id>'

auth0 api patch "clients/${AUTH0_SPA_CLIENT_ID}" --data '{
  "callbacks": [
    "http://localhost:5173/callback",
    "https://dev.qinio.co/callback"
  ],
  "allowed_origins": [
    "http://localhost:5173",
    "https://dev.qinio.co"
  ],
  "web_origins": [
    "http://localhost:5173",
    "https://dev.qinio.co"
  ],
  "allowed_logout_urls": [
    "http://localhost:5173",
    "https://dev.qinio.co"
  ],
  "is_first_party": true,
  "organization_usage": "allow",
  "organization_require_behavior": "no_prompt"
}'
```

Allow the first-party SPA to skip repeated consent for the Qinio API:

```bash
export AUTH0_API_ID='<resource-server-id>'
auth0 api patch "resource-servers/${AUTH0_API_ID}" \
  --data '{"skip_consent_for_verifiable_first_party_clients":true}'
```

Verify settings:

```bash
auth0 api get "clients/${AUTH0_SPA_CLIENT_ID}" | jq \
  '{callbacks,allowed_origins,web_origins,allowed_logout_urls,is_first_party,organization_usage,organization_require_behavior}'

auth0 api get "resource-servers/${AUTH0_API_ID}" | jq \
  '{identifier,allow_offline_access,skip_consent_for_verifiable_first_party_clients}'
```

The post-login Action must also be created, deployed, and attached to the post-login flow. Creating
an Action without binding it does nothing:

```bash
auth0 actions create --name 'Add email claim' --trigger post-login \
  --code "$(cat deploy/auth0-post-login-action.js)"

auth0 actions deploy '<action-id>'
```

Use the Auth0 dashboard or CLI trigger-binding command appropriate to the installed CLI version to
attach the deployed Action to the post-login flow.

## Build, migrate, bootstrap, and start

From the VM, pass the administrator URL only to the deployment process:

```bash
cd ~/nio-platform
export ADMIN_DATABASE_URL='postgres://ADMIN:REDACTED@HOST:5432/nio?sslmode=require'
MIGRATION_DATABASE_URL="$ADMIN_DATABASE_URL" ./deploy/deploy.sh
```

The script:

1. builds the web and API images;
2. applies Drizzle migrations with the administrator credential;
3. provisions and binds the alpha Auth0 administrator;
4. sends an activation email when necessary;
5. starts the stack and waits for API health.

Retry only the alpha administrator bootstrap:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm api pnpm db:bootstrap
```

Changing `PLATFORM_ADMIN_EMAIL` and rerunning bootstrap transfers alpha authority and deactivates
the previous platform-admin row.

## TLS certificates

After DNS resolves:

```bash
cd ~/nio-platform
./deploy/certs.sh
```

Verify the certificate:

```bash
openssl s_client -connect "${APP_HOST}:443" -servername "$APP_HOST" </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates
```

Install weekly renewal on the VM:

```cron
0 3 * * 1 cd /home/azureuser/nio-platform && ./deploy/certs.sh >> /var/log/nio-certs.log 2>&1
```

## Health and diagnostics

Public checks:

```bash
curl -fsS "https://${APP_HOST}/api/health"
curl -fsS "https://${APP_HOST}/api/auth/config"
curl -fsSI "https://${APP_HOST}/"
```

Container checks:

```bash
cd ~/nio-platform
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api
docker compose -f docker-compose.prod.yml --env-file .env.production logs --since=10m web
```

Verify the running API's database target without exposing its password:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T api \
  node -e 'const u=new URL(process.env.DATABASE_URL); console.log({host:u.hostname,user:u.username})'
```

The `nio_app` role intentionally cannot read `drizzle.__drizzle_migrations`. Use the administrator
credential when migration-ledger inspection is genuinely needed.

## Edge cases and one-off recovery

### Duplicate resource group

List resources carefully, verify the prefix, then delete the duplicate group:

```bash
az group list --query "[?contains(name, 'nio')].{name:name,location:location,state:properties.provisioningState}" -o table
az resource list -g '<duplicate-rg>' -o table
az group delete -n '<duplicate-rg>' --yes
```

Deleting a resource group is irreversible and removes its VM, disks, IP, database, and networking.

### Resize an oversized VM

```bash
az vm list-vm-resize-options -g "$RG" -n "$VM_NAME" -o table
az vm resize -g "$RG" -n "$VM_NAME" --size Standard_B2als_v2
az vm show -g "$RG" -n "$VM_NAME" --query hardwareProfile.vmSize -o tsv
```

Expect a restart and brief downtime.

### Repair SSH private-key permissions

OpenSSH rejects a private key readable by other users:

```bash
chmod 600 ~/.ssh/id_rsa
```

### Recover a lost PostgreSQL URL

Azure can recover the server hostname and administrator username, but never the password:

```bash
az postgres flexible-server show -g "$RG" -n "$PG_SERVER" \
  --query '{host:fullyQualifiedDomainName,admin:administratorLogin,database:name}' -o json
```

Reconstruct the URL from the password manager or gitignored deployment secrets:

```text
postgres://ADMIN:PASSWORD@FQDN:5432/nio?sslmode=require
```

Rotate the administrator password if it is actually lost rather than merely misplaced.

### Region restrictions or transient PostgreSQL failures

Use a fresh prefix and a region that passes both VM and Flexible Server checks:

```bash
PREFIX=nio3 LOCATION='<available-region>' ADMIN_CIDR="$ADMIN_CIDR" \
  ./deploy/azure-provision.sh
```

Do not delete the previous group until the replacement has passed health and data checks.

### Missing Azure resource-provider registration

```bash
for provider in Microsoft.Network Microsoft.Compute Microsoft.DBforPostgreSQL Microsoft.Communication
do
  az provider register --namespace "$provider" --wait
done
```

### ACS rejects identical SMTP names

Azure requires the SMTP username resource name and actual login value to differ. The current script
handles this. For manual recovery:

```bash
SMTP_USERNAME_RESOURCE="${PREFIX}-mailer" \
SMTP_USERNAME="${PREFIX}-smtp" \
./deploy/azure-email.sh
```

### Remove the legacy nginx IP gate

Older private-test deployments mounted `deploy/allowlist.conf`. Pull the current compose and nginx
configuration, make HTTPS public in the NSG, and recreate `web`:

```bash
az network nsg rule update -g "$RG" --nsg-name "${PREFIX}-app-nsg" \
  -n allow-https --source-address-prefixes Internet

docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --force-recreate web
```

Keep `allow-ssh` restricted. Confirm production uses `AUTH_PROVIDER=auth0` before opening HTTPS.

### Certificate issued but host copy fails

Older versions of `deploy/certs.sh` could receive the certificate but fail to read Certbot's
root-owned archive. The current script copies through a short-lived Alpine container. Pull the
current script and rerun:

```bash
git pull --ff-only
./deploy/certs.sh
```

Certbot reports “not yet due for renewal” and the script still installs the existing valid
certificate.

### Auth0 secret accidentally empty

Check presence without printing it:

```bash
grep -Eq '^AUTH0_M2M_CLIENT_SECRET=.+$' .env.production \
  && echo set || echo missing
```

Restore only that key from the password manager, recreate the API container, and verify config:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --force-recreate api
curl -fsS "https://${APP_HOST}/api/auth/config"
```

### Auth0 CLI device code expires

Run `auth0 login` again and complete every browser screen until Auth0 confirms success. Merely
entering the device code without approving requested scopes leaves the CLI waiting until expiry.

## CI/CD boundary

These commands intentionally document the manual process first. A future GitHub pipeline should
package reviewed commits, use GitHub environments with approval, store credentials in GitHub or
Azure secret storage, run migrations as a one-off privileged job, deploy the long-running API with
only `nio_app`, verify health, and support rollback. Do not automate from an uncommitted workstation
tree.
