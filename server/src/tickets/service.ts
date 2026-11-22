import { Prisma, type PrismaClient, type TicketStatus } from '../generated/prisma/client.js'
import type { Actor } from '../auth/session.js'
import { HttpError } from '../http/errors.js'
import { idSchema, type CreateInput, type QueueInput } from './input.js'
import { calendarSelect, initializeClocks, loadStaffSla, overdueWhere } from '../sla/persistence.js'

import { messageFields as message, ticketLifecycle } from './lifecycle.js'
import { batchSize, reconcileTicket, ticketNotFound } from './reconciliation.js'

const summary = { id: true, reference: true, subject: true, status: true, priority: true, createdAt: true } as const
const staffSummary = { ...summary, updatedAt: true,
  assignee: { select: { id: true, displayName: true } },
  waitingSince: true, closeDueAt: true, resolvedAt: true, closedAt: true, closeProcessedAt: true } as const
const detail = { description: true, resolvedAt: true, closedAt: true } as const
const messageOrder: Prisma.TicketMessageOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }]
const ticketOrder: Prisma.TicketOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }]
const publicKinds = ['CUSTOMER_PUBLIC', 'AGENT_PUBLIC'] as const

export function ticketService(db: PrismaClient, now: () => Date) {
  const lifecycle = ticketLifecycle(db, now)

  async function create(actor: Actor, input: CreateInput) {
    if (input.sourceTicketId) await reconcileTicket(db, input.sourceTicketId, now, actor.id)
    return db.$transaction(async (tx) => {
      if (input.sourceTicketId) {
        const source = await tx.ticket.findFirst({
          where: { id: input.sourceTicketId, customerId: actor.id, status: { in: ['CLOSED', 'RESOLVED'] } },
          select: { id: true },
        })
        if (!source) throw ticketNotFound()
      }
      const calendar = await tx.holidayCalendar.findFirst({
        where: { publishedAt: { not: null } }, orderBy: { version: 'desc' }, select: { id: true, ...calendarSelect },
      })
      if (!calendar) throw new HttpError(503, 'CALENDAR_UNAVAILABLE', 'Ticket calendar is unavailable.')
      const timestamp = now()
      const ticket = await tx.ticket.create({
        data: { customerId: actor.id, calendarId: calendar.id, sourceTicketId: input.sourceTicketId,
          subject: input.subject, description: input.body, priority: input.priority, createdAt: timestamp, updatedAt: timestamp },
        select: { ...summary, ...detail },
      })
      await initializeClocks(tx, ticket, calendar.holidays)
      await tx.auditEvent.create({
        data: { ticketId: ticket.id, actorId: actor.id, actorKind: 'USER', action: 'CREATED',
          effectiveAt: timestamp, newStatus: 'OPEN',
          details: input.sourceTicketId ? { sourceTicketId: input.sourceTicketId } : {} },
        select: { id: true },
      })
      return { ...ticket, messages: [] }
    })
  }

  async function list(actor: Actor, query: QueueInput) {
    const staff = actor.role === 'AGENT'
    if (!staff && (query.scope || query.assigneeId || query.sla)) {
      throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
    }
    const asOf = now()
    const overdue = overdueWhere(db, asOf)
    const scope = query.scope ?? (query.assigneeId ? 'all' : 'mine')
    if ((scope === 'unassigned' && query.assigneeId) ||
        (scope === 'mine' && query.assigneeId && query.assigneeId !== actor.id)) {
      throw new HttpError(400, 'INVALID_INPUT', 'Conflicting assignment filters.')
    }
    const exactId = idSchema.safeParse(query.q)
    const q = query.q?.replace(/[\\%_]/g, '\\$&')
    const base: Prisma.TicketWhereInput = {
      customerId: staff ? undefined : actor.id,
      assigneeId: staff ? (scope === 'mine' ? actor.id : scope === 'unassigned' ? null : query.assigneeId) : undefined,
      priority: query.priority,
      OR: q ? [{ subject: { contains: q, mode: 'insensitive' } },
        ...(exactId.success ? [{ id: exactId.data }] : []),
        ...(/^FD-[1-9][0-9]*$/i.test(q) ? [{ reference: q.toUpperCase() }] : [])] : undefined,
    }
    const due: Prisma.TicketWhereInput = { ...base, status: 'WAITING', closeDueAt: { lte: asOf } }
    const candidates = await db.ticket.findMany({ where: due, orderBy: [{ closeDueAt: 'asc' }, { id: 'asc' }],
      take: batchSize, select: { id: true } })
    for (const candidate of candidates) {
      await reconcileTicket(db, candidate.id, now, staff ? undefined : actor.id)
    }
    const slaFilter = query.sla === 'overdue' ? overdue : query.sla === 'historical'
      ? { clocks: { some: { firstBreachedAt: { not: null } } } } : {}
    const where = { ...base, status: query.status, ...slaFilter }
    const paging = { where, orderBy: ticketOrder, skip: (query.page - 1) * query.limit, take: query.limit }
    return db.$transaction(async (tx) => {
      if (await tx.ticket.findFirst({ where: due, select: { id: true } })) {
        throw new HttpError(503, 'LIFECYCLE_CATCH_UP', 'Ticket closure catch-up is still in progress. Retry shortly.')
      }
      const total = await tx.ticket.count({ where })
      const metadata = { page: query.page, limit: query.limit, total }
      if (!staff) return { ...metadata, items: await tx.ticket.findMany({ ...paging, select: summary }) }
      const items = await tx.ticket.findMany({ ...paging, select: { ...staffSummary, calendarId: true } })
      const groups = await tx.ticket.groupBy({ by: ['status'], where: base, _count: { _all: true } })
      const count = (status: TicketStatus) => groups.find((group) => group.status === status)?._count._all ?? 0
      const sla = await loadStaffSla(tx, items, asOf)
      return { ...metadata, items: items.map(({ calendarId: _calendarId, ...item }) => ({
        ...item, sla: sla.get(item.id),
      })), counts: { open: count('OPEN'), waiting: count('WAITING'),
        overdue: await tx.ticket.count({ where: { ...base, ...overdue } }) } }
    }, { isolationLevel: 'RepeatableRead' })
  }

  async function get(actor: Actor, id: string) {
    const customerId = actor.role === 'CUSTOMER' ? actor.id : undefined
    const due = await db.ticket.findFirst({
      where: { id, customerId, status: 'WAITING', closeDueAt: { lte: now() } }, select: { id: true },
    })
    if (due) await reconcileTicket(db, id, now, customerId)
    if (actor.role === 'CUSTOMER') {
      const ticket = await db.ticket.findFirst({
        where: { id, customerId: actor.id },
        select: { ...summary, ...detail, messages: {
          where: { kind: { in: [...publicKinds] } }, select: message, orderBy: messageOrder,
        } },
      })
      if (!ticket) throw ticketNotFound()
      return ticket
    }
    const asOf = now()
    return db.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id }, select: { ...staffSummary, ...detail, calendarId: true },
      })
      if (!ticket) throw ticketNotFound()
      const messages = await tx.ticketMessage.findMany({ where: { ticketId: id }, select: message, orderBy: messageOrder })
      const sla = await loadStaffSla(tx, [ticket], asOf, true)
      const { calendarId: _calendarId, ...fields } = ticket
      return { ...fields, messages, sla: sla.get(id) }
    }, { isolationLevel: 'RepeatableRead' })
  }

  return { create, list, get, mutate: lifecycle.mutate }
}
