import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, Clock3, History, LockKeyhole, MessageSquare, RefreshCw, Send, UserRound } from 'lucide-react'
import { ApiError, errorText, writeErrorText, type Request } from './api'
import type { AuditPage, Clock, Detail, Identity, Message, StaffDetail, StaffTicket } from './contracts'
import { priorities } from './contracts'
import { navigate } from './navigation'
import { useRead } from './resources'
import { Badge, Busy, Empty, Link, Notice, clockLabels, dateTime, duration, priorityLabel, statusLabel } from './ui'

const customerBase = '/customer/tickets'
type Operation = 'customer-replies' | 'public-replies' | 'internal-notes' | 'wait' | 'resolve' | 'reopen' | 'priority'
const actions: Record<Operation, { label: string; submit: string; success: string; hint?: string }> = {
  'customer-replies': { label: 'Reply to support', submit: 'Send reply', success: 'Reply sent.' },
  'public-replies': { label: 'Public reply', submit: 'Send reply', success: 'Public reply sent.', hint: 'Visible to the customer.' },
  'internal-notes': { label: 'Internal note', submit: 'Add internal note', success: 'Internal note added.', hint: 'Staff only. The customer cannot see this note.' },
  wait: { label: 'Request information', submit: 'Send question and wait', success: 'Ticket is waiting for the customer.', hint: 'Sends a public question and pauses resolution timing. A ticket may close after five working days without a customer reply.' },
  resolve: { label: 'Resolve ticket', submit: 'Confirm resolution', success: 'Ticket resolved.', hint: 'Completes the current resolution cycle. The customer can reopen within 168 hours.' },
  reopen: { label: 'Reopen ticket', submit: 'Reopen ticket', success: 'Ticket reopened.', hint: 'Tell support what still needs attention.' },
  priority: { label: 'Change priority', submit: 'Update priority', success: 'Priority updated.', hint: 'Changing priority may change deadlines. Recorded breaches are preserved.' },
}

function Back({ to }: { to: string }) {
  return <Link className="back" to={to}><ArrowLeft size={16} aria-hidden />Back to tickets</Link>
}

export function NewTicket({ request, back, source }: { request: Request; back: string; source: string | null }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const form = new FormData(event.currentTarget)
    const subject = String(form.get('subject')).trim()
    const body = String(form.get('body')).trim()
    if (!subject || !body) { setError('Enter a subject and description.'); return }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const ticket = await request<Detail>('/tickets', { method: 'POST', body: {
        subject, body, priority: form.get('priority'), ...(source ? { sourceTicketId: source } : {}),
      } })
      navigate(customerBase + '/' + ticket.id)
    } catch (failure) { setError(writeErrorText(failure, 'Check My tickets')) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <><Back to={back} /><header className="page-heading"><div><h1>New support ticket</h1><p>Tell the support team what you need help with.</p></div></header>
    <form className="card new-form" onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <label>Subject <input name="subject" maxLength={160} required placeholder="Summarize your request" /></label>
      <label>Description <textarea name="body" rows={6} maxLength={4000} required placeholder="Describe the issue and what you expected to happen." /></label>
      <label>Priority <select name="priority" defaultValue="MEDIUM">{priorities.map((p) => <option value={p} key={p}>{priorityLabel[p]}</option>)}</select>
        <small>Choose Urgent for issues blocking work.</small></label>
      <div className="actions"><button className="button primary" disabled={busy}><Send size={16} aria-hidden />{busy ? 'Creating…' : 'Create ticket'}</button><Link className="button secondary" to={back}>Cancel</Link></div>
    </form></>
}

export function Conversation({ description, createdAt, messages }: { description: string; createdAt: string; messages: Message[] }) {
  return <section className="card conversation"><h2><MessageSquare size={19} aria-hidden />Conversation</h2>
    <article className="message"><header><strong>Original request</strong><time dateTime={createdAt}>{dateTime(createdAt)}</time></header><p>{description}</p></article>
    {messages.map((message) => <article key={message.id} className={'message ' + (message.kind === 'INTERNAL' ? 'private' : message.kind === 'AGENT_PUBLIC' ? 'agent-message' : '')}>
      <header><strong>{message.author.displayName}</strong>{message.kind === 'INTERNAL' && <span className="private-label"><LockKeyhole size={14} aria-hidden />Staff only</span>}
        <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time></header><p>{message.body}</p>
    </article>)}
  </section>
}

