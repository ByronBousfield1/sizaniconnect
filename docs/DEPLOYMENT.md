# Deploying SizaniConnect to Azure

About 30 minutes, most of it waiting for the database to provision. You need an Azure subscription (Azure for Students works) and a GitHub account.

## What gets created

| Resource | Tier | Purpose |
| --- | --- | --- |
| App Service plan | Linux B1 | Hosts both web apps at no extra cost |
| Web app `sizaniconnect-<suffix>` | Node 22 | Production |
| Web app `sizaniconnect-<suffix>-staging` | Node 22 | Staging, deployed from `develop` |
| PostgreSQL Flexible Server | Burstable B1ms, 32 GB | Databases `sizani_production` and `sizani_staging`. TLS required; the firewall admits only the web apps' outbound IP addresses |

Staging is a second web app rather than a deployment slot because slots need the Standard tier.

The database is not on a private subnet. On the Azure for Students subscription, every private DNS zone name was rejected, including names in the documented format, so the server uses its public endpoint with a firewall instead: only the web apps' own outbound addresses can connect, and only over TLS with a strong random password.

## 1. Provision Azure

Open **Azure Cloud Shell** (Bash) from the portal, upload `infra/azure-setup.sh` or clone the repository, then:

```bash
SUFFIX=yourinitials7315 bash infra/azure-setup.sh
```

The script creates everything above, generates the database password, JWT secret and ID-hash pepper, and stores them only in each web app's application settings. It is safe to re-run: existing resources are reused and the secrets are regenerated together.

> **If Azure refuses the region.** Azure for Students subscriptions only allow some regions for some services. If you see `LocationIsOfferRestricted` or a policy error naming allowed regions, run again with one of them, for example `LOCATION=eastus SUFFIX=... bash infra/azure-setup.sh`, and note the region change in the Task 3 report.

## 2. Configure GitHub

1. Create a new repository and push everything (step 3 below), or create it empty first.
2. **Settings, Secrets and variables, Actions.**
   - Variables: `AZURE_WEBAPP_NAME_PRODUCTION` and `AZURE_WEBAPP_NAME_STAGING`, set to the app names the script printed.
   - Secrets: `AZURE_PUBLISH_PROFILE_PRODUCTION` and `AZURE_PUBLISH_PROFILE_STAGING`. In the Azure portal, open each web app, click **Download publish profile** on its Overview page, open the file in a text editor and paste the whole contents in as the secret. Add them on the **Secrets** tab, never as variables, then delete the downloaded files. If a profile is ever exposed, click **Reset publish profile** and repeat.
3. **Settings, Environments.** Create `staging` and `production`. On `production`, add yourself as a required reviewer, so a release to production waits for a click.
4. **Settings, Branches.** Add protection rules for `main` and `develop`: require a pull request before merging, and require the CI status checks (`API`, `Web`, `Dependency audit`) to pass.
5. **Settings, Code security.** Turn on Dependabot alerts and secret scanning with push protection.

Until the two variables exist the deployment jobs are skipped, so pushing first and configuring later is fine.

## 3. Push the code

From the project folder, which already contains the Git history:

```bash
git remote add origin https://github.com/<you>/sizaniconnect.git
git push -u origin main develop
git push --tags
```

Pushing `develop` runs CI and deploys to staging. Pushing `main` runs CI, waits for your approval, then deploys to production. Watch both under the **Actions** tab.

On first start each app migrates its database and seeds the demo data. The demo accounts in the README then work against the live URL.

## 4. Check it

```bash
curl https://sizaniconnect-<suffix>.azurewebsites.net/api/v1/health
# {"status":"ok","version":"<commit sha>","database":"ok"}
```

The `version` field is the commit that is live, which is what the pipeline's smoke test waits for.

## Rolling back

Open **Actions, Deploy**, choose **Run workflow**, and pick the previous release tag as the ref. The same package is rebuilt and redeployed. Migrations are additive, so an older build runs against a newer schema.

## Email (optional)

Without `SMTP_URL`, password-reset emails are not sent, and new accounts' activation links are shown to the administrator instead so they can be handed over in person. To send real email, add an application setting such as:

```
SMTP_URL=smtps://<user>:<password>@smtp-relay.brevo.com:465
MAIL_FROM=SizaniConnect <no-reply@your-domain>
```

## Cost

Roughly R480 per month for B1 plus B1ms in South Africa North, covered for several months by the Azure for Students credit. **Stop or delete the resource group after the module is marked:** `az group delete -n rg-sizaniconnect`.
