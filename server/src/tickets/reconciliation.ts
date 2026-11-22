import { Prisma, type PrismaClient, type SlaClock, type Ticket } from '../generated/prisma/client.js'
import { calendarFromDates } from '../sla/calendar.js'
import { missedDeadline, type Clock } from '../sla/clock.js'
import { HttpError } from '../http/errors.js'
import { closureDeadline, closureDue, requireTransition } from './lifecycle-policy.js'

type Tx = Prisma.TransactionClient
export const ticketNotFound = () => new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found.')
export const historyUnavailable = () => new HttpError(409, 'SLA_HISTORY_UNAVAILABLE', 'Required SLA history is unavailable for this ticket.')

export async function lockTicket(tx: Tx, id: string, customerId?: string) {
  const scope = customerId ? Prisma.sql`AND "customerId" = ${customerId}::uuid` : Prisma.empty
  const [ticket] = await tx.$queryRaw<Ticket[]>`SELECT * FROM "Ticket" WHERE id = ${id}::uuid ${scope} FOR UPDATE`
  return ticket
}

export async function ticketCalendar(tx: Tx, calendarId: string) {
  const holidays = await tx.holiday.findMany({ where: { calendarId }, select: { date: true } })
  return calendarFromDates(holidays)
}

export async function auditBreach(tx: Tx, ticketId: string, clock: Pick<Clock, 'kind' | 'cycle' | 'firstBreachedAt'>) {
  if (!clock.firstBreachedAt) return
  await tx.auditEvent.create({ data: {
    ticketId, actorKind: 'SYSTEM', action: 'SLA_BREACHED', effectiveAt: clock.firstBreachedAt,
    details: { kind: clock.kind, cycle: clock.cycle },
  }, select: { id: true } })
}

/** Caller holds the parent ticket lock, including when changing the clock's state. */
export async function storeClock(tx: Tx, previous: SlaClock, next: Clock) {
  const { state, budgetMs, elapsedMs, activeSince, pausedAt, dueAt, endedAt,
    completedDueAt, completionOnTime, firstBreachedAt } = next
  await tx.slaClock.update({ where: { id: previous.id }, data: {
    state, budgetMs, elapsedMs, activeSince, pausedAt, dueAt, endedAt,
    completedDueAt, completionOnTime, firstBreachedAt,
  }, select: { id: true } })
  if (!previous.firstBreachedAt && firstBreachedAt) await auditBreach(tx, previous.ticketId, next)
}

export async function persistMissed(tx: Tx, ticketId: string, at: Date) {
  const clocks = await tx.slaClock.findMany({ where: { ticketId, state: 'RUNNING', firstBreachedAt: null, dueAt: { lte: at } } })
  for (const clock of clocks) {
    const missed = missedDeadline(clock, at)
    if (missed) await storeClock(tx, clock, { ...clock, firstBreachedAt: missed })
  }
}

/** Returns true only when a closure was committed by the enclosing transaction. */
export async function closeWaiting(tx: Tx, ticket: Ticket, at: Date) {
  if (ticket.status !== 'WAITING' || !ticket.waitingSince || !ticket.closeDueAt || !closureDue(ticket.closeDueAt, at)) return false
  const cutoff = closureDeadline(ticket.waitingSince, await ticketCalendar(tx, ticket.calendarId))
  if (+cutoff !== +ticket.closeDueAt) return false
  const resolution = await tx.slaClock.findFirst({
    where: { ticketId: ticket.id, kind: 'RESOLUTION', state: { in: ['RUNNING', 'PAUSED'] } },
  })
  if (resolution && (resolution.state !== 'PAUSED' || !resolution.pausedAt || +resolution.pausedAt !== +ticket.waitingSince)) return false
  const status = requireTransition('close', ticket.status, 'SYSTEM')
  await persistMissed(tx, ticket.id, cutoff)
  if (resolution) await storeClock(tx, resolution, { ...resolution, state: 'CANCELED', endedAt: cutoff, pausedAt: null })
  await tx.ticket.update({ where: { id: ticket.id }, data: {
    status, closedAt: cutoff, closeProcessedAt: at, updatedAt: at, waitingSince: null, closeDueAt: null,
  }, select: { id: true } })
  await tx.auditEvent.create({ data: {
    ticketId: ticket.id, actorKind: 'SYSTEM', action: 'AUTO_CLOSED', effectiveAt: cutoff,
    oldStatus: ticket.status, newStatus: status,
    details: { waitingSince: ticket.waitingSince.toISOString(), cutoff: cutoff.toISOString(), processedAt: at.toISOString(),
      resolutionCycle: resolution?.cycle ?? null },
  }, select: { id: true } })
  return true
}

export function reconcileTicket(db: PrismaClient, id: string, now: () => Date, customerId?: string) {
  return db.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, id, customerId)
    if (!ticket) throw ticketNotFound()
    return closeWaiting(tx, ticket, now())
  })
}

export const batchSize = 40

export async function reconcileDue(db: PrismaClient, now: () => Date, limit = batchSize) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid reconciliation batch size.')
  const cutoff = now()
  const closed = await db.$transaction(async (tx) => {
    const tickets = await tx.$queryRaw<Ticket[]>`
      SELECT * FROM "Ticket" WHERE status = 'WAITING' AND "closeDueAt" <= ${cutoff}
      ORDER BY "closeDueAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    `
    let closed = 0
    for (const ticket of tickets) if (await closeWaiting(tx, ticket, now())) closed++
    return closed
  }, { timeout: 20_000 })
  const checked = await db.$transaction(async (tx) => {
    const tickets = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM "Ticket" t JOIN (
        SELECT "ticketId", min("dueAt") AS deadline FROM (
          SELECT "ticketId", "dueAt" FROM "SlaClock"
          WHERE state = 'RUNNING' AND "firstBreachedAt" IS NULL
            AND ("dueAt" < ${cutoff} OR ("dueAt" = ${cutoff} AND "elapsedMs" > "budgetMs"))
          ORDER BY "dueAt" LIMIT ${limit * 2}
        ) AS candidates GROUP BY "ticketId"
      ) AS due ON due."ticketId" = t.id
      WHERE t.status IN ('OPEN', 'WAITING')
        AND NOT (t.status = 'WAITING' AND t."closeDueAt" IS NOT NULL AND t."closeDueAt" <= ${cutoff})
      ORDER BY due.deadline, t.id LIMIT ${limit} FOR UPDATE OF t SKIP LOCKED
    `
    for (const { id } of tickets) await persistMissed(tx, id, now())
    return tickets.length
  }, { timeout: 20_000 })
  return { closed, checked }
}
