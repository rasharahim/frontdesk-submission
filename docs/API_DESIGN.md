# REST API design

Prefix every route with /api. Requests and responses are JSON except empty 204. Use exact Zod schemas, reject unknown fields, accept UUID IDs and ISO timestamp output. Error envelope is { error: { code, message, fieldErrors? } }. Common failures are 400 invalid input, 401 missing/expired session, 403 role or assignment denied, 404 missing or invisible resource, 409 invalid transition and 500 generic unexpected error. Return 429 for login throttling and 503 for database unavailability. Never send SQL errors, stack traces or private content. Send Cache-Control: no-store on authenticated data. Authorization is documented in [Architecture](ARCHITECTURE.md).

| Method and route | Actor | Request and validation | Success response | Business rule and transaction |
|---|---|---|---|---|
| GET /health | Anyone | None | 200 { status: ok, service: frontdesk } | Process check, no database access |
| GET /ready | Anyone | None | 200 { status: ready } | Execute a lightweight DB query, return sanitized 503 on failure |
| POST /auth/login | Anonymous | email, password, valid email, 1–72 password bytes | 200 User + session cookie | Verify bcrypt, generic 401, insert session |
| GET /auth/me | Signed in | None | 200 User | Read verified session and active account |
| POST /auth/logout | Signed in | None | 204, clear cookie | Delete current session |
| POST /tickets | Customer | subject 1–160, body 1–4,000, priority enum, optional sourceTicketId | 201 TicketDetail | Owner derived from session, source must be owned and terminal. Create ticket, description, clocks and audit together |
| GET /tickets | Signed in | status, priority, q max 160, page 1–1,000, limit 1–50. Agent-only scope mine/unassigned/all and sla overdue/historical | 200 { items: TicketSummary[], page, limit, total, counts? } | Scope first, search subject/exact UUID, stable createdAt/id order. Bounded catch-up before read. Agent counts over selected scope/search/priority before status/SLA filters |
| GET /tickets/:id | Signed in | UUID | 200 TicketDetail | Scope by owner or staff, reconcile ticket and use consistent authorized reads |
| POST /tickets/:id/claim | Agent | Empty | 200 TicketSummary | Conditional update and audit. 409 if already assigned or not Open |
| POST /tickets/:id/public-replies | Assignee | body 1–4,000 | 201 Message | Open/Waiting. Update pending response and audit inside ticket transaction |
| POST /tickets/:id/internal-notes | Assignee | body 1–4,000 | 201 staff Message | Open/Waiting. Insert private note and audit inside ticket transaction |
| POST /tickets/:id/wait | Assignee | body 1–4,000 | 200 TicketDetail | Open only. Write public question, pause SLA and set closure cutoff with audit |
| POST /tickets/:id/customer-replies | Owner | body 1–4,000 | 201 Message | Open or waiting before cutoff. Persist message and resume if required in ticket transaction |
| POST /tickets/:id/resolve | Assignee | optional body 1–4,000, required if no first response | 200 TicketDetail | Open only. Write any public reply, finalize clocks and audit |
| POST /tickets/:id/reopen | Owner | body 1–4,000 | 200 TicketDetail | Resolved and inside cutoff. Append explanation and start next resolution clock. Expired returns 409 REOPEN_EXPIRED |
| PATCH /tickets/:id/priority | Assignee | priority enum and reason 1–500 | 200 TicketDetail | Open or Waiting. Reject unchanged priority. Audit recalculation in same transaction |
| GET /tickets/:id/audit | Agent | Optional afterId (decimal string) and limit 1–100 | 200 { items: AuditEvent[], nextAfterId } | Staff only. Reconcile ticket and paginate by event ID. Exclude note text and credentials |

User includes id, displayName and role. Customer TicketSummary includes id, subject, priority, status and createdAt. Staff TicketSummary additionally includes assigned agent display name and id, staff activity time, and SLA deadlines/current and historical flags. TicketDetail extends the appropriate summary with ordered messages and applicable reopen or close information. Agent detail includes all SLA cycle results. Message exposes id, author display name, createdAt, body and public role or internal label where authorized. AuditEvent includes id as decimal string, event type, actor, effectiveAt, recordedAt and type-specific bounded metadata. No holiday HTTP endpoint is needed. Operator configuration uses the Holiday table and a seed script. All bounds apply after trimming. Claim conflict responses do not disclose private content.
