import type { Prisma, PrismaClient, Priority, SlaClock, Ticket } from '../generated/prisma/client.js'
import type { Actor } from '../auth/session.js'
import { HttpError } from '../http/errors.js'
import { changeBudget, complete, nextResolution, pauseResolution, resumeResolution, startClock } from '../sla/clock.js'
import { finishFirstResponse, reconstructClocks } from '../sla/persistence.js'
import { closureDeadline, closureDue, reopenEligible, requireTransition } from './lifecycle-policy.js'
import { closeWaiting, historyUnavailable, lockTicket, storeClock, ticketCalendar, ticketNotFound } from './reconciliation.js'

type Tx = Prisma.TransactionClient
type Command =
  | { action: 'wait' | 'publicReply' | 'customerReply' | 'note' | 'reopen'; body: string }
  | { action: 'resolve'; body?: string }
  | { action: 'priority'; priority: Priority; reason: string }

export const messageFields = { id: true, body: true, kind: true, createdAt: true,
  author: { select: { displayName: true } } } as const

async function recordMessage(tx: Tx, ticket: Ticket, actor: Actor, at: Date, body: string, internal = false) {
  const staff = actor.role === 'AGENT'
  const created = await tx.ticketMessage.create({
    data: { ticketId: ticket.id, authorId: actor.id, body, createdAt: at,
      kind: internal ? 'INTERNAL' : staff ? 'AGENT_PUBLIC' : 'CUSTOMER_PUBLIC' },
    select: messageFields,
  })
  const firstResponse = staff && !internal ? await finishFirstResponse(tx, ticket.id, at, created.id) : undefined
  await tx.auditEvent.create({ data: {
    ticketId: ticket.id, actorId: actor.id, actorKind: 'USER',
    action: internal ? 'PRIVATE_NOTE' : staff ? 'PUBLIC_REPLY' : 'CUSTOMER_REPLY',
    effectiveAt: at, oldStatus: ticket.status, newStatus: ticket.status,
    details: { messageId: created.id, ...(firstResponse ? { firstResponse } : {}) },
  }, select: { id: true } })
  return created
}

const latestResolution = (tx: Tx, ticketId: string) => tx.slaClock.findFirst({
  where: { ticketId, kind: 'RESOLUTION' }, orderBy: { cycle: 'desc' },
})

function clockEvidence(clock: SlaClock | Awaited<ReturnType<typeof complete>>) {
  return { cycle: clock.cycle, budgetMs: Number(clock.budgetMs), consumedMs: Number(clock.elapsedMs),
    deadline: (clock.dueAt ?? clock.completedDueAt)?.toISOString() ?? null,
    firstBreachedAt: clock.firstBreachedAt?.toISOString() ?? null, completionOnTime: clock.completionOnTime }
}

