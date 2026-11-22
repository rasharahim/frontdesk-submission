# Test plan

Use Vitest for pure functions, Supertest against Express, and isolated real PostgreSQL with migration and runtime connections. Inject one deterministic clock and explicit calendars. Use independent connections and a barrier for races. Fail the suite on missing integration DB configuration when running integration tests. Never run destructive setup against production. Phase 2 foundation suites are available via npm test and npm run test:db. Phase 3 adds real database API tests for identity, sessions, roles, scope, concurrency-safe ticket references, message visibility and transactional audit rollback. The fixture owner connects only to the isolated test DB. Each run uses unique synthetic identities so append-only audit rows are retained. The rollback regression temporarily adds an insert-rejection trigger in the test database and removes it after the check. Phase 4 runs deterministic calendar/clock tests and real PostgreSQL SLA tests for exact and late replies, concurrent completion, transactional rollback, staff filters, calendar versions and repeatable initialization. The isolated repair suite verifies target validation, shifted deadline reconstruction, rollback, idempotency, active filtering, immutable completed records, runtime permissions, and direct SQL epoch reads under different session timezones. Phase 5 adds real lifecycle API races, audit and SLA write rollback, startup catch-up, bounded batches, and deterministic scheduler tests. Run `npm test` and `npm run test:db`. Phase 6 provides dedicated incident acceptance checks. The full dashboard is deferred. Export and notification channels are absent.

## Incident traceability

| Incident | Evidence |
|---|---|
| INC-0291 | `server/test/incidents.db.test.ts` runs five races with separate app instances and pools, observing both PostgreSQL lock waits before releasing the fixture lock. It also checks eligibility, identity spoofing, same-agent repeats, distinct tickets, customer reply interaction and claim audit rollback. |
| INC-0304 | The same suite verifies an escaped private canary across customer list, detail, search, create, reply, reopen and error paths. It checks staff visibility, state/clock equality and note audit metadata. Baseline tests cover waiting notes and privacy. |
| INC-0318 | The incident suite checks actor and timestamp accuracy, cursor traversal, system closure and restricted role bypass attempts. `db.test.ts` checks direct audit mutation denial and trigger behavior. SLA repair and lifecycle suites cover historical protections and rollback. |

Run `npm run db:validate`, `npm run db:generate`, `npm test`, `npm run test:db`, `npm run typecheck`, `npm run build`, and `npm audit` from the repository root. Start `npm run dev` for the README walkthrough. The database suite uses restricted test runtime credentials and a separate fixture owner. Append-only rows remain as isolated synthetic evidence.

## Regression coverage

| Scope | Cases and expected results |
|---|---|
| Calendar unit | Before open, exact opening, immediately before close, exact close, overnight, weekend, festival and adjacent excluded days. Verify milliseconds, UTC conversion, Friday 18:00 urgent, Saturday Medium and exact close deadlines against SLA examples |
| Clock unit | All six targets, exact deadline on time, +1 ms breach, urgent 120-minute cutoff, both wait cycles, pause exactly at deadline, zero-time resume, early/off-hours actions, resolution after first public response |
| Reprioritization unit/integration | Tighten and relax running and paused clocks. Exercise equal and exceeded budgets, no restart, completed response remains fixed, earlier breach survives downgrades and reopens. Check audit deadline context |
| Public response integration | Claim, note and customer message do not satisfy response. Public question does. Resolve without earlier reply requires a public message. Late first reply and late resolution preserve both outcome and audit |
| Lifecycle integration | Repeated waits restore exact remaining time. Note/follow-up does not resume or reset inactivity. Closure wins at exact cutoff, holidays shift cutoff, delayed processing records both timestamps, two workers or worker and reply produce one valid transition. Reruns append no duplicate events |
| Reopen integration | Reopen just before expiry, reject at and after expiry, reject other owners and inactivity closure, retain assignment and original clocks, new cycle due as documented, new ticket after expiry starts fresh |
| Claim integration | Two agents send simultaneous claims, exactly one succeeds and one 409. Assert persisted winner and one audit event. Non-assignee cannot write even with stale UI |
| Authorization and privacy integration | Anonymous 401, role denial, foreign IDs 404, disabled session, logout and cookie/origin behavior. Customer sentinel checks on lists, detail, search, counts, audit and all response metadata. Staff sees note. For any future export apply same sentinel test |
| Audit integration | Real runtime role SELECT/INSERT permitted, UPDATE/DELETE/TRUNCATE denied, no ownership or privilege escalation. Exercise trigger via a role with DML grant in test DB. Verify actor, order, effective/recorded times and message link |
| Atomicity integration | Force audit insert failure after business mutation and message insert, verify all rows roll back. Force failure during auto-close, verify retry creates one event. Verify stale claim/state and invalid transitions leave no business changes |
| API integration | Wrong content types, body too long, malformed UUID/email, extra fields, invalid enums, impossible pagination, scope denial, 409 handling and safe generic errors |
| UI manual or focused component tests | Login as each role, search/filter queue, identify overdue vs past breach, claim/conflict refresh, visibility of note composer, wait/customer reply/resolve/reopen, expired action, loading/empty/error, keyboard and narrow viewport |
| Hosted smoke | Fresh browser login, static deep link, both roles, two-agent claim, configured holiday, cold start, persistence after restart, role grants and available review window |

## Phase 7 frontend verification

- `npm run test:client` covers role navigation, server query construction and customer filter isolation, same-origin session requests, claim conflicts, network errors, escaped messages, paused timing, breach history, and missing timing.
- `npm run test:browser -w client` uses local Chromium and the isolated PostgreSQL test database. It exercises the rendered login, queue, ticket submission, staff claim and conflict, public and private composers, lifecycle transitions, audit paging, logout and session expiry. The browser test uses restricted runtime credentials for HTTP activity and test owner credentials for synthetic account fixture setup.
- Inspect the screenshot directory `.tmp/phase7/` locally. Check tab focus, useful status announcements and horizontal overflow at 1440, 1024, 768, 390 and 360 pixels. Phase 8 expands cross-browser, assistive technology and edge-case coverage.
