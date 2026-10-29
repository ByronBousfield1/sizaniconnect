# Performance test results

How SizaniConnect measures against the performance requirements in the Task 1 documentation, and how to repeat the test.

## Result

Measured on 30 October 2026 with `api/scripts/load-test.ts`, on the v1.1.0 code.

| Requirement | Operation | Requests | Concurrent | Errors | p50 | p95 | Target (p95) | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| NFR-01 | Household search by name (5,000 households) | 1000 | 25 | 0 | 329 ms | 431 ms | 2.0 s | Met |
| NFR-01 | Event desk lookup by reference code | 1000 | 25 | 0 | 58 ms | 91 ms | 2.0 s | Met |
| NFR-02 | Record a collection, including FEFO stock deduction | 300 | 10 | 0 | 80 ms | 647 ms | 1.5 s | Met |
| NFR-03 | Monthly report on screen | 20 | 2 | 0 | 57 ms | 88 ms | 8.0 s | Met |
| NFR-03 | Monthly report CSV export | 20 | 2 | 0 | 49 ms | 70 ms | 20.0 s | Met |

Data: 5,050 households (NFR-01's 5,000 plus the demo set) and about 19,000 collections over six months of weekly distribution days at six sites.

Camera scanning of a household card (acceptance criterion AC-09.7) is measured by the end-to-end suite instead: about 2 seconds on a 360 px phone with the CPU slowed six times, against a limit of 5 seconds.

## What the numbers mean

- **Recording a collection** has a wider spread (p50 80 ms, p95 647 ms) because ten desks recording at once all take stock from the same batches. Each collection locks the batch rows it draws from so that two desks can never issue the same last bag of maize; the waiting is that lock doing its job. Ten simultaneous desks is more than any one site runs.
- **Search** is the slowest read because a name search matches anywhere in the name (`ILIKE '%...%'`), which reads every row. At 5,000 households that costs about a third of a second. NFR-05 allows growth to 10,000; if search ever nears its limit, a trigram index (`pg_trgm`) on the name is the planned fix.
- **Reports** are fast because the monthly figures are a handful of aggregate queries over indexed columns (`ix_events_site_date`, `ix_collections_event`).

## Limits of this test

- It ran in a local 2-vCPU, 7 GB Linux container with the API (production build, `NODE_ENV=production`) and PostgreSQL 16 on the same machine, not on Azure. Azure B1 gives the app one vCPU and B1ms gives the database one burstable vCPU, so production will be somewhat slower; the margins above (at least 2x on every target) are the allowance for that.
- There was no network between client and server. From Johannesburg to the South Africa North region adds roughly 20 to 40 ms per request, and a slow mobile connection adds more; neither changes the server-side figures.
- Every request came from one address, so the general rate limit was raised for the test. In production it stays at 1,000 requests per minute per address, which one busy site sharing a mobile-data address does not approach.

## Repeating it

```bash
createdb sizani_perf                                   # the script refuses any database without "perf" in its name
cd api
DATABASE_URL=postgresql://sizani:sizani@localhost:5432/sizani_perf npm run seed
npm run build
NODE_ENV=production PORT=8095 DATABASE_URL=postgresql://sizani:sizani@localhost:5432/sizani_perf \
  JWT_SECRET=<32+ characters> ID_HASH_PEPPER=<32+ characters> APP_BASE_URL=http://localhost:8095 \
  RATE_LIMIT_PER_MINUTE=1000000 node dist/server.js &
LOAD_DATABASE_URL=postgresql://sizani:sizani@localhost:5432/sizani_perf LOAD_BASE_URL=http://localhost:8095 \
  npx tsx scripts/load-test.ts
```

The script tops the database up to 5,000 households with history on its first run, then prints the table above.
