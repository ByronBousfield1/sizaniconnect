#!/usr/bin/env bash
# Provisions SizaniConnect on Azure, matching the cloud architecture in Task 1 Section 9.3:
#   - one Linux App Service plan (B1) hosting a staging and a production web app
#   - Azure Database for PostgreSQL Flexible Server on a PRIVATE subnet (no public endpoint)
#   - the web apps reach the database through VNet integration
#
# Run in Azure Cloud Shell (Bash) or anywhere the Azure CLI is signed in:  bash infra/azure-setup.sh
# Re-running is safe for most steps; it stops at the first error.
set -euo pipefail

# ----------------------------------------------------------------------------- settings
# App names must be globally unique: change the suffix to something of your own.
SUFFIX="${SUFFIX:-bb7315}"
LOCATION="${LOCATION:-southafricanorth}"
RG="rg-sizaniconnect"
VNET="vnet-sizaniconnect"
PLAN="plan-sizaniconnect"
APP_PROD="sizaniconnect-${SUFFIX}"
APP_STAGING="sizaniconnect-${SUFFIX}-staging"
PG="pg-sizaniconnect-${SUFFIX}"
PG_ADMIN="sizaniadmin"

# Hex secrets: no characters that need URL-encoding inside DATABASE_URL.
PG_PASSWORD="$(openssl rand -hex 24)"
DEMO_PASSWORD="${DEMO_PASSWORD:-Sizani-Demo-2026}"

echo "Creating resource group ${RG} in ${LOCATION}"
az group create -n "$RG" -l "$LOCATION" -o none

# ----------------------------------------------------------------------------- network
echo "Creating virtual network with an app subnet and a database subnet"
az network vnet create -g "$RG" -n "$VNET" -l "$LOCATION" \
  --address-prefixes 10.10.0.0/16 \
  --subnet-name snet-app --subnet-prefixes 10.10.1.0/24 -o none
az network vnet subnet update -g "$RG" --vnet-name "$VNET" -n snet-app \
  --delegations Microsoft.Web/serverFarms -o none
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-db \
  --address-prefixes 10.10.2.0/24 \
  --delegations Microsoft.DBforPostgreSQL/flexibleServers -o none

# ----------------------------------------------------------------------------- database
echo "Creating PostgreSQL 16 Flexible Server (Burstable B1ms) on the private subnet. This takes 5 to 10 minutes."
az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOCATION" \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --admin-user "$PG_ADMIN" --admin-password "$PG_PASSWORD" \
  --vnet "$VNET" --subnet snet-db \
  --backup-retention 7 --yes -o none
az postgres flexible-server db create -g "$RG" -s "$PG" -d sizani_production -o none
az postgres flexible-server db create -g "$RG" -s "$PG" -d sizani_staging -o none
PG_HOST="${PG}.postgres.database.azure.com"

# ----------------------------------------------------------------------------- app service
echo "Creating the App Service plan and the two web apps"
az appservice plan create -g "$RG" -n "$PLAN" -l "$LOCATION" --is-linux --sku B1 -o none

configure_app () {
  local app="$1" db="$2"
  az webapp create -g "$RG" -p "$PLAN" -n "$app" --runtime "NODE:22-lts" -o none
  az webapp vnet-integration add -g "$RG" -n "$app" --vnet "$VNET" --subnet snet-app -o none
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
  az webapp deployment list-publishing-profiles -g "$RG" -n "$app" --xml > "publish-profile-${app}.xml"
}

configure_app "$APP_PROD" sizani_production
configure_app "$APP_STAGING" sizani_staging

cat <<DONE

Done.

  Production:  https://${APP_PROD}.azurewebsites.net
  Staging:     https://${APP_STAGING}.azurewebsites.net
  Database:    ${PG_HOST} (private subnet only; not reachable from the internet)

Next, in GitHub (Settings > Secrets and variables > Actions):

  Variables:
    AZURE_WEBAPP_NAME_PRODUCTION = ${APP_PROD}
    AZURE_WEBAPP_NAME_STAGING    = ${APP_STAGING}
  Secrets (paste the whole file contents):
    AZURE_PUBLISH_PROFILE_PRODUCTION = contents of publish-profile-${APP_PROD}.xml
    AZURE_PUBLISH_PROFILE_STAGING    = contents of publish-profile-${APP_STAGING}.xml

Then delete the two publish-profile-*.xml files from this machine.
The database password is stored only inside the web apps' settings. It is not printed here.
DONE
