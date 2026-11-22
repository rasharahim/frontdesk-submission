# REST API design

Prefix every route with /api. Requests and responses are JSON except empty 204. Use exact Zod schemas, reject unknown fields, accept UUID IDs and ISO timestamp output. Error envelope is { error: { code, message, fieldErrors? } }. Common failures are 400 invalid input, 401 missing/expired session, 403 role or assignment denied, 404 missing or invisible resource, 409 invalid transition and 500 generic unexpected error. Return 429 for login throttling and 503 for database unavailability. Never send SQL errors, stack traces or private content. Send Cache-Control: no-store on authenticated data. Authorization is documented in [Architecture](ARCHITECTURE.md).

| Method and route | Actor | Request and validation | Success response | Business rule and transaction |
|---|---|---|---|---|
| GET /health | Anyone | None | 200 { status: ok, service: frontdesk } | Process check, no database access |
| GET /ready | Anyone | None | 200 { status: ready } | Execute a lightweight DB query, return sanitized 503 on failure |
| POST /auth/login | Anonymous | email, password, valid email, 1–72 password bytes | 200 User + session cookie | Verify bcrypt, generic 401, insert session |
| GET /auth/me | Signed in | None | 200 User | Read verified session and active account |
| POST /auth/logout | Signed in | None or empty JSON object | 204, clear cookie | Revoke current session |
| POST /tickets | Customer | subject 1–160, body 1–4,000, priority enum, optional sourceTicketId | 201 TicketDetail | Owner derived from session, source must be owned and terminal. Create ticket, description, clocks and audit together |
| GET /tickets | Signed in | status, priority, q max 160, page 1–1,000, limit 1–50. Agent-only scope mine/unassigned/all and sla overdue/historical | 200 { items: TicketSummary[], page, limit, total, counts? } | Scope first, search subject/exact UUID, stable createdAt/id order. Bounded catch-up before read. Agent counts over selected scope/search/priority before status/SLA filters |
| GET /tickets/:id | Signed in | UUID | 200 TicketDetail | Scope by owner or staff, reconcile ticket and use consistent authorized reads |
| POST /tickets/:id/claim | Agent | Empty | 200 TicketSummary | Ticket row lock, assignment and audit in one transaction. 409 if already assigned or not Open |
| POST /tickets/:id/public-replies | Assignee | body 1–4,000 | 201 Message | Open/Waiting. Update pending response and audit inside ticket transaction |
| POST /tickets/:id/internal-notes | Assignee | body 1–4,000 | 201 staff Message | Open/Waiting. Insert private note and audit inside ticket transaction |
| POST /tickets/:id/wait | Assignee | body 1–4,000 | 200 TicketDetail | Open only. Write public question, pause SLA and set closure cutoff with audit |
| POST /tickets/:id/customer-replies | Owner | body 1–4,000 | 201 Message | Open or waiting before cutoff. Persist message and resume if required in ticket transaction |
| POST /tickets/:id/resolve | Assignee | optional body 1–4,000, required if no first response | 200 TicketDetail | Open only. Write any public reply, finalize clocks and audit |
| POST /tickets/:id/reopen | Owner | body 1–4,000 | 200 TicketDetail | Resolved and inside cutoff. Append explanation and start next resolution clock. Expired returns 409 REOPEN_EXPIRED |
| PATCH /tickets/:id/priority | Assignee | priority enum and reason 1–500 | 200 TicketDetail | Open or Waiting. Reject unchanged priority. Audit recalculation in same transaction |
| GET /tickets/:id/audit | Agent | Optional afterId (decimal string) and limit 1–100 | 200 { items: AuditEvent[], nextAfterId } | Staff only. Reconcile ticket and paginate by event ID. Exclude note text and credentials |

## Current API contract through Phase 6

All routes in the table are implemented. Automatic closure is reconciled by the service and has no public route.

