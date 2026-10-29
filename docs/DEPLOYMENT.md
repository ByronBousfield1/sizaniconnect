# Deploying and running SizaniConnect on Azure

About 30 minutes for a first deployment, most of it waiting for the database to provision. You need an Azure subscription (Azure for Students works) and a GitHub account.

Sections 5 to 7 are the operating runbook: what to do when something fails, how an administrator gets back in, and how to roll back a release or a database change.

## What gets created

| Resource | Tier | Purpose |
| --- | --- | --- |
| App Service plan | Linux B1 | Hosts both web apps at no extra cost |
| Web app `sizaniconnect-<suffix>` | Node 22 | Production, health check on `/api/v1/health` |
| Web app `sizaniconnect-<suffix>-staging` | Node 22 | Staging, deployed from `develop` |
| PostgreSQL Flexible Server | Burstable B1ms, 32 GB, storage auto-grow | Databases `sizani_production` and `sizani_staging`. TLS required; the firewall admits only the web apps' outbound IP addresses; 7-day backups with point-in-time restore |
| Action group and metric alert (optional) | | Email when database storage passes 80% |

Staging is a second web app rather than a deployment slot because slots need the Standard tier.

The database is not on a private subnet. On the Azure for Students subscription, every private DNS zone name was rejected, including names in the documented format, so the server uses its public endpoint with a firewall instead: only the web apps' own outbound addresses can connect, and only over TLS with a strong random password.

## 1. Provision Azure

Open **Azure Cloud Shell** (Bash) from the portal, upload `infra/azure-setup.sh` or clone the repository, then:

```bash
SUFFIX=yourinitials7315 ALERT_EMAIL=you@example.com bash infra/azure-setup.sh
```

The script creates everything above, generates the database password, JWT secret and ID-hash pepper, and stores them only in each web app's application settings. It is safe to re-run: existing resources are reused and the secrets are regenerated together. `ALERT_EMAIL` is optional.

> **If Azure refuses the region.** Azure for Students subscriptions only allow some regions for some services. If you see `LocationIsOfferRestricted` or a policy error naming allowed regions, run again with one of them, for example `LOCATION=eastus SUFFIX=... bash infra/azure-setup.sh`.

## 2. Configure GitHub

1. Create a new repository and push everything (step 3 below), or create it empty first.
2. **Settings, Secrets and variables, Actions.**
   - Variables: `AZURE_WEBAPP_NAME_PRODUCTION` and `AZURE_WEBAPP_NAME_STAGING`, set to the app names the script printed.
   - Secrets: `AZURE_PUBLISH_PROFILE_PRODUCTION` and `AZURE_PUBLISH_PROFILE_STAGING`. In the Azure portal, open each web app, click **Download publish profile** on its Overview page, open the file in a text editor and paste the whole contents in as the secret. Add them on the **Secrets** tab, never as variables, then delete the downloaded files. If a profile is ever exposed, click **Reset publish profile** and repeat.
