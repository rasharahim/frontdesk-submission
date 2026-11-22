# Frontdesk

Frontdesk is a support workspace for Arvo Systems. Agents can triage and claim tickets, manage public replies and private notes, and review SLA timing and audit history. Customers can manage their own requests, reply, and reopen eligible tickets.

## Prerequisites

Use free Node.js 22.12+ within the 22.x LTS line or Node.js 24 LTS, npm 10+, Git, and local PostgreSQL 17. The project uses React, Vite, TypeScript, Tailwind and Lucide React on the client. The server uses Express, Zod, Helmet, Prisma and bcrypt. Vitest and Supertest cover the HTTP and database foundation. No Docker, paid services or external accounts are needed.

Run the following from the repository root in Windows CMD. If your PostgreSQL installation uses a different location, use its actual psql and pg_isready paths.

```cmd
node --version
npm --version
git --version
"C:\Program Files\PostgreSQL\17\bin\pg_isready.exe" -h localhost -p 5432
npm ci
```

Official installers are available from [Node.js](https://nodejs.org/en/download), [Git](https://git-scm.com/install/windows) and [PostgreSQL](https://www.postgresql.org/download/windows/).

## Local database roles

Run the bootstrap once. It stops if any of the named databases or roles already exist. Enter the local PostgreSQL administrator password at the first prompt. Choose four separate passwords when psql prompts for the owner and runtime roles. Keep passwords in your password manager or another secure local store.

```cmd
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -X -h localhost -p 5432 -U postgres -d postgres -W -f server\scripts\bootstrap-local.sql
```

PowerShell users should prefix the same quoted executable with the call operator `&`. The administrator role provisions databases and roles only. The application runs as `frontdesk_dev_runtime`, and database tests run as `frontdesk_test_runtime` with a separate test owner connection for setup and trigger tests. The owner roles run migrations. Both runtime roles inherit table grants from the NOLOGIN `frontdesk_runtime_access` group and can connect only to their own Frontdesk database among the two provisioned targets.

## Private environment files

Copy the examples once and edit the resulting ignored files locally. Keep owner URLs out of `.env`. Never place the PostgreSQL administrator login in these files.

```cmd
copy .env.example .env
copy .env.migrate.example .env.migrate
copy .env.test.example .env.test
```

For each URL use the form `postgresql://ROLE:ENCODED_PASSWORD@localhost:5432/DATABASE`. Substitute the role and database below. Percent-encode the password component, including characters such as `@` → `%40`, `:` → `%3A`, `#` → `%23`, `%` → `%25` and spaces → `%20`. Keep this work local and avoid putting the password in command history or an online encoder. Quote the complete URL in each environment file if needed.

| File | Variable | Role | Database |
|---|---|---|---|
| `.env` | `DATABASE_URL` | `frontdesk_dev_runtime` | `frontdesk_dev` |
| `.env.migrate` | `MIGRATION_DATABASE_URL` | `frontdesk_dev_owner` | `frontdesk_dev` |
| `.env.migrate` | `TEST_MIGRATION_DATABASE_URL` | `frontdesk_test_owner` | `frontdesk_test` |
| `.env.test` | `TEST_DATABASE_URL` | `frontdesk_test_runtime` | `frontdesk_test` |

Set `DEV_SEED_PASSWORD` in `.env.migrate` to a separate 12–72 UTF-8 byte password for synthetic application accounts. The server loads only `.env` locally. `NODE_ENV` defaults to development, `PORT` to 3000, and `BUSINESS_TIMEZONE` to Asia/Kolkata. `SESSION_COOKIE_NAME` defaults to `frontdesk_session` and `SESSION_TTL_HOURS` defaults to 8. In production set `APP_ORIGIN` to the exact public HTTPS origin without a trailing slash. In development leave it unset to allow local Vite and backend origins, or set an explicit origin. Keep `TRUST_PROXY=false` for direct local requests. Enable it only behind a trusted single reverse proxy.

## Generate, migrate, seed, and run

```cmd
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npm run db:seed
npm run db:sla:backfill
npm run dev
```

The migration commands use Prisma Migrate deploy to apply checked-in SQL to the dedicated local database using its owner role. They do not need a shadow database, CREATE DATABASE privilege or a reset. The seed is development-only and idempotent. It defines two agents, two customers, four tickets, public and private messages, and one sample holiday. Existing demo accounts retain their original hashes on reruns. Run the restricted development backfill after seeding to initialize reconstructable legacy clocks. It reports initialized tickets and clocks and unresolved cases. It keeps stored fixture timestamps and existing clocks intact. Historical resolution clocks remain unavailable when the activity record lacks reliable timing evidence.

Open **http://127.0.0.1:5173**. Sign in with a seeded account to open the appropriate workspace. The Vite proxy forwards API requests to Express. Direct backend endpoints are **http://127.0.0.1:3000/api/health** and **http://127.0.0.1:3000/api/ready**. Health is independent of PostgreSQL. Readiness returns 503 and a safe JSON error if its database check fails.

```cmd
npm run dev:client
npm run dev:server
npm run typecheck
npm run build
npm test
npm run test:client
npm run test:db
```

Use the two `dev:*` commands separately if you prefer separate terminals. The server uses the TypeScript compiler watch and Node watch on Windows. Database maintenance commands compile to an ignored local directory before running. `npm test` runs HTTP/configuration and deterministic SLA tests without an external database. `npm run test:db` requires the migrated isolated test database. Its audit fixtures roll back rather than being deleted. `npm run build` compiles both workspaces, and `npm start` runs the compiled Express server. Express serves `client/dist` in production mode. Production-mode runtime variables are supplied by the process environment.

## Try the APIs locally

The synthetic accounts are `anika.agent@example.test`, `dev.agent@example.test`, `leena.customer@example.test`, and `omar.customer@example.test`. Use the configured seed password locally. If it changed after seeding, the existing account hashes are retained.

For a browser walkthrough:

1. Sign in as Leena and select **New ticket**. Submit a synthetic request and note the reference in the detail header.
2. Open a separate browser profile, sign in as Anika, select **Unassigned**, and search for the reference. Open the ticket and select **Claim ticket**.
3. Send a **Public reply**, then switch to **Internal note** and add a synthetic note. The amber note stays in the staff conversation. Leena's conversation contains the public reply.
4. As the agent, select **Request information**, enter the public question, and send it. Check the paused resolution clock and waiting cutoff. As Leena, reply to the question to resume the ticket.
5. As the agent, refresh the ticket, change its priority with a reason, and resolve it. As Leena, reopen it with a message before the 168-hour cutoff. The agent can inspect the new resolution cycle and the previous cycle.
6. Open **Audit history** to view the recorded actions. If more events exist, select **Load more activity**.

The queue uses server filtering, server counts, and server pagination. Its counts follow the current assignment, subject search, and priority filters. Customer routes use public data. Staff routes display separate first-response and resolution clocks, with working time supplied by the server and timestamps formatted in IST. A null clock shows unavailable timing.

Run `npm run test:client` for frontend rendering and API-client tests. After a production build and setup of the isolated test database in `.env.test` and `.env.migrate`, run `npm run test:browser -w client` on Windows with Chrome installed. Set `FRONTDESK_CHROME_PATH` locally if Chrome is installed at a different path. The browser check listens on port 3077, creates synthetic accounts and tickets in `frontdesk_test`, and saves screenshots to the ignored `.tmp/phase7/` directory. Existing audit records are retained. Use a fresh synthetic ticket for each claim demo.

Sessions use a host-only, HttpOnly, SameSite=Lax cookie with Secure in production. Writes require an allowed Origin or a same-origin Referer fallback. The process-local login limiter resets when the server restarts, is not shared across instances, and can temporarily throttle legitimate traffic sharing an IP or account. Session expiry and logout invalidate use immediately. Phase 3 retains expired and revoked rows.

## Lifecycle demo and reconciliation

Run `npm run db:lifecycle:demo` after the development seed. It creates assigned synthetic tickets called **Lifecycle demo: awaiting an export sample** and **Lifecycle demo: resolved export settings**. A rerun preserves both tickets and later changes. Use `dev.agent@example.test` and `omar.customer@example.test` with the existing local demo password. The agent can find both tickets under `scope=mine`. The customer can post to `/api/tickets/:id/customer-replies` on the waiting ticket and `/api/tickets/:id/reopen` on the resolved ticket. Both writes take a JSON body field. The waiting cutoff and 168-hour reopening window are based on when the demo is created.

The scheduler runs on startup and every 60 seconds while the service is awake. Set `LIFECYCLE_INTERVAL_SECONDS` to an integer from 1 to 3600 to change the interval. It checks bounded batches with PostgreSQL row locks and retries failures on the next tick. The app stops scheduling on shutdown and waits for the in-flight batch before disconnecting. Health and readiness keep their existing meanings. Authenticated detail and mutation requests reconcile the target. Queue reads catch up a bounded number of matching tickets before counting or filtering. Free hosting can suspend the process, which delays execution. The recorded logical cutoff remains the applicable closure time.

One pre-lifecycle waiting ticket has no reliable paused resolution clock or stored cutoff. It remains visible with null timing and rejects resume with `SLA_HISTORY_UNAVAILABLE`. The legacy resolved ticket can reopen if its recorded resolution instant is still within the window. The new cycle starts at 2 and the original missing cycle remains unavailable.

## Repeatable incident demonstrations

1. Sign in as `leena.customer@example.test` and create a fresh ticket through `POST /api/tickets` with a subject, body and priority. It appears under `scope=unassigned`. Use a fresh ticket for each claim trial.
2. In separate browser profiles, sign in as `anika.agent@example.test` and `dev.agent@example.test`. Open the same unassigned ticket in both profiles before either agent selects **Claim ticket**. Select it in both profiles. Expect one 200, one 409, and one CLAIMED event. Only the winner can post an assigned-agent reply.
3. As the winner, post a public reply and a synthetic private canary via `/internal-notes`. Check staff detail, then sign in as the owner and check detail and search. The owner sees public messages and no canary.
4. As an agent, request `GET /api/tickets/:id/audit?limit=2` and continue with its cursor. Check actor IDs, actions, and timestamps. As a customer, the same endpoint returns 403.

Use the existing local demo password without sharing or logging it. FD-5 and FD-6 are time-sensitive lifecycle examples. Verify their current eligibility before any evaluator walkthrough. Automated contention, privacy and database permission tests use only the isolated test database.

## Database integrity

Ticket references use a PostgreSQL sequence. Restrictive foreign keys retain history. Partial indexes support unassigned claims, public message history and unique active SLA clocks. A ticket points to a shared published holiday calendar version. Publish a new version for future tickets when holiday dates change. Existing tickets keep their calendar across reopening. Terminal SLA cycles, first breach timestamps and consumed time are protected against rewrites.

Audit rows accept inserts and reads through the runtime role. PostgreSQL permissions prohibit audit edits, deletes, truncation and DDL, and triggers reject update, delete and truncate statements even with ordinary DML permission. The migration owner, privileged DBAs and hosting administrators can alter these protections. The runtime role can append audit rows, so services must create truthful events in the same transaction as the corresponding ticket changes.

## Troubleshooting

- **Configuration error at startup:** Copy `.env.example` to `.env` and set the restricted development runtime URL.
- **Readiness returns 503:** Check `pg_isready`, then verify the runtime role and password with psql using `-W`, and confirm the URL is percent-encoded.
- **Database bootstrap preflight fails:** Check which Frontdesk roles or databases already exist. Preserve existing data and ask a local PostgreSQL administrator to finish the setup if it was interrupted. Avoid rerunning against another database.
- **Migration access denied:** Verify the owner URL and the bootstrap grants. Keep migrations separate from the runtime role.
- **Development port conflict:** Close the other process using 5173 or choose another backend `PORT` in `.env` for a 3000 conflict. The frontend proxy reads that backend setting.

Hosting and free-tier eligibility are reserved for Phase 9.
