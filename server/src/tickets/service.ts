import { Prisma, type PrismaClient, type TicketStatus } from '../generated/prisma/client.js'
import type { Actor } from '../auth/session.js'
import { HttpError } from '../http/errors.js'
import { idSchema, type CreateInput, type QueueInput } from './input.js'
import { calendarSelect, finishFirstResponse, initializeClocks, loadStaffSla, overdueWhere, reconstructClocks } from '../sla/persistence.js'

const summary = { id: true, reference: true, subject: true, status: true, priority: true, createdAt: true } as const
const staffSummary = { ...summary, updatedAt: true,
  assignee: { select: { id: true, displayName: true } },
  waitingSince: true, closeDueAt: true } as const
const detail = { description: true, resolvedAt: true, closedAt: true } as const
const author = { select: { displayName: true } } as const
const message = { id: true, body: true, kind: true, createdAt: true, author } as const
const messageOrder: Prisma.TicketMessageOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }]
const ticketOrder: Prisma.TicketOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }]
const missingTicket = () => new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found.')
const publicKinds = ['CUSTOMER_PUBLIC', 'AGENT_PUBLIC'] as const

export function ticketService(db: PrismaClient, now: () => Date) {
  async function create(actor: Actor, input: CreateInput) {
    return db.$transaction(async (tx) => {
      if (input.sourceTicketId) {
        const source = await tx.ticket.findFirst({
          where: { id: input.sourceTicketId, customerId: actor.id, status: { in: ['CLOSED', 'RESOLVED'] } },
          select: { id: true },
        })
        if (!source) throw missingTicket()
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
    const slaFilter = query.sla === 'overdue' ? overdue : query.sla === 'historical'
      ? { clocks: { some: { firstBreachedAt: { not: null } } } } : {}
    const where = { ...base, status: query.status, ...slaFilter }
    const paging = { where, orderBy: ticketOrder, skip: (query.page - 1) * query.limit, take: query.limit }
    return db.$transaction(async (tx) => {
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
    if (actor.role === 'CUSTOMER') {
      const ticket = await db.ticket.findFirst({
        where: { id, customerId: actor.id },
        select: { ...summary, ...detail, messages: {
          where: { kind: { in: [...publicKinds] } }, select: message, orderBy: messageOrder,
        } },
      })
      if (!ticket) throw missingTicket()
      return ticket
    }
    const asOf = now()
    return db.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUnique({
        where: { id }, select: { ...staffSummary, ...detail, calendarId: true },
      })
      if (!ticket) throw missingTicket()
      const messages = await tx.ticketMessage.findMany({ where: { ticketId: id }, select: message, orderBy: messageOrder })
      const sla = await loadStaffSla(tx, [ticket], asOf, true)
      const { calendarId: _calendarId, ...fields } = ticket
      return { ...fields, messages, sla: sla.get(id) }
    }, { isolationLevel: 'RepeatableRead' })
  }

  async function writeMessage(actor: Actor, id: string, body: string, internal: boolean) {
    const customer = actor.role === 'CUSTOMER'
    if (customer && internal) throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
    return db.$transaction(async (tx) => {
      const scope = customer ? Prisma.sql`AND "customerId" = ${actor.id}::uuid` : Prisma.empty
      const [ticket] = await tx.$queryRaw<{ status: TicketStatus; assigneeId: string | null; closeDueAt: Date | null }[]>`
        SELECT status, "assigneeId", "closeDueAt" FROM "Ticket" WHERE id = ${id}::uuid ${scope} FOR UPDATE
      `
      if (!ticket) throw missingTicket()
      if (!customer && ticket.assigneeId !== actor.id) throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
      const timestamp = now()
      if (ticket.status !== 'OPEN' && (ticket.status !== 'WAITING' || customer ||
          (ticket.closeDueAt && ticket.closeDueAt <= timestamp))) {
        throw new HttpError(409, 'TICKET_STATE_CONFLICT', 'This ticket cannot accept that action in its current state.')
      }
      if (!customer && !internal && !await tx.slaClock.findUnique({
        where: { ticketId_kind_cycle: { ticketId: id, kind: 'RESPONSE', cycle: 1 } }, select: { id: true },
      })) await reconstructClocks(tx, id)
      // Phase 5 will resume a waiting ticket on a timely CUSTOMER_PUBLIC reply here.
      const created = await tx.ticketMessage.create({
        data: { ticketId: id, authorId: actor.id, body, createdAt: timestamp,
          kind: internal ? 'INTERNAL' : customer ? 'CUSTOMER_PUBLIC' : 'AGENT_PUBLIC' },
        select: message,
      })
      const firstResponse = !internal && !customer ? await finishFirstResponse(tx, id, timestamp, created.id) : undefined
      if (!internal) await tx.ticket.update({ where: { id }, data: { updatedAt: timestamp }, select: { id: true } })
      await tx.auditEvent.create({
        data: { ticketId: id, actorId: actor.id, actorKind: 'USER',
          action: internal ? 'PRIVATE_NOTE' : customer ? 'CUSTOMER_REPLY' : 'PUBLIC_REPLY',
          effectiveAt: timestamp, details: { messageId: created.id, ...(firstResponse ? { firstResponse } : {}) } },
        select: { id: true },
      })
      return created
    })
  }
  return { create, list, get, writeMessage }
}
