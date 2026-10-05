# Task 2 implementation presentation: notes and demo script

The presentation is 20% of Task 2 and is meant to win the client's approval for implementation. Aim for 12 to 15 minutes.

## Structure

1. **The problem, in one slide.** Paper registers per site, so a household can collect twice; nobody knows what stock is on hand or near expiry; shifts filled over WhatsApp; donor reports take weeks.
2. **Live demo** (below). This is most of the time.
3. **How it meets the requirements.** Show the user-story table and the business-rule table from the README. Point out that BR-04 and the audit log are enforced by the database, not just the code.
4. **Architecture and technical decisions.** The mermaid diagram from the README, then the three decisions worth defending:
   - Same-origin hosting (why the Static Web Apps plan changed).
   - Business rules in the database where a race is possible.
   - The stack change from Task 1, and why the design survived it unchanged.
5. **Security.** The threat table. Demonstrate one control live: the lockout, or the duplicate-parcel race.
6. **DevOps.** Show the Actions tab: a green CI run, the deploy to staging, the approval gate on production, the smoke test proving the deployed SHA.
7. **Challenges overcome.** Pick two: the refresh-token revocation that was being rolled back with the failed request (found by a test), the rate limiter that locked out volunteers sharing one mobile-data IP, or the database type error that only appeared against real PostgreSQL.

## Demo script

Have three browser windows signed in: coordinator, volunteer (phone-sized), operations manager.

1. **Coordinator, event desk.** Enter a household code in lower case with an O for a zero. It still finds the household. Record the collection: the stock that was deducted is listed.
2. **Same code again.** The red verdict: already collected, by whom, at what time. Show that a volunteer cannot override, then approve a second parcel as the coordinator with a reason.
3. **Operations manager, overview.** The event's issue count has moved. Open the household: the override is in its history.
4. **Register a household** with the same ID number as an existing one at another site. Refused, naming the existing household.
5. **Stock.** The expired tea is flagged; write it off. Milk expiring soon is listed first for issue.
6. **Volunteer on the phone.** Check in to today's shift; sign up for a future one.
7. **Reports.** September: households counted once across sites. Download the CSV.
8. **Donor.** Kopano Foods sees the households their goods reached.
9. **Admin, audit log.** Every step above is there, with no personal values copied into it.

## Slides to include

- Title with client and team.
- Problem.
- Solution overview with the overview and event-desk screenshots (`docs/screenshots/`).
- Requirements coverage.
- Architecture diagram.
- Security controls.
- CI/CD pipeline and branching model.
- Running costs (from Task 1, updated with the real Azure tier).
- Next steps: offline capture at sites, SMS notifications, browser end-to-end tests.