export function Timing({ title, clock }: { title: string; clock: Clock | null }) {
  return <div className="timing"><h3>{title}</h3>{!clock ? <p className="muted">Timing history unavailable</p> : <>
    <strong className={'clock-status ' + clock.status.toLowerCase()}>{clockLabels[clock.status]}</strong>
    {clock.deadline && <p>Deadline <time dateTime={clock.deadline}>{dateTime(clock.deadline)}</time></p>}
    {(clock.status === 'ACTIVE' || clock.status === 'PAUSED') && <p>{duration(clock.remainingMs)} working time remaining</p>}
    {clock.status === 'OVERDUE' && <p>{duration(clock.overdueWorkingMs)} working time overdue</p>}
    <p>{duration(clock.consumedMs)} working time consumed</p>
    {clock.completedAt && <p>Ended <time dateTime={clock.completedAt}>{dateTime(clock.completedAt)}</time></p>}
    {clock.firstBreachedAt && <p className="breach">Historical breach · {dateTime(clock.firstBreachedAt)}</p>}
  </>}</div>
}

function StaffFacts({ ticket }: { ticket: StaffDetail }) {
  const { sla } = ticket
  return <aside className="facts"><section className="card side-card"><h2><UserRound size={18} aria-hidden />Ticket details</h2><dl>
    <dt>Assignee</dt><dd>{ticket.assignee?.displayName ?? 'Unassigned'}</dd>
    <dt>Last updated</dt><dd>{dateTime(ticket.updatedAt)}</dd>
    {ticket.waitingSince && <><dt>Waiting since</dt><dd>{dateTime(ticket.waitingSince)}</dd></>}
    {ticket.closeDueAt && <><dt>Automatic closure cutoff</dt><dd>{dateTime(ticket.closeDueAt)}</dd></>}
    {ticket.resolvedAt && <><dt>Resolved</dt><dd>{dateTime(ticket.resolvedAt)}</dd></>}
    {ticket.closedAt && <><dt>Closed</dt><dd>{dateTime(ticket.closedAt)}</dd></>}
  </dl></section><section className="card side-card"><h2><Clock3 size={18} aria-hidden />Service levels</h2>
    <p className="muted small">Evaluated {dateTime(sla.asOf)}</p>
    {sla.historicalBreach && <p className="breach">Historical breach on record</p>}
    <Timing title="First response" clock={sla.response} />
    <Timing title={sla.resolution ? 'Resolution · Cycle ' + sla.resolution.cycle : 'Resolution'} clock={sla.resolution} />
    {sla.resolutionHistoryIncomplete && <p className="muted">Some historical resolution timing is unavailable.</p>}
    {!!sla.resolutionHistory?.length && <details><summary>Previous resolution cycles</summary>
      {sla.resolutionHistory.map((clock) => <Timing key={clock.cycle} title={'Cycle ' + clock.cycle} clock={clock} />)}</details>}
  </section></aside>
}

const auditLabels: Record<string, string> = { CREATED: 'Ticket created', CLAIMED: 'Ticket claimed', PUBLIC_REPLY: 'Public reply sent',
  CUSTOMER_REPLY: 'Customer replied', PRIVATE_NOTE: 'Internal note added', WAIT_STARTED: 'Requested customer information',
  WAIT_ENDED: 'Customer replied and resumed ticket', RESOLVED: 'Ticket resolved', REOPENED: 'Ticket reopened',
  PRIORITY_CHANGED: 'Priority changed', AUTO_CLOSED: 'Ticket automatically closed', SLA_BREACHED: 'SLA breached' }

