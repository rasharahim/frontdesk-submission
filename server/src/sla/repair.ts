import type { PrismaClient } from '../generated/prisma/client.js'
import { calendarFromDates } from './calendar.js'
import { complete, startClock } from './clock.js'

const reason = 'UTC deadline repair after non-UTC PostgreSQL session encoding during the Phase 4 backfill'
const shiftMs = 330 * 60_000

export type DeadlineEvidence = {
  clockId: string
  reference: string
  kind: 'RESPONSE' | 'RESOLUTION'
  cycle: number
  field: 'RUNNING_DUE_AT' | 'COMPLETED_DUE_AT'
  originalDeadline: Date
  expectedDeadline: Date
}

function invalid(): never {
  throw new Error('Clock or correction does not match the independently verified repair evidence.')
}

/** This maintenance operation must run as the database owner. */
export async function repairDeadlines(db: PrismaClient, evidence: readonly DeadlineEvidence[]) {
  const ids = new Set(evidence.map((item) => item.clockId))
  if (ids.size !== evidence.length || !evidence.length) invalid()
  return db.$transaction(async (tx) => {
    let corrections = 0
    let runningUpdates = 0
    const ordered = [...evidence].sort((a, b) => a.reference.localeCompare(b.reference) || a.clockId.localeCompare(b.clockId))
    for (const target of ordered) {
      const identity = await tx.slaClock.findUnique({ where: { id: target.clockId }, select: { ticketId: true } })
      if (!identity) invalid()
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${identity.ticketId}::uuid FOR UPDATE`
      const clock = await tx.slaClock.findUniqueOrThrow({ where: { id: target.clockId } })
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: identity.ticketId }, select: {
        reference: true, calendarId: true, priority: true, createdAt: true, status: true, waitingSince: true, resolvedAt: true,
      } })
      if (ticket.reference !== target.reference || clock.kind !== target.kind || clock.cycle !== target.cycle ||
          target.cycle !== 1 || +target.expectedDeadline - +target.originalDeadline !== shiftMs) invalid()

      const recorded = await tx.slaDeadlineCorrection.findUnique({ where: { clockId: clock.id } })
      if (recorded) {
        if (recorded.field !== target.field || +recorded.originalDeadline !== +target.originalDeadline ||
            +recorded.correctedDeadline !== +target.expectedDeadline || recorded.reason !== reason) invalid()
        continue
      }
      if (+clock.startedAt !== +ticket.createdAt || clock.firstBreachedAt || clock.pausedAt) invalid()
      const holidays = await tx.holiday.findMany({ where: { calendarId: ticket.calendarId }, select: { date: true } })
      const calendar = calendarFromDates(holidays)
      const fresh = startClock(clock.kind, ticket.priority, ticket.createdAt, calendar)
      const expected = fresh.dueAt
      if (!expected || +expected !== +target.expectedDeadline || fresh.originalBudgetMs !== clock.originalBudgetMs ||
          clock.originalBudgetMs !== clock.budgetMs) invalid()

      if (target.field === 'RUNNING_DUE_AT') {
        if (ticket.status !== 'OPEN' || clock.state !== 'RUNNING' || !clock.dueAt || !clock.activeSince ||
            +clock.dueAt !== +target.originalDeadline || +clock.activeSince !== +clock.startedAt || clock.elapsedMs !== 0n ||
            clock.endedAt || clock.completedDueAt || clock.completionOnTime !== null) invalid()
        await tx.slaClock.update({ where: { id: clock.id }, data: { dueAt: expected }, select: { id: true } })
        runningUpdates++
      } else {
        if (clock.kind !== 'RESPONSE' || clock.state !== 'COMPLETED' || !clock.endedAt || clock.dueAt || clock.activeSince ||
            !clock.completedDueAt || +clock.completedDueAt !== +target.originalDeadline ||
            (ticket.status !== 'WAITING' && ticket.status !== 'RESOLVED')) invalid()
        const cutoff = ticket.waitingSince ?? ticket.resolvedAt
        const reply = await tx.ticketMessage.findFirst({ where: {
          ticketId: identity.ticketId, kind: 'AGENT_PUBLIC', author: { role: 'AGENT' },
          createdAt: { gte: ticket.createdAt, lte: cutoff ?? undefined },
        }, select: { createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
        if (!reply || +reply.createdAt !== +clock.endedAt) invalid()
        const factual = complete(fresh, reply.createdAt, calendar)
        if (factual.completionOnTime !== clock.completionOnTime || factual.firstBreachedAt ||
            factual.elapsedMs !== clock.elapsedMs || (reply.createdAt <= clock.completedDueAt) !== clock.completionOnTime) invalid()
      }

      await tx.slaDeadlineCorrection.create({ data: {
        clockId: clock.id, field: target.field, originalDeadline: target.originalDeadline,
        correctedDeadline: expected, reason,
      }, select: { clockId: true } })
      corrections++
    }
    return { corrections, runningUpdates }
  }, { timeout: 20_000 })
}