3. **Settings, Environments.** Create `staging` and `production`. On `production`, add yourself as a required reviewer, so a release to production waits for a click.
4. **Settings, Branches.** Add protection rules for `main` and `develop`: require a pull request before merging, and require the CI status checks (`API`, `Web`, `End-to-end and accessibility`, `Dependency audit`) to pass.
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
# {"status":"ok","version":"<commit sha>","database":"ok","responseMs":3}
```

The `version` field is the commit that is live, which is what the pipeline's smoke test waits for.

## 5. When something fails

The health endpoint reports one of three states. The deploy smoke test, App Service's health check and the Docker `HEALTHCHECK` all read it.

| `status` | HTTP | Meaning | What people see | What to do |
| --- | --- | --- | --- | --- |
| `ok` | 200 | Database reachable and writable | Normal | Nothing |
| `degraded` (`database: read-only`) | 200 | Storage is full: Azure switches the server to read-only above 95% | Pages still load. Every save answers **503 STORAGE_FULL**: "The database is out of storage space, so nothing can be saved..." Sessions end within 15 minutes because refreshing them needs a write | Portal, PostgreSQL server, **Compute + storage**: raise the storage size and save. Writes resume by themselves within a minute; no restart. Auto-grow (set by the script) should prevent this |
| `down` (`database: unreachable`) | 503 | The app cannot connect: server restarting, failing over, firewall changed, password out of step | **503 DATABASE_UNAVAILABLE**: "...cannot reach its database right now, so nothing was saved. Try again in a minute." A yellow banner says the system can't be reached | Usually clears by itself; the pool opens new connections on the next request, no restart needed. If it lasts more than 5 minutes: check the server is **Ready** in the portal, the firewall rules still list the web apps' outbound IPs (they change if the plan changes; re-run the script), and the app's log stream |

Other answers the API gives in trouble: **DATABASE_BUSY** (too many connections; wait seconds) and **DATABASE_TIMEOUT** (a statement ran longer than 15 seconds). All are 503 with a `Retry-After` header. Every write is one transaction (NFR-06), so a failure part-way leaves nothing half-saved.

On the client, a request that gets no answer within 20 seconds (including a TLS handshake that never completes on a poor mobile signal) is abandoned. Reads are retried once automatically. Writes never are; the message says the save may or may not have happened. At the event desk this is safe to repeat: the database accepts one collection per household per event, so a repeat of a saved attempt comes back as "already collected by you" and the desk shows it as a success.

## 6. An administrator who is locked out

In order of preference:

1. **Email reset**: *Forgot your password?* on the sign-in page (needs `SMTP_URL`, section 8).
2. **Recovery code**: *Use a recovery code instead*. Each user creates ten single-use codes under **My account**; administrators are reminded on their start page until they have done so.
3. **Another administrator**: **Users**, *Send reset link* on the locked-out administrator. The link lasts 24 hours and is shown on screen when email is not configured. This is why at least two administrators should exist.
4. **Break-glass** (no codes, no second admin, no email): someone with access to the Azure portal opens the production web app, **Development Tools, SSH**, and runs:

   ```bash
   cd /home/site/wwwroot
   node dist/db/cli.js recover-admin admin@example.org
   ```

   It prints a single-use link valid for 30 minutes and records `BREAK_GLASS_RESET` in the audit log. It works only for active administrator accounts. Pass the link on in person or by phone.

## 7. Rolling back

### 7.1 A release that misbehaves (the usual case)

1. GitHub, **Actions, Deploy, Run workflow**. Under *Use workflow from* choose **Tags** and the previous release tag (for example `v1.0.1`). Run it.
2. Approve the production deployment when asked. The tag is rebuilt, tested and deployed; the smoke test confirms the health check reports that tag's commit.

This is enough on its own when the release's migrations are *backward compatible*: they only add tables and columns the previous release ignores, and anything is dropped one release later (expand, then contract). The previous build then runs correctly on the newer schema.

**v1.1.0 is not backward compatible.** Migrations 002 and 004 add CHECK constraints (cellphone format; an offboarded account must have a date) that v1.0.x code would break with a database error when saving. To go back from v1.1.0 to v1.0.x, undo the database change first, as in 7.3.

### 7.2 A migration that fails while deploying

Nothing to undo in the database. Each migration runs inside its own transaction, so a failure rolls it back completely and it is not recorded as applied; the new build then refuses to start, the smoke test fails, and the pipeline stops with a message pointing here. Roll the application back as in 7.1, fix the migration, and release again.

### 7.3 Undoing a migration that succeeded but must be reversed (destructive changes)

Some migrations change data, not just structure. `002_cellphone_numbers.sql` is one: it rewrites every stored number and blanks those that cannot be converted. Every migration after the first has a matching script in `api/migrations/down/`. A destructive migration first copies the original values into a `_backup_<version>_...` table in the same transaction, and its down script restores them, skipping any row that has been edited since. CI rehearses this before every deployment: it applies all migrations to a populated database, rolls each one back and forward again, and checks that the schema and row counts come out identical.

Do this outside distribution hours:

1. **Note the time** (UTC). It is the restore point if anything goes wrong below.
2. Production web app, **Configuration**, add the application setting `SKIP_MIGRATIONS=true` and save. This stops the next restart re-applying the migration you are about to undo.
3. **Development Tools, SSH**, then:

   ```bash
   cd /home/site/wwwroot
   node dist/db/cli.js status                                # what is applied, and which have down scripts
   node dist/db/cli.js rollback --to 001_initial_schema.sql  # undoes everything after this one, newest first
   node dist/db/cli.js status                                # confirm
   ```

   Each step runs in one transaction. If a down script fails, that step is rolled back, the migration stays applied, and nothing later is attempted. The command also refuses to start if any down script it would need is missing.
4. Redeploy the release that matches the schema you rolled back to (7.1). Until it is live (about five minutes) the running build expects columns that are no longer there and some screens show errors; that is why this is done outside distribution hours.
5. Remove `SKIP_MIGRATIONS` and save.
6. Check `/api/v1/health` and sign in.

Erasures and anonymisations (the user guide, *When someone leaves* and *Data retention*) are never brought back by a rollback: removing personal data is meant to be permanent.

### 7.4 Last resort: point-in-time restore

If data was damaged in a way no down script can repair, restore the database to the time noted in 7.3 step 1 (backups are kept for 7 days):

```bash
az postgres flexible-server restore -g rg-sizaniconnect \
  --name pg-sizaniconnect-<suffix>-restored --source-server pg-sizaniconnect-<suffix> \
  --restore-time "2026-11-05T19:00:00Z"
```

Then point the app at the restored server: add the web apps' outbound IPs to its firewall (re-run the firewall part of `infra/azure-setup.sh` with `PG=pg-sizaniconnect-<suffix>-restored`), change `DATABASE_URL` in the app settings to the new host, and redeploy the matching release. Anything saved after the restore point is lost and must be re-entered from paper, so this is for genuine emergencies only. Expect about an hour (NFR-07 allows four).

## 8. Email (optional)

Without `SMTP_URL`, password-reset emails are not sent, and activation and reset links are shown to the administrator instead so they can be handed over in person. To send real email, add application settings such as:

```
SMTP_URL=smtps://<user>:<password>@smtp-relay.brevo.com:465
MAIL_FROM=SizaniConnect <no-reply@your-domain>
```

## 9. Cost

Roughly R560 per month in South Africa North (App Service B1 about R290, PostgreSQL B1ms with 32 GB about R230, data transfer about R40), covered for several months by the Azure for Students credit. Storage auto-grow adds about R2.50 per extra GB per month only if it is ever used. **Stop or delete the resource group after the module is marked:** `az group delete -n rg-sizaniconnect`.
