# SLA rules proposed for review

| Priority | First public response | Resolution |
|---|---:|---|
| Urgent, customer blocked | 120 working minutes | Applicable workday close, with late-arrival rule below |
| Medium | 270 working minutes | 1,620 working minutes |
| Low, small requests/questions | 540 working minutes | 2,700 working minutes |

An uninterrupted workday has 540 minutes. The approved late-arrival engineering assumption reconciles the same-day target with the Friday evening example.

## Calendar and boundaries

Use Asia/Kolkata. Work intervals are Mon–Fri [09:30, 18:30) excluding operator-configured local holiday dates. A deadline can land exactly at 18:30. Sum intersections of active intervals with working intervals with millisecond precision. Advance by consuming interval capacity and skipping excluded dates. Outside hours the effective start is the next opening. Actions can occur before opening and count immediately if otherwise valid. Store UTC instants and display local timezone. Each ticket references one shared, published holiday calendar version. Publish a new version for edits. New tickets use the latest published version. Existing tickets and later resolution cycles keep their original version.

A qualifying action at its deadline is on time. An unfinished, running clock is late strictly after its deadline, including outside business hours once the deadline has passed. A pause at the exact deadline is on time and leaves zero budget. Resume at the later of the resume instant or next opening with a deadline at that instant when the remainder is zero. Compare against the old deadline before state or budget changes. First breach stores the missed deadline (or immediate escalation instant), with actual detection time on the audit row. Reviewers may see an overdue flag derived live before audit catch-up records it.

## Budgets, pauses and history

Create both clocks together. First response is the first committed, nonempty public message by the assigned agent, including a public question or an explicit resolution reply. Customer messages, claims and internal notes do not qualify. Enter Waiting by sending a public question atomically, satisfying first response if needed. Only the unfinished resolution clock pauses while Waiting. A customer reply before closure returns the ticket to Open, resumes the remaining budget and clears the inactivity deadline. Each later public request begins a new wait. Only a customer reply can resume a paused resolution clock. An agent follow-up leaves the pause and inactivity deadline intact. Internal notes never count as first response, change ticket status or affect SLA clocks. Resolve from Open, requiring a public reply in the transaction if first response is still outstanding.

For urgent resolution derive a working-time budget from the resolution cycle's effective start through its applicable close. If the start has at least 120 working minutes left that day, use that close. Otherwise use the next eligible workday's close, including the remainder of the current day in the budget. This also handles exact closing, which normalizes to next opening. On pause, retain elapsed and freeze the remainder. Resume using working-time addition, which can move an urgent deadline away from closing time.

For any priority change keep each unfinished clock's accrued active milliseconds and recompute the budget from the same cycle start, including urgent. Settle old breaches first. If elapsed exceeds the new budget, breach immediately at the change instant even if paused. If elapsed equals the budget, a running clock has an immediate deadline or the next opening when outside hours. A paused clock remains frozen at zero until resume. Otherwise reforecast using the remaining budget from the change or next resume. Completed response stays fixed. Keep the first breach marker per clock and cycle forever, even if a reduction puts the new deadline in the future. Audit the old/new deadline, budget and elapsed context. Show current lateness and past breach distinctly.

## Closure and reopening

Inactivity closes a continuous Waiting period after 2,700 working minutes. At the exact cutoff closure wins. Auto-close stops the paused resolution as CANCELED, retaining any existing breach, and records effective closure and actual processing time. Auto-closed tickets require a new ticket. For resolved tickets, permit the owner to reopen before resolvedAt + 168 hours. Exact expiry rejects. The customer can create a new ticket from the expired screen with a fresh SLA and optional source link to their own terminal ticket. Reopening keeps the assignee and original first-response result and starts a fresh resolution cycle using current priority and the ticket calendar. Earlier resolution outcomes and breach timestamps are retained without overwriting them.

## Worked examples

All times are local. Example dates are in 2026.

| Case | Inputs | Expected |
|---|---|---|
| Friday and weekend | Urgent Fri Nov 20 18:00, Monday eligible | Response Mon Nov 23 11:00, resolution Mon 18:30. Sunday morning neither overdue |
| Holiday | Same ticket with Mon Nov 23 excluded | Response Tue Nov 24 11:00, resolution Tue 18:30 |
| Outside hours | Medium Sat Nov 21 10:00 | Starts Mon 09:30, response Mon 14:00, resolution Wed 18:30 |
| Urgent boundary | Fri Nov 20 16:30, 16:31 or 18:30 | Resolution respectively Fri 18:30, Mon 18:30 and Mon 18:30. At 16:30 first response is due Fri 18:30 |
| Multiple waits | Medium Mon 09:30. Ask Mon 11:30. Customer replies Tue 10:30. Ask Tue 11:30. Customer replies Wed 09:30 | 180 minutes elapsed, 1,440 left, resolution Fri 15:30 |
| Change priority | Medium Mon 09:30, unanswered at 12:00, change to Urgent then to Low at 12:15 | First response breaches at 12:00 on escalation (150 > 120). Low response due Mon 18:30 with historical breach intact |
| Inactivity | Wait starts Fri Nov 20 18:00, no holidays | Closure effective Fri Nov 27 18:00 even if job runs later |
| Reopen | Medium resolved Fri Nov 20 16:00, reopened Mon Nov 23 10:00 | New resolution due Thu Nov 26 10:00, first response unchanged. For the original resolution, Fri Nov 27 16:00 is already outside the window |
