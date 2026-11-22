# Phase 9 deployment

## Live deployment

- **Application** [Frontdesk](https://frontdesk-submission.onrender.com)
- **Source** [Private deployment repository](https://github.com/rasharahim/frontdesk-submission), deployed snapshot `b1fa6a2318f7ce5219f3b8d61ec72aa0a5ef52c6` on `main`
- **Region and plans** Oregon (US West). Render Free Node web service and Render Free PostgreSQL 17. The workspace is Hobby with no payment method. No existing service was changed.
- **Provisioned** November 22, 2026. The web service reported Live after 51.4 seconds and listened on the platform's port 10000. Its health check is `/api/health`.
- **Database availability** Render's 30-day Free policy implies December 22, 2026, based on the reported creation date. The precise dashboard expiry was unavailable. The documented lifetime and reported allowances cover November 29 if submitted November 22, subject to shared usage, maintenance and restarts.
- **Runtime configuration** `NODE_ENV=production`, exact HTTPS `APP_ORIGIN`, `TRUST_PROXY=false`, and a certificate-verified restricted `DATABASE_URL`. The migration owner credential remains outside the web service.

## Acceptance evidence

Public HTTPS returned 200 for login HTML, a built static asset, a nested route, health and readiness. The health payload was `{"status":"ok","service":"frontdesk"}`. The readiness payload was `{"status":"ready"}`. Unknown API and asset paths returned 404. The successful 52-request API scenario checked all four synthetic logins, Secure, HttpOnly, SameSite=Lax, host-only session cookie flags, a rejected cross-origin write, revocation and role boundaries. One independent Chrome run verified the deployed interface with synthetic data, including five viewport widths (1440, 1024, 768, 390 and 360 px), nested refresh, audit view, logout and customer note exclusion.

- **INC-0291 PASS** ? Concurrent hosted claims on FD-1 returned one 200 and one 409. PostgreSQL showed one assignee and one claim event with the matching actor. Claiming left the SLA rows unchanged. The losing agent's write returned 403.
- **INC-0304 PASS** ? The private note was visible to authorized staff and absent from customer detail, list, search, mutation responses and the deployed customer DOM. Customer staff-only operations were rejected.
- **INC-0318 PASS** ? The paginated audit API returned 12 ordered entries for FD-1. Actor identity, ticket, actions and timestamps were checked. The restricted runtime could read and append audit data and was denied audit changes, deletion, truncation, trigger disabling, correction edits, calendar edits, and changes to a completed SLA clock.
- **SLA and lifecycle PASS** ? UTC sessions were verified. FD-1 opened on Sunday at 06:52:03.824 UTC. The Medium deadlines were November 23 08:30 UTC (14:00 IST) and November 25 13:00 UTC (18:30 IST). The hosted workflow completed first response, paused for waiting, resumed on a customer reply, upgraded priority, resolved and reopened to resolution cycle 2 while preserving cycle 1.
- **Local regression** ? 156 passed, 0 failed, 0 skipped. Prisma validation and generation, strict TypeScript, both builds and npm audit passed with zero reported vulnerabilities.

The four recorded migrations were applied by `frontdesk_prod_owner` over TLS. The separate `frontdesk_prod_runtime` login owns no application objects and has no privileged membership. One published calendar with no special holiday entries, two synthetic agents and two synthetic customers were initialized. The live acceptance added one ticket through the application. Accounts are `anika.agent@example.test`, `dev.agent@example.test`, `leena.customer@example.test`, and `omar.customer@example.test`. Supply the generated evaluator password separately through an approved secure channel. Do not include it in public notes or the repository.

The first live request completed in 391 ms. This was a reachable-service measurement. A natural suspend and wake and an actual hosted overdue auto-close during suspension were not observed. Local controlled scheduler and catch-up tests passed. Render documents spin-down after 15 idle minutes and a wake-up of about one minute. No keepalive was configured.
