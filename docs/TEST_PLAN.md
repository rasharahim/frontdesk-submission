# Test plan

Use Vitest for pure functions, Supertest against Express, and isolated real PostgreSQL with migration and runtime connections. Inject one deterministic clock and explicit calendars. Use independent connections and a barrier for races. Fail the suite on missing integration DB configuration when running integration tests. Never run destructive setup against production. Planned only.

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
