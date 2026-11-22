# Frontdesk

Frontdesk is a shared support desk for agents and customers. Agents claim, respond to, and resolve tickets from a queue with SLA indicators. Customers can open tickets, see public replies, respond to requests for information, and reopen eligible tickets.

**Live application:** [frontdesk-submission.onrender.com](https://frontdesk-submission.onrender.com)

## Hosted walkthrough

The evaluator password is supplied separately. Use separate browser profiles for the agent and customer sessions.

| Role | Account |
| --- | --- |
| Customer | `leena.customer@example.test` |
| Another customer | `omar.customer@example.test` |
| Agent | `anika.agent@example.test` |
| Second agent | `dev.agent@example.test` |

1. As Leena, create a fresh ticket and note its reference.
2. As Anika and Dev, open the ticket from **Unassigned** in separate profiles. Both try **Claim ticket**. One succeeds. The other sees a conflict and the winning assignee.
3. As the winning agent, send a **Public reply** and add a separate **Internal note** with synthetic text. Check that Leena sees the reply only.
4. Choose **Request information**. The resolution SLA pauses. Reply as Leena to resume it. As the agent, change priority with a reason, then resolve.
5. Reopen as Leena within 168 hours. As the agent, inspect the new resolution cycle and **Audit history** for actions, actors, and timestamps.

## Run locally

Use Node.js 22.12+ within Node 22 or Node 24, npm 10+, Git, and PostgreSQL 17 with `psql`. This repository uses npm workspaces. Commands below run from the repository root in Windows CMD. Adjust the PostgreSQL installation path for your machine.

```cmd
npm ci --include=dev
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -X -h localhost -p 5432 -U postgres -d postgres -W -f server\scripts\bootstrap-local.sql
copy .env.example .env
copy .env.migrate.example .env.migrate
copy .env.test.example .env.test
```

Run the bootstrap once on a local instance where the Frontdesk databases and roles do not already exist. PowerShell users can prefix the quoted executable with `&` and use `Copy-Item` for the templates. The bootstrap prompts for role passwords and creates separate development and test databases. The administrator provisions them. Owner roles run migrations and the development seed. Runtime roles have restricted application access.

Fill the ignored files locally. Use the URL pattern `postgresql://ROLE:ENCODED_PASSWORD@localhost:5432/DATABASE` and percent-encode the password component.

| File | Variable | Role | Database |
| --- | --- | --- | --- |
| `.env` | `DATABASE_URL` | `frontdesk_dev_runtime` | `frontdesk_dev` |
| `.env.migrate` | `MIGRATION_DATABASE_URL` | `frontdesk_dev_owner` | `frontdesk_dev` |
| `.env.migrate` | `TEST_MIGRATION_DATABASE_URL` | `frontdesk_test_owner` | `frontdesk_test` |
| `.env.test` | `TEST_DATABASE_URL` | `frontdesk_test_runtime` | `frontdesk_test` |

Set a separate local `DEV_SEED_PASSWORD` in `.env.migrate`, with 12–72 UTF-8 bytes. Keep `NODE_ENV=development`, `PORT=3000`, and `TRUST_PROXY=false` for the default local setup.

```cmd
npm run db:validate
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npm run db:seed
npm run db:sla:backfill
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and use one of the accounts above with your **local** seed password. The local API is at `http://127.0.0.1:3000/api`. Its health and database readiness endpoints are `/api/health` and `/api/ready`. Use fresh tickets for the evaluator workflow. The development seed includes older fixtures with documented SLA history gaps.

### Test and build

```cmd
npm test
npm run test:client
npm run test:db
npm run typecheck
npm run build
npm start
```

Database tests require the migrated isolated test database. For the Windows browser harness, run `npm run test:browser -w client` after building, with Chrome installed and the same test database configured. Set `FRONTDESK_CHROME_PATH` if Chrome is installed elsewhere.

For production serving, run the build and start commands above with `NODE_ENV=production`, a restricted `DATABASE_URL`, and `APP_ORIGIN` set to the exact HTTPS origin without a trailing slash. Set `PORT` as required by the host. Supply runtime configuration through the process environment. Express serves the compiled frontend and API from one origin. Migrations run separately with the owner connection.

## Architecture and SLA rules

React, TypeScript, Vite, Tailwind CSS and Lucide form the frontend. Express, TypeScript, Prisma and PostgreSQL implement the API and persistence. Authentication uses bcrypt and database-backed, revocable cookie sessions.

- **Concurrent claiming.** A PostgreSQL row lock serializes claims. Assignment and its audit event commit together, and only the assigned agent can perform protected writes.
- **Private notes.** Customer queries and response models expose public conversation only. Staff notes and audit history are restricted server-side.
- **Immutable history.** Ticket mutations and audit inserts commit together. PostgreSQL grants and triggers protect audit and completed SLA history against application-level modification. Privileged database administrators remain inside the trust boundary.

Working time is Monday–Friday, 09:30–18:30 Asia/Kolkata, excluding dates in the published calendar pinned to each ticket. First-response budgets are 120, 270, and 540 working minutes for Urgent, Medium, and Low. Medium and Low resolution budgets are 1,620 and 2,700 minutes. Urgent resolution is due at the same working-day close if at least 120 working minutes remain at the effective start, otherwise at the next working-day close. Waiting pauses resolution timing, with automatic closure after 2,700 working minutes waiting. Manual resolution can be reopened strictly before 168 elapsed hours. [Detailed rules](docs/SLA_RULES.md)

## Development history

The [development-history branch](https://github.com/rasharahim/frontdesk-submission/tree/development-history) documents the project's incremental development, from initial planning and architecture through implementation, testing, and deployment. It preserves the original development milestones and commit chronology.

## Verified results and limitations

156 automated tests passed with zero failures or skips. The hosted deployment passed one 52-request API acceptance run and one Chrome acceptance run. Concurrent claiming, private note confidentiality, and audit immutability all passed. The local workflow also passed in Chrome and Edge.

The hosted holiday calendar contains no special dates. Firefox, WebKit, and comprehensive assistive-technology coverage were outside the completed verification. Local scheduler and reconciliation tests passed. Natural hosted cold-start duration and auto-close catch-up after an actual host suspension were not measured. Render Free can spin down after 15 idle minutes, and Render estimates about a minute to wake. The service can reconcile overdue work on startup and relevant requests. [Render Free limits](https://render.com/docs/free)

## Completion Note

**What I did not finish and why:** I prioritized completing and testing the core ticket workflow, SLA enforcement, concurrent ticket claiming, private-note confidentiality, and immutable audit history within the assessment timeframe.

I did not complete Firefox, WebKit, or comprehensive assistive-technology testing. Although scheduler and reconciliation tests passed locally, I did not verify automatic closure after an actual hosted suspension. The hosted demonstration calendar does not include special holiday entries.

The application uses Render's free tier, which can introduce a startup delay after inactivity.

Development was completed incrementally across ten tested phases in a separate private repository. This public repository contains the reviewed, sanitized application snapshot and evaluator documentation.