function Audit({ request, path, user, ticket }: { request: Request; path: string; user: Identity; ticket: StaffDetail }) {
  const [data, setData] = useState<AuditPage>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const active = useRef<AbortController | undefined>(undefined)
  const attemptedCursor = useRef<string | null | undefined>(undefined)
  function load(cursor?: string | null) {
    attemptedCursor.current = cursor
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setError('')
    request<AuditPage>(path + '/audit?limit=20' + (cursor ? '&afterId=' + encodeURIComponent(cursor) : ''), { signal: controller.signal }).then((page) => {
      if (!controller.signal.aborted) setData((old) => ({ ...page, items: cursor && old
        ? [...old.items, ...page.items.filter((entry) => !old.items.some((prior) => prior.id === entry.id))] : page.items }))
    }, (failure: unknown) => { if (!controller.signal.aborted) setError(errorText(failure)) }).finally(() => {
      if (!controller.signal.aborted) setBusy(false)
    })
  }
  useEffect(() => { load(); return () => active.current?.abort() }, [path, request])
  return <section className="card history"><h2><History size={19} aria-hidden />Audit history</h2>
    {error && <Notice retry={() => load(attemptedCursor.current)}>{error}</Notice>}
    {busy && <Busy label="Loading activity…" />}
    {data?.items.length === 0 && <Empty title="No audit events yet" />}
    <ol>{data?.items.map((entry) => {
      const { details, actor } = entry
      const actorName = actor.kind === 'SYSTEM' ? 'System' : actor.id === user.id ? user.displayName :
        ticket.assignee && actor.id === ticket.assignee.id ? ticket.assignee.displayName : actor.id ?? 'Unknown user'
      return <li key={entry.id}><strong>{auditLabels[entry.action] ?? entry.action}</strong>
        <div className="muted audit-actor">{actorName} · <time dateTime={entry.effectiveAt}>{dateTime(entry.effectiveAt)}</time></div>
        {entry.oldStatus && entry.newStatus && entry.oldStatus !== entry.newStatus && <p>{statusLabel[entry.oldStatus]} → {statusLabel[entry.newStatus]}</p>}
        {details.oldPriority && details.priority && <p>{priorityLabel[details.oldPriority]} → {priorityLabel[details.priority]}</p>}
        {(details.resolution?.cycle ?? details.resolutionCycle) && <p>Resolution cycle {details.resolution?.cycle ?? details.resolutionCycle}</p>}
        {details.cutoff && <p>Closure cutoff {dateTime(details.cutoff)}</p>}
        {details.processedAt && <p>Processed {dateTime(details.processedAt)}</p>}
      </li>
    })}</ol>
    {data?.nextAfterId && <button className="button secondary" disabled={busy} onClick={() => load(data.nextAfterId)}>Load more activity</button>}
  </section>
}