- Login and me return the user object directly. Raw session tokens are limited to the host-only cookie. A write requires an exact configured Origin, or the parsed Referer origin when Origin is absent. Missing both or an untrusted source gives 403. Body-bearing writes require JSON and return 415 otherwise. Development supports Vite and direct backend loopback origins. Production requires `APP_ORIGIN` over HTTPS. Login is limited to 10 attempts per normalized account and 30 per IP per 15-minute window with bounded, process-local storage.
- Creation stores the initial body as `description`, separate from follow-up messages. It uses the latest published calendar, allocates the unique `reference` in PostgreSQL and records the creation audit in the same transaction. An absent published calendar returns 503. A source identifier must refer to an owned terminal ticket.
- List defaults are `page=1`, `limit=20`, and agents default to `scope=mine`. Agents may use `scope=all`, `scope=unassigned`, or `assigneeId`. An assignment filter without scope implies `all`. Conflicting assignment filters return 400. Search uses case-insensitive literal subject text or exact ticket UUID or reference. Ordering is creation time then UUID, both descending. Agent summary counts respect scope, search and priority before status. Customer scope, assignment and SLA queries return 403. Agent `sla=overdue` selects tickets with any running clock past its deadline. The immediate over-budget reprioritization case also matches at the change instant. `sla=historical` selects any persisted first-breach marker. Both filters run in PostgreSQL before counting and paging. Queue overdue counts use the same evaluation instant and base filters as the items.
- Staff reads include assignment and stored waiting/closure timestamps. Customer reads return an explicit public projection, including reference, description and public messages on detail. Responses exclude ownership IDs, agent-only note metadata, and audit data.
- Staff mutations require assignment. Customer mutations require ownership. A due waiting ticket closes before the request returns `409 TICKET_CLOSED`. A customer reply strictly before cutoff resumes the existing resolution clock. Internal notes and public reminders leave the wait unchanged.
- `409 SLA_HISTORY_UNAVAILABLE` identifies missing or inconsistent timing evidence. `409 FIRST_RESPONSE_REQUIRED` asks for a real public reply when resolving an Open ticket without a completed response. `409 REOPEN_EXPIRED` directs the owner to create a new ticket at or beyond 168 elapsed hours. `409 PRIORITY_UNCHANGED` leaves all clocks and events intact. Other ineligible actions return `409 TICKET_STATE_CONFLICT`.
- Creation starts both clocks. Lifecycle writes commit messages, SLA changes, ticket timestamps and real audit evidence together. Queue reads reconcile up to 40 due tickets within role and search scope before status, SLA filtering or pagination. A remaining due backlog in scope returns retryable `503 LIFECYCLE_CATCH_UP`.

Staff `sla` includes `asOf`, `calendarVersion`, `historicalBreach`, and `response` and `resolution` clock objects. Staff SLA includes `resolutionHistoryIncomplete` when cycles are missing. Staff detail also includes earlier `resolutionHistory`. A clock includes kind, cycle, status, deadline, start/pause/completion timestamps, original and current budgets, consumed and remaining time, overdue working time, and first breach timestamp. Time amounts are integer milliseconds and instants are UTC ISO strings. Status is ACTIVE, OVERDUE, PAUSED, COMPLETED_ON_TIME, COMPLETED_LATE, COMPLETED_UNKNOWN, or CANCELED. An unavailable historical clock is null. The effective deadline for an immutable completed clock incorporates any verified owner-recorded correction. Running deadline repairs are stored on the active clock so filters and later timing mutations use the same value. Customer payloads omit the entire SLA object.

### Claim and audit contracts

Send an empty body or `{}` to claim. The assignee comes from the agent session. Success returns the staff ticket summary with `assignee: { id, displayName }`. The operation preserves ticket state, ownership and both clocks. The claim timestamp is the event effective time and ticket update time. An Open ticket already assigned returns `409 TICKET_ALREADY_CLAIMED`, including repeats by the same agent. Other states return `409 TICKET_STATE_CONFLICT`. Missing IDs return 404. There are no unassignment or reassignment routes.

Every authenticated agent can read staff audit history, irrespective of assignment. The endpoint accepts `limit` from 1 to 100, default 30, and an optional positive int64 decimal string `afterId`. Items are in ascending event ID order. Return `nextAfterId` as a decimal string if another page exists and null otherwise. Append order is deterministic even if automatic closure has an earlier logical `effectiveAt` than its actual `recordedAt`. User actor IDs remain stable when display names change. The response intentionally uses actor IDs and does not claim to preserve historical names.

