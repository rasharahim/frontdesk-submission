import { useEffect, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, Clock3, Inbox, Plus, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import type { Request } from './api'
import type { Identity, Page, StaffPage, Ticket } from './contracts'
import { priorities, statuses } from './contracts'
import { navigate, queuePath, queueQuery } from './navigation'
import { useRead } from './resources'
import { Badge, Busy, Empty, Link, Notice, clockLabels, dateTime, duration, priorityLabel, statusLabel } from './ui'

export function Queue({ user, request, url }: { user: Identity; request: Request; url: URL }) {
  const staff = user.role === 'AGENT'
  const base = queuePath(user.role)
  const current = url.searchParams
  const term = current.get('q') ?? ''
  const [draft, setDraft] = useState(term)
  useEffect(() => setDraft(term), [term])
  useEffect(() => {
    const query = draft.trim()
    if (query === term) return
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(location.search)
      if (query) next.set('q', query)
      else next.delete('q')
      next.delete('page')
      navigate(base + (next.size ? '?' + next : ''), true)
    }, 350)
    return () => clearTimeout(timer)
  }, [draft, term, base])

  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(url.search)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== 'page') next.delete('page')
    if (key === 'scope') next.delete('assigneeId')
    navigate(base + (next.size ? '?' + next : ''))
  }
  const query = queueQuery(url.search, staff)
  const tickets = useRead<Page<Ticket> | StaffPage>(request, '/tickets?' + query, 90_000)
  const data = tickets.data
  const counts = data && 'counts' in data ? data.counts : undefined
  const title = staff ? current.get('sla') === 'overdue' ? 'Overdue tickets' : current.get('status') === 'WAITING' ? 'Waiting for customer'
    : current.get('scope') === 'mine' ? 'Assigned to me' : current.get('scope') === 'unassigned' ? 'Unassigned tickets' : 'Ticket queue' : 'My tickets'
  return <>
    <header className="page-heading"><div><h1>{title}</h1><p>{staff ? 'Find requests, manage assignments, and track service deadlines.' : 'Track your requests and reply to the support team.'}</p></div>
      {staff ? <button className="button secondary" onClick={tickets.reload}><RefreshCw size={16} aria-hidden />Refresh</button>
        : <Link className="button primary" to={base + '/new'}><Plus size={17} aria-hidden />New ticket</Link>}</header>
    {counts && <section aria-labelledby="queue-counts">
      <h2 id="queue-counts" className="muted small mb-2">Counts by assignment, search and priority</h2>
      <div className="metrics">
      {([[Inbox, 'Open', counts.open], [TriangleAlert, 'Overdue', counts.overdue], [Clock3, 'Waiting', counts.waiting]] as const).map(([Icon, label, count]) =>
        <div className={'metric ' + label.toLowerCase()} key={label}><span className="metric-icon"><Icon size={19} aria-hidden /></span><div><span>{label}</span><strong>{count}</strong></div></div>)}
      </div>
    </section>}
    <section className="card queue" aria-label="Tickets">
      <div className="filter-bar">
        <label className="search"><Search size={17} aria-hidden /><span className="sr-only">Search tickets</span><input value={draft} maxLength={160} onChange={(e) => setDraft(e.target.value)} placeholder="Search subject or ticket reference" /></label>
        <label><span className="sr-only">Priority</span><select value={current.get('priority') ?? ''} onChange={(e) => filter('priority', e.target.value)}>
          <option value="">All priorities</option>{priorities.map((item) => <option value={item} key={item}>{priorityLabel[item]}</option>)}</select></label>
        <label><span className="sr-only">Status</span><select value={current.get('status') ?? ''} onChange={(e) => filter('status', e.target.value)}>
          <option value="">All statuses</option>{statuses.map((item) => <option value={item} key={item}>{statusLabel[item]}</option>)}</select></label>
        {staff && <><label><span className="sr-only">Assignment</span><select value={current.get('scope') ?? 'all'} onChange={(e) => filter('scope', e.target.value)}>
          <option value="all">All assignments</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select></label>
          <label><span className="sr-only">SLA filter</span><select value={current.get('sla') ?? ''} onChange={(e) => filter('sla', e.target.value)}>
          <option value="">Any SLA</option><option value="overdue">Overdue</option><option value="historical">Historical breach</option></select></label></>}
      </div>
      {tickets.loading && <Busy label="Loading tickets…" />}
      {tickets.error && <Notice retry={tickets.reload}>{tickets.error}</Notice>}
      {data?.items.length === 0 && <Empty title="No tickets found"><p>{query.size > (staff ? 1 : 0) ? 'Try different filters or clear your search.' : 'Tickets will appear here when they are created.'}</p>
        {query.size > (staff ? 1 : 0) && <Link to={base}>Clear filters</Link>}</Empty>}
      {!!data?.items.length && <div className="table-scroll" tabIndex={0} role="region" aria-label="Ticket results"><table>
        <thead><tr><th scope="col">Ticket</th><th scope="col">Priority</th><th scope="col">Status</th>{staff && <><th scope="col">Assignee</th><th scope="col">Service level</th></>}<th scope="col"><span className="sort">Created <ArrowDown size={13} aria-hidden /></span></th></tr></thead>
        <tbody>{data.items.map((ticket) => <tr key={ticket.id}><td><Link className="ticket-link" to={base + '/' + ticket.id}><span>{ticket.reference}</span><strong>{ticket.subject}</strong></Link></td>
          <td><Badge value={ticket.priority} /></td><td><Badge value={ticket.status} /></td>
          {'sla' in ticket && <><td>{ticket.assignee?.displayName ?? 'Unassigned'}</td><td className="queue-sla">
            {([['First reply', ticket.sla.response], ['Resolution', ticket.sla.resolution]] as const).map(([label, clock]) =>
              <div className={clock?.status.toLowerCase()} key={label}><span>{label}</span> {clock ? clockLabels[clock.status] : 'Unavailable'}
                {clock?.status === 'ACTIVE' && <small> · {duration(clock.remainingMs)} working time left</small>}</div>)}
          </td></>}
          <td className="muted"><time dateTime={ticket.createdAt}>{dateTime(ticket.createdAt)}</time></td></tr>)}</tbody>
      </table></div>}
      {data && <footer className="pagination"><span>{data.total ? (data.items.length ? (data.page - 1) * data.limit + 1 + '–' + Math.min(data.page * data.limit, data.total) + ' of ' : '') + data.total + ' tickets' : '0 tickets'}</span>
        <div><button className="button secondary" disabled={data.page <= 1} onClick={() => filter('page', String(data.page - 1))}><ArrowLeft size={15} aria-hidden />Previous</button>
          <button className="button secondary" disabled={data.page >= 1000 || data.page * data.limit >= data.total} onClick={() => filter('page', String(data.page + 1))}>Next<ArrowRight size={15} aria-hidden /></button></div></footer>}
    </section>
  </>
}
