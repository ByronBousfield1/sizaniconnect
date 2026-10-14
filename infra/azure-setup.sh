#!/usr/bin/env bash
# Provisions SizaniConnect on Azure:
#   - one Linux App Service plan (B1) hosting a staging and a production web app
#   - Azure Database for PostgreSQL Flexible Server (Burstable B1ms), TLS required, with its
#     firewall open only to the two web apps' outbound IP addresses
#
# Run in Azure Cloud Shell (Bash):  SUFFIX=yourinitials7315 bash infra/azure-setup.sh
# Safe to re-run: existing resources are reused, and the database password and app secrets are
# regenerated and written to the web apps together, so they always match.
set -euo pipefail

# ----------------------------------------------------------------------------- settings
SUFFIX="${SUFFIX:-bb7315}"                 # app names are global: make this your own
LOCATION="${LOCATION:-southafricanorth}"
RG="rg-sizaniconnect"
PLAN="plan-sizaniconnect"
APP_PROD="sizaniconnect-${SUFFIX}"
APP_STAGING="sizaniconnect-${SUFFIX}-staging"
PG="pg-sizaniconnect-${SUFFIX}"
PG_ADMIN="sizaniadmin"

# Hex secrets contain no characters that need URL-encoding inside DATABASE_URL.
PG_PASSWORD="$(openssl rand -hex 24)"
DEMO_PASSWORD="${DEMO_PASSWORD:-Sizani-Demo-2026}"

echo "Creating resource group ${RG} in ${LOCATION}"
az group create -n "$RG" -l "$LOCATION" -o none

# ----------------------------------------------------------------------------- database
if az postgres flexible-server show -g "$RG" -n "$PG" -o none 2>/dev/null; then
  echo "Database server exists: setting a fresh admin password"
  az postgres flexible-server update -g "$RG" -n "$PG" --admin-password "$PG_PASSWORD" -o none
else
  echo "Creating PostgreSQL 16 Flexible Server (Burstable B1ms). This takes 5 to 10 minutes."
  az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOCATION" \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
    --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
    --public-access None --backup-retention 7 --yes -o none
fi
# Public endpoint on, but the firewall (set at the end) admits only the web apps.
az postgres flexible-server update -g "$RG" -n "$PG" --public-access Enabled -o none

for db in sizani_production sizani_staging; do
  az postgres flexible-server db show -g "$RG" --server-name "$PG" --name "$db" -o none 2>/dev/null \
    || az postgres flexible-server db create -g "$RG" --server-name "$PG" --name "$db" -o none
done
PG_HOST="${PG}.postgres.database.azure.com"

# ----------------------------------------------------------------------------- app service
echo "Creating the App Service plan and the two web apps"
az appservice plan create -g "$RG" -n "$PLAN" -l "$LOCATION" --is-linux --sku B1 -o none

configure_app () {
  local app="$1" db="$2"
  az webapp create -g "$RG" -p "$PLAN" -n "$app" --runtime "NODE:22-lts" -o none
  az webapp update -g "$RG" -n "$app" --https-only true -o none
  az webapp config set -g "$RG" -n "$app" \
    --startup-file "npm start" --always-on true --http20-enabled true \
    --min-tls-version 1.2 --ftps-state Disabled -o none
  az webapp config appsettings set -g "$RG" -n "$app" -o none --settings \
    NODE_ENV=production \
    DATABASE_URL="postgresql://${PG_ADMIN}:${PG_PASSWORD}@${PG_HOST}:5432/${db}" \
    DATABASE_SSL=true \
    JWT_SECRET="$(openssl rand -hex 32)" \
    ID_HASH_PEPPER="$(openssl rand -hex 32)" \
    APP_BASE_URL="https://${app}.azurewebsites.net" \
    SEED_DEMO_DATA=true \
    SEED_DEMO_PASSWORD="$DEMO_PASSWORD" \
    SCM_DO_BUILD_DURING_DEPLOYMENT=false \
    WEBSITE_RUN_FROM_PACKAGE=1
  # The GitHub workflow deploys with a publish profile, which needs basic publishing credentials.
  az resource update -g "$RG" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
    --parent "sites/${app}" --name scm --set properties.allow=true -o none
}

configure_app "$APP_PROD" sizani_production
configure_app "$APP_STAGING" sizani_staging

# ----------------------------------------------------------------------------- firewall
echo "Opening the database firewall to the web apps' outbound addresses only"
n=0
for ip in $( (az webapp show -g "$RG" -n "$APP_PROD" --query outboundIpAddresses -o tsv
              az webapp show -g "$RG" -n "$APP_STAGING" --query outboundIpAddresses -o tsv) | tr ',' '\n' | sort -u ); do
  n=$((n+1))
  echo "  allowing ${ip}"
  az postgres flexible-server firewall-rule create -g "$RG" --server-name "$PG" \
    --name "webapp-${n}" --start-ip-address "$ip" --end-ip-address "$ip" -o none
done

cat <<DONE

Done.

  Production:  https://${APP_PROD}.azurewebsites.net
  Staging:     https://${APP_STAGING}.azurewebsites.net
  Database:    ${PG_HOST} (TLS required; firewall admits only the two web apps)

Next, in GitHub (Settings > Secrets and variables > Actions):

  Variables:
    AZURE_WEBAPP_NAME_PRODUCTION = ${APP_PROD}
    AZURE_WEBAPP_NAME_STAGING    = ${APP_STAGING}
  Secrets (from each web app's Overview page > Download publish profile, pasted in full):
    AZURE_PUBLISH_PROFILE_PRODUCTION
    AZURE_PUBLISH_PROFILE_STAGING

The database password is stored only inside the web apps' settings. It is not printed here.
DONE
