import { AlertCircle, Headset, Inbox, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { navigate } from './navigation'
import type { Priority, Status } from './contracts'

export function Brand() {
  return <div className="brand"><span className="brand-mark"><Headset size={22} aria-hidden /></span><span>Frontdesk<small>Arvo Systems</small></span></div>
}
export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  return <a href={to} className={className} aria-current={current ? 'page' : undefined} onClick={(event) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }}>{children}</a>
}
export function Notice({ children, retry }: { children: ReactNode; retry?: () => void }) {
  return <div className="notice" role="alert"><AlertCircle size={18} aria-hidden /><span>{children}</span>{retry && <button type="button" className="button secondary" onClick={retry}>Retry</button>}</div>
}
export function Busy({ label = 'Loadingâ€¦' }: { label?: string }) {
  return <div className="busy" role="status"><LoaderCircle size={20} aria-hidden />{label}</div>
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><Inbox size={24} aria-hidden /><h2>{title}</h2>{children && <div>{children}</div>}</div>
}
export const statusLabel: Record<Status, string> = { OPEN: 'Open', WAITING: 'Waiting for customer', RESOLVED: 'Resolved', CLOSED: 'Closed' }
export const priorityLabel: Record<Priority, string> = { URGENT: 'Urgent', MEDIUM: 'Medium', LOW: 'Low' }
const badgeLabels = { ...statusLabel, ...priorityLabel }
export function Badge({ value }: { value: Status | Priority }) {
  return <span className={'badge ' + value.toLowerCase()}>{badgeLabels[value]}</span>
}
const ist = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
export function dateTime(value: string) { return ist.format(new Date(value)) + ' IST' }
export function duration(ms: number) {
  if (!ms) return '0 min'
  if (ms < 60_000) return '< 1 min'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return (hours ? hours + ' hr ' : '') + (minutes % 60) + ' min'
}
export const clockLabels = {
  ACTIVE: 'Running', OVERDUE: 'Overdue', PAUSED: 'Paused', COMPLETED_ON_TIME: 'Completed on time',
  COMPLETED_LATE: 'Completed late', COMPLETED_UNKNOWN: 'Completion timing unavailable', CANCELED: 'Cancelled',
}
