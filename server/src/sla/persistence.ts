import type { Prisma, PrismaClient, Priority } from '../generated/prisma/client.js'
import { calendarFromDates } from './calendar.js'
import { complete, evaluate, startClock, type Clock } from './clock.js'

export const calendarSelect = { version: true, holidays: { select: { date: true } } } as const
type TicketSla = {
  calendar: { version: number; holidays: { date: Date }[] }
  clocks: Clock[]
}
type Transaction = Prisma.TransactionClient

function staffSla({ calendar, clocks }: TicketSla, asOf: Date, history = false) {
  const business = calendarFromDates(calendar.holidays)
  const response = clocks.find((clock) => clock.kind === 'RESPONSE')
  const resolutions = clocks.filter((clock) => clock.kind === 'RESOLUTION')
  const resolution = resolutions[0]
  return { asOf, calendarVersion: calendar.version, response: response ? evaluate(response, asOf, business) : null,
    resolution: resolution ? evaluate(resolution, asOf, business) : null,
    historicalBreach: clocks.some((clock) => clock.firstBreachedAt !== null),
    resolutionHistoryIncomplete: !resolution || resolution.cycle > resolutions.length,
    ...(history ? { resolutionHistory: resolutions.slice(1).map((clock) => evaluate(clock, asOf, business)) } : {}),
  }
}

export async function loadStaffSla(tx: Transaction, tickets: { id: string; calendarId: string }[], asOf: Date, history = false) {
  if (!tickets.length) return new Map<string, ReturnType<typeof staffSla>>()
  const calendars = await tx.holidayCalendar.findMany({
    where: { id: { in: [...new Set(tickets.map((ticket) => ticket.calendarId))] } },
    select: { id: true, ...calendarSelect },
  })
  const clocks = await tx.slaClock.findMany({
    where: { ticketId: { in: tickets.map((ticket) => ticket.id) } }, orderBy: { cycle: 'desc' },
  })
  const completedIds = clocks.filter((clock) => clock.state === 'COMPLETED').map((clock) => clock.id)
  const corrections = completedIds.length ? await tx.slaDeadlineCorrection.findMany({
    where: { clockId: { in: completedIds }, field: 'COMPLETED_DUE_AT' },
    select: { clockId: true, originalDeadline: true, correctedDeadline: true },
  }) : []
  const byClock = new Map(corrections.map((item) => [item.clockId, item]))
  const byCalendar = new Map(calendars.map((calendar) => [calendar.id, calendar]))
  const byTicket = new Map<string, Clock[]>()
  for (const clock of clocks) {
    const correction = byClock.get(clock.id)
    const effective = correction && clock.completedDueAt?.getTime() === correction.originalDeadline.getTime()
      ? { ...clock, completedDueAt: correction.correctedDeadline } : clock
    const group = byTicket.get(clock.ticketId)
    if (group) group.push(effective)
    else byTicket.set(clock.ticketId, [effective])
  }
  return new Map(tickets.map((ticket) => {
    const calendar = byCalendar.get(ticket.calendarId)
    if (!calendar) throw new Error('Ticket calendar is missing.')
    return [ticket.id, staffSla({ calendar, clocks: byTicket.get(ticket.id) ?? [] }, asOf, history)]
  }))
}

export function overdueWhere(db: PrismaClient, asOf: Date): Prisma.TicketWhereInput {
  return { clocks: { some: { state: 'RUNNING', OR: [
    { dueAt: { lt: asOf } },
    { dueAt: asOf, elapsedMs: { gt: db.slaClock.fields.budgetMs } },
  ] } } }
}

export async function initializeClocks(tx: Transaction, ticket: { id: string; priority: Priority; createdAt: Date },
  holidays: { date: Date }[]) {
  const calendar = calendarFromDates(holidays)
  await tx.slaClock.createMany({ data: (['RESPONSE', 'RESOLUTION'] as const).map((kind) => ({
    ticketId: ticket.id, ...startClock(kind, ticket.priority, ticket.createdAt, calendar),
  })) })
}