export function Workspace({ id, user, request, back }: { id: string; user: Identity; request: Request; back: string }) {
  const staff = user.role === 'AGENT'
  const path = '/tickets/' + id
  const resource = useRead<Detail | StaffDetail>(request, path, 60_000)
  const [section, setSection] = useState<'conversation' | 'history'>('conversation')
  const [mode, setMode] = useState<Operation | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<Operation, string>>>({})
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const [feedback, setFeedback] = useState('')
  const [failure, setFailure] = useState('')
  const [failureCode, setFailureCode] = useState('')
  const [auditVersion, setAuditVersion] = useState(0)
  const [applied, setApplied] = useState<Detail | StaffDetail>()
  const ticket = applied ?? resource.data
  useEffect(() => { setApplied(undefined) }, [resource.data])

  async function mutate(action: Operation | 'claim', body: object) {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setFeedback('')
    setFailure('')
    setFailureCode('')
    try {
      if (action === 'claim') {
        const assignedTicket = await request<StaffTicket>(path + '/claim', { method: 'POST', body })
        if (ticket && 'sla' in ticket) setApplied({ ...ticket, ...assignedTicket })
      } else {
        const value = await request<Detail | StaffDetail | Message>(path + '/' + action, { method: action === 'priority' ? 'PATCH' : 'POST', body })
        if ('messages' in value) setApplied(value)
        setDrafts((previous) => ({ ...previous, [action]: '' }))
        if (['wait', 'resolve', 'reopen', 'priority'].includes(action)) setMode(null)
      }
      setFeedback(action === 'claim' ? 'Ticket assigned to you.' : actions[action].success)
      setAuditVersion((value) => value + 1)
      resource.reload()
    } catch (error) {
      setFailure(writeErrorText(error, 'Refresh the ticket to check its current state'))
      if (error instanceof ApiError) {
        setFailureCode(error.code)
        if (error.status === 409 || error.status === 403) resource.reload()
      }
    } finally { lock.current = false; setPending(false) }
  }

  if (!ticket) return <><Back to={back} />{resource.loading ? <Busy label="Loading ticket…" /> : <Notice retry={resource.reload}>{resource.error}</Notice>}</>
  const agent = staff && 'sla' in ticket ? ticket : undefined
  const assigned = agent?.assignee?.id === user.id
  const open = ticket.status === 'OPEN'
  const waiting = ticket.status === 'WAITING'
  const closed = ticket.status === 'CLOSED'
  const canClaim = !!agent && open && !agent.assignee && failureCode !== 'TICKET_ALREADY_CLAIMED'
  const requiresReply = !agent?.sla.response?.completedAt || failureCode === 'FIRST_RESPONSE_REQUIRED'
  const withinReopen = ticket.resolvedAt && Date.now() < Date.parse(ticket.resolvedAt) + 168 * 60 * 60 * 1000
  const available: Operation[] = staff
    ? assigned && (open || waiting) ? ['public-replies', 'internal-notes', ...(open ? ['wait', 'resolve'] as const : []), 'priority'] : []
    : open || waiting ? ['customer-replies'] : ticket.status === 'RESOLVED' && withinReopen && failureCode !== 'REOPEN_EXPIRED' ? ['reopen'] : []
  const selected = mode && available.includes(mode) ? mode : available[0]
  const canStartNew = !staff && (closed || (ticket.status === 'RESOLVED' && (!withinReopen || failureCode === 'REOPEN_EXPIRED')))
  const unsent = drafts.reopen || drafts['customer-replies']
  function submit(event: FormEvent<HTMLFormElement>, action: Operation) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const body = (drafts[action] ?? '').trim()
    if (!body && (action !== 'resolve' || requiresReply)) { setFailure('Enter a message before submitting.'); return }
    if (action === 'priority' && form.get('priority') === ticket?.priority) { setFailure('Select a different priority.'); return }
    void mutate(action, action === 'priority' ? { priority: form.get('priority'), reason: body } : body ? { body } : {})
  }

  return <><Back to={back} />
    <header className="page-heading detail-heading"><div><p className="reference">{ticket.reference}</p><h1>{ticket.subject}</h1><div className="badges"><Badge value={ticket.status} /><Badge value={ticket.priority} /></div></div>
      <div className="actions"><button className="button secondary" onClick={() => { resource.reload(); setAuditVersion((value) => value + 1) }}><RefreshCw size={16} aria-hidden />Refresh</button>
        {canClaim && <button className="button primary" disabled={pending} onClick={() => void mutate('claim', {})}><UserRound size={16} aria-hidden />Claim ticket</button>}</div>
    </header>
    {feedback && <div className="success" role="status"><Check size={18} aria-hidden />{feedback}</div>}
    {resource.error && <Notice retry={resource.reload}>{resource.error}</Notice>}
    {failure && <Notice>{failure}</Notice>}
    {waiting && !staff && <div className="context">Support is waiting for your response. A reply lets the team continue working on this ticket.</div>}
    {canStartNew && <div className="context">{closed ? 'This ticket closed after waiting for a response.' : 'This ticket is outside its reopening window.'}
      {' '}<Link to={customerBase + '/new?from=' + id}>Create a new ticket</Link></div>}
    {canStartNew && unsent && <details className="context"><summary>Unsent message</summary><p className="message-text">{unsent}</p></details>}
    {agent && <div className="switcher" aria-label="Ticket view">
      <button aria-pressed={section === 'conversation'} onClick={() => setSection('conversation')}><MessageSquare size={16} aria-hidden />Conversation</button>
      <button aria-pressed={section === 'history'} onClick={() => setSection('history')}><History size={16} aria-hidden />Audit history</button>
    </div>}
    <div className={'workspace ' + (agent ? 'staff-workspace' : '')}>
      <div className="workspace-main">
        {section === 'history' && agent ? <Audit key={auditVersion} request={request} path={path} user={user} ticket={agent} /> : <>
          <Conversation description={ticket.description} createdAt={ticket.createdAt} messages={ticket.messages} />
          {selected && <section className={'card composer ' + (selected === 'internal-notes' ? 'private' : '')}>
            {available.length > 1 && <div className="switcher modes" aria-label="Ticket actions">
              {available.map((action) => <button type="button" key={action} disabled={pending} aria-pressed={selected === action} onClick={() => {
                setMode(action); setFailure(''); setFeedback('')
              }}>{action === 'internal-notes' && <LockKeyhole size={15} aria-hidden />}{actions[action].label}</button>)}
            </div>}
            <form key={selected} onSubmit={(event) => submit(event, selected)}>
              <h2>{actions[selected].label}</h2>{actions[selected].hint && <p>{actions[selected].hint}</p>}
              {selected === 'priority' && <label>New priority<select name="priority" defaultValue={ticket.priority}>
                {priorities.map((priority) => <option key={priority} value={priority}>{priorityLabel[priority]}</option>)}</select></label>}
              <label>{selected === 'priority' ? 'Reason' : selected === 'resolve' ? requiresReply ? 'Public reply (required)' : 'Public reply (optional)' : selected === 'internal-notes' ? 'Private message' : 'Message'}
                <textarea rows={4} value={drafts[selected] ?? ''} onChange={(e) => setDrafts({ ...drafts, [selected]: e.target.value })}
                  required={selected !== 'resolve' || requiresReply} maxLength={selected === 'priority' ? 500 : 4000} />
              </label>
              <button className="button primary" disabled={pending}><Send size={16} aria-hidden />{pending ? 'Submitting…' : actions[selected].submit}</button>
            </form>
          </section>}
        </>}
      </div>
      {agent && <StaffFacts ticket={agent} />}
    </div>
  </>
}