export function ticketLifecycle(db: PrismaClient, now: () => Date) {
  async function execute(tx: Tx, ticket: Ticket, actor: Actor, at: Date, command: Command) {
    const status = requireTransition(command.action, ticket.status, actor.role)
    const agentPublic = command.action === 'publicReply' || command.action === 'wait' || command.action === 'resolve'
    if (agentPublic && !(await tx.slaClock.findUnique({
      where: { ticketId_kind_cycle: { ticketId: ticket.id, kind: 'RESPONSE', cycle: 1 } }, select: { id: true },
    }))) await reconstructClocks(tx, ticket.id)

    if (command.action === 'note' || command.action === 'publicReply' ||
        (command.action === 'customerReply' && ticket.status === 'OPEN')) {
      const message = await recordMessage(tx, ticket, actor, at, command.body, command.action === 'note')
      if (command.action !== 'note') {
        await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: at }, select: { id: true } })
      }
      return message
    }

    const resolution = await latestResolution(tx, ticket.id)
    const calendar = await ticketCalendar(tx, ticket.calendarId)
    const update = async (data: Prisma.TicketUncheckedUpdateInput) => {
      await tx.ticket.update({ where: { id: ticket.id }, data: { ...data, status, updatedAt: at }, select: { id: true } })
    }
    const audit = async (action: Prisma.AuditEventUncheckedCreateInput['action'], details: Prisma.InputJsonObject) => {
      await tx.auditEvent.create({ data: { ticketId: ticket.id, actorKind: 'USER', actorId: actor.id,
        action, effectiveAt: at, oldStatus: ticket.status, newStatus: status, details }, select: { id: true } })
    }

    if (command.action === 'reopen') {
      if (!ticket.resolvedAt || !reopenEligible(ticket.resolvedAt, at)) {
        throw new HttpError(409, 'REOPEN_EXPIRED', 'The reopening window has expired. Create a new ticket.')
      }
      if (resolution && resolution.state !== 'COMPLETED') throw historyUnavailable()
      const next = resolution ? nextResolution(resolution, ticket.priority, at, calendar)
        : startClock('RESOLUTION', ticket.priority, at, calendar, 2)
      const message = await recordMessage(tx, ticket, actor, at, command.body)
      await tx.slaClock.create({ data: { ticketId: ticket.id, ...next }, select: { id: true } })
      await update({ resolvedAt: null })
      await audit('REOPENED', { messageId: message.id, previousResolvedAt: ticket.resolvedAt.toISOString(),
        previousCycle: resolution?.cycle ?? null, resolution: clockEvidence(next) })
      return message
    }

    const expected = ticket.status === 'WAITING' ? 'PAUSED' : 'RUNNING'
    if (!resolution || resolution.state !== expected) throw historyUnavailable()
    if (ticket.status === 'WAITING' && (!ticket.waitingSince || !ticket.closeDueAt ||
        +closureDeadline(ticket.waitingSince, calendar) !== +ticket.closeDueAt ||
        !resolution.pausedAt || +resolution.pausedAt !== +ticket.waitingSince)) throw historyUnavailable()

    if (command.action === 'wait') {
      const message = await recordMessage(tx, ticket, actor, at, command.body)
      const paused = pauseResolution(resolution, at, calendar)
      const closeDueAt = closureDeadline(at, calendar)
      await storeClock(tx, resolution, paused)
      await update({ waitingSince: at, closeDueAt })
      await audit('WAIT_STARTED', { messageId: message.id, waitingSince: at.toISOString(), cutoff: closeDueAt.toISOString(),
        resolution: clockEvidence(paused) })
      return message
    }
    if (command.action === 'customerReply') {
      const message = await recordMessage(tx, ticket, actor, at, command.body)
      const resumed = resumeResolution(resolution, at, calendar)
      await storeClock(tx, resolution, resumed)
      await update({ waitingSince: null, closeDueAt: null })
      await audit('WAIT_ENDED', { messageId: message.id, waitingSince: ticket.waitingSince!.toISOString(),
        cutoff: ticket.closeDueAt!.toISOString(), resolution: clockEvidence(resumed) })
      return message
    }
    if (command.action === 'resolve') {
      const response = await tx.slaClock.findUnique({
        where: { ticketId_kind_cycle: { ticketId: ticket.id, kind: 'RESPONSE', cycle: 1 } },
      })
      if (!response && resolution.cycle === 1) throw historyUnavailable()
      if (response?.state !== 'COMPLETED' && !command.body) {
        throw new HttpError(409, 'FIRST_RESPONSE_REQUIRED', 'Include a public reply to resolve this ticket.')
      }
      const message = command.body ? await recordMessage(tx, ticket, actor, at, command.body) : null
      const resolved = complete(resolution, at, calendar)
      await storeClock(tx, resolution, resolved)
      await update({ resolvedAt: at })
      await audit('RESOLVED', { messageId: message?.id ?? null, resolution: clockEvidence(resolved) })
      return message
    }
    if (command.action === 'priority') {
      if (ticket.priority === command.priority) throw new HttpError(409, 'PRIORITY_UNCHANGED', 'Priority is unchanged.')
      const response = await tx.slaClock.findFirst({ where: { ticketId: ticket.id, kind: 'RESPONSE', state: 'RUNNING' } })
      const clocks = []
      for (const old of [response, resolution]) {
        if (!old) continue
        const changed = changeBudget(old, command.priority, at, calendar)
        await storeClock(tx, old, changed)
        clocks.push({ kind: old.kind, old: clockEvidence(old), current: clockEvidence(changed) })
      }
      await update({ priority: command.priority })
      await audit('PRIORITY_CHANGED', { oldPriority: ticket.priority, priority: command.priority, reason: command.reason, clocks })
    }
    return null
  }

  async function mutate(actor: Actor, id: string, command: Command) {
    const result = await db.$transaction(async (tx) => {
      const ticket = await lockTicket(tx, id, actor.role === 'CUSTOMER' ? actor.id : undefined)
      if (!ticket) throw ticketNotFound()
      if (actor.role === 'AGENT' && ticket.assigneeId !== actor.id) throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
      const at = now()
      if (await closeWaiting(tx, ticket, at)) return { closed: true, message: null }
      if (ticket.status === 'WAITING' && closureDue(ticket.closeDueAt, at)) throw historyUnavailable()
      return { closed: false, message: await execute(tx, ticket, actor, at, command) }
    })
    if (result.closed) throw new HttpError(409, 'TICKET_CLOSED', 'This ticket is closed. Create a new ticket.')
    return result.message
  }

  return { mutate }
}
