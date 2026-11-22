import type { TicketStatus } from '../generated/prisma/client.js'
import { HttpError } from '../http/errors.js'
import { MINUTE_MS, type Calendar } from '../sla/calendar.js'

export const transitions = {
  wait: { role: 'AGENT', from: ['OPEN'], to: 'WAITING' },
  customerReply: { role: 'CUSTOMER', from: ['OPEN', 'WAITING'], to: 'OPEN' },
  publicReply: { role: 'AGENT', from: ['OPEN', 'WAITING'], to: null },
  note: { role: 'AGENT', from: ['OPEN', 'WAITING'], to: null },
  resolve: { role: 'AGENT', from: ['OPEN'], to: 'RESOLVED' },
  reopen: { role: 'CUSTOMER', from: ['RESOLVED'], to: 'OPEN' },
  priority: { role: 'AGENT', from: ['OPEN', 'WAITING'], to: null },
  close: { role: 'SYSTEM', from: ['WAITING'], to: 'CLOSED' },
} as const satisfies Record<string, { role: string; from: readonly TicketStatus[]; to: TicketStatus | null }>

export type Action = keyof typeof transitions

export function requireTransition(action: Action, status: TicketStatus, role: 'AGENT' | 'CUSTOMER' | 'SYSTEM') {
  const rule = transitions[action]
  if (role !== rule.role) throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
  const allowed: readonly TicketStatus[] = rule.from
  if (!allowed.includes(status)) {
    if (status === 'CLOSED') throw new HttpError(409, 'TICKET_CLOSED', 'This ticket is closed. Create a new ticket.')
    throw new HttpError(409, 'TICKET_STATE_CONFLICT', 'This ticket cannot accept that action in its current state.')
  }
  return rule.to ?? status
}

export function closureDeadline(waitingSince: Date, calendar: Calendar) {
  return calendar.add(waitingSince, 2700 * MINUTE_MS)
}

export function closureDue(cutoff: Date | null, now: Date) {
  return cutoff !== null && +cutoff <= +now
}

export function reopenEligible(resolvedAt: Date, now: Date) {
  const elapsed = +now - +resolvedAt
  return elapsed >= 0 && elapsed < 168 * 60 * MINUTE_MS
}