/** Requires the caller to own the ticket row lock. Only insert reconstructable missing facts. */
export async function reconstructClocks(tx: Transaction, id: string) {
  const ticket = await tx.ticket.findUniqueOrThrow({ where: { id }, select: {
    priority: true, status: true, createdAt: true, calendarId: true, waitingSince: true, resolvedAt: true, closedAt: true,
  } })
  const clocks = await tx.slaClock.findMany({ where: { ticketId: id }, select: { kind: true } })
  const hasResponse = clocks.some((clock) => clock.kind === 'RESPONSE')
  const hasResolution = clocks.some((clock) => clock.kind === 'RESOLUTION')
  if (hasResponse && hasResolution) return { initializedClocks: 0, unresolved: false }
  const events = await tx.auditEvent.groupBy({
    by: ['action'], where: { ticketId: id, action: { in: ['PRIORITY_CHANGED', 'WAIT_STARTED', 'REOPENED'] } },
  })
  const missing: Clock[] = []
  if (!events.some((event) => event.action === 'PRIORITY_CHANGED')) {
    const calendar = await tx.holidayCalendar.findUniqueOrThrow({ where: { id: ticket.calendarId }, select: calendarSelect })
    const business = calendarFromDates(calendar.holidays)
    const uninterrupted = ticket.status === 'OPEN' && events.length === 0
    if (!hasResponse && !events.some((event) => event.action === 'REOPENED')) {
      const first = await tx.ticketMessage.findFirst({
        where: { ticketId: id, kind: 'AGENT_PUBLIC', author: { role: 'AGENT' }, createdAt: {
          gte: ticket.createdAt, lte: ticket.waitingSince ?? ticket.resolvedAt ?? ticket.closedAt ?? undefined,
        } },
        select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      if (first || uninterrupted) {
        const clock = startClock('RESPONSE', ticket.priority, ticket.createdAt, business)
        missing.push(first ? complete(clock, first.createdAt, business) : clock)
      }
    }
    if (!hasResolution && uninterrupted) missing.push(startClock('RESOLUTION', ticket.priority, ticket.createdAt, business))
  }
  if (missing.length) await tx.slaClock.createMany({ data: missing.map((clock) => ({ ticketId: id, ...clock })) })
  return { initializedClocks: missing.length, unresolved: (!hasResponse && !missing.some((c) => c.kind === 'RESPONSE')) ||
    (!hasResolution && !missing.some((c) => c.kind === 'RESOLUTION')) }
}

/** Requires the ticket lock, shared by all qualifying replies. */
export async function finishFirstResponse(tx: Transaction, id: string, replyAt: Date, messageId: string) {
  const response = await tx.slaClock.findUnique({
    where: { ticketId_kind_cycle: { ticketId: id, kind: 'RESPONSE', cycle: 1 } },
    include: { ticket: { select: { calendar: { select: calendarSelect } } } },
  })
  if (!response || response.state !== 'RUNNING') return undefined
  const business = calendarFromDates(response.ticket.calendar.holidays)
  const completed = complete(response, replyAt, business)
  await tx.slaClock.update({ where: { id: response.id }, data: {
    state: completed.state, activeSince: null, dueAt: null, elapsedMs: completed.elapsedMs, endedAt: replyAt,
    completedDueAt: completed.completedDueAt, completionOnTime: completed.completionOnTime,
    firstBreachedAt: completed.firstBreachedAt,
  } })
  if (!response.firstBreachedAt && completed.firstBreachedAt) {
    await tx.auditEvent.create({ data: {
      ticketId: id, actorKind: 'SYSTEM', action: 'SLA_BREACHED', effectiveAt: completed.firstBreachedAt,
      details: { kind: 'RESPONSE', cycle: 1, messageId },
    }, select: { id: true } })
  }
  return { status: completed.completionOnTime ? 'COMPLETED_ON_TIME' : 'COMPLETED_LATE',
    deadline: completed.completedDueAt?.toISOString() ?? null, completedAt: replyAt.toISOString() }
}

export async function backfillClocks(db: PrismaClient) {
  let cursor: string | undefined
  const result = { initializedTickets: 0, initializedClocks: 0, unresolvedTickets: 0 }
  while (true) {
    const batch = await db.ticket.findMany({
      where: { id: cursor ? { gt: cursor } : undefined, OR: [
        { clocks: { none: { kind: 'RESPONSE' } } }, { clocks: { none: { kind: 'RESOLUTION' } } },
      ] },
      orderBy: { id: 'asc' }, take: 100, select: { id: true },
    })
    if (batch.length === 0) return result
    for (const { id } of batch) {
      const item = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<unknown[]>`SELECT id FROM "Ticket" WHERE id = ${id}::uuid FOR UPDATE`
        return rows.length ? reconstructClocks(tx, id) : null
      })
      if (!item) continue
      if (item.initializedClocks) result.initializedTickets++
      result.initializedClocks += item.initializedClocks
      if (item.unresolved) result.unresolvedTickets++
    }
    cursor = batch[batch.length - 1].id
  }
}