```json
{
  "items": [
    {
      "id": "42",
      "ticketId": "10000000-0000-4000-8000-000000000001",
      "action": "CLAIMED",
      "actor": {"kind": "USER", "id": "10000000-0000-4000-8000-000000000002"},
      "effectiveAt": "2026-11-23T04:00:00.000Z",
      "recordedAt": "2026-11-23T04:00:00.010Z",
      "oldStatus": "OPEN",
      "newStatus": "OPEN",
      "details": {"previousAssigneeId": null, "assigneeId": "10000000-0000-4000-8000-000000000002"}
    }
  ],
  "nextAfterId": null
}
```

The event-specific metadata projection retains safe identifiers, transitions, priority changes and SLA measurements. It omits free-text priority reasons, message bodies and arbitrary JSON. A system actor has a null ID. Correction evidence is stored separately and is not mixed into this timeline.

### Customer response boundary and frontend handoff

A customer summary contains `id`, `reference`, `subject`, `status`, `priority`, and `createdAt`. Detail adds `description`, `resolvedAt`, `closedAt`, and `messages` with only CUSTOMER_PUBLIC and AGENT_PUBLIC kinds. Create initially returns an empty messages array. Reply returns the newly written CUSTOMER_PUBLIC message. Reopen returns the same filtered detail contract. Customer search uses owned ticket subjects, reference and ID. There are no message previews, note counts, standalone message endpoints, exports or notifications. Login, me and logout return identity or session results. Health and readiness expose service status. Unknown routes, validation and authorization errors use the safe error envelope.

Staff summaries additionally include assignee, update and waiting/closure times, and SLA. Staff detail can include INTERNAL messages and separate historical SLA cycles. An example public versus staff-only message shape is `{ id, kind: "CUSTOMER_PUBLIC", body, createdAt, author: { displayName } }` and the same shape with `kind: "INTERNAL"` on an agent-only response. Fetch only the authorized endpoint and keep distinct public and private composers. CSS or React hiding cannot enforce privacy.

The frontend can use same-origin session cookies with login, me and logout, select role-specific ticket views, and use the lifecycle routes from the table. Render waiting, overdue, mine, and unassigned queues with server pagination. Refresh the ticket and queue on a claim conflict. Render a loading state while fetching, an empty state for successful empty results, a sign-in transition on 401, an authorization or missing state on 403/404, and a retry state for 503. Use the staff audit cursor to page older append-order results. Display the approved reopening cutoff based on `resolvedAt` and keep the server authoritative.

User includes id, displayName and role. Customer TicketSummary includes id, subject, priority, status and createdAt. Staff TicketSummary additionally includes assigned agent display name and id, staff activity time, and SLA deadlines/current and historical flags. TicketDetail extends the appropriate summary with ordered messages and applicable reopen or close information. Agent detail includes all SLA cycle results. Message exposes id, author display name, createdAt, body and public role or internal label where authorized. AuditEvent includes id as decimal string, event type, actor, effectiveAt, recordedAt and type-specific bounded metadata. No holiday HTTP endpoint is needed. Operator configuration uses the Holiday table and a seed script. All bounds apply after trimming. Claim conflict responses do not disclose private content.

## Dashboard integration

Phase 7 uses the existing endpoints and fields. Queue context, search and paging are reflected in the browser URL. Staff queues show API counts scoped to assignment, search and priority. Customers send permitted search, priority and status filters only. The API does not supply a staff ticket owner's identity in the ticket summary, so the queue does not invent or look up that field.

A claim success uses the returned assignment. A conflict triggers a detail refresh. Audits are read on demand by agents and append by the server's decimal-string cursor. If an actor name is already available from the authenticated agent or confirmed assignee, the timeline shows it. Other human actors use the stable ID. Staff timing uses effective deadlines and server-calculated working durations. For resolved customers the local reopening hint uses the server's recorded resolution timestamp and the 168-hour window. All action decisions remain subject to server validation.
