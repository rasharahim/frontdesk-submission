import { z } from 'zod'
import { Priority, type AuditAction, type PrismaClient } from '../generated/prisma/client.js'
import { reconcileTicket } from './reconciliation.js'

const id = z.uuid()
const instant = z.iso.datetime()
const cycle = z.number().int().positive()
const clock = z.object({
  cycle, budgetMs: z.number().int().nonnegative(), consumedMs: z.number().int().nonnegative(),
  deadline: instant.nullable(), firstBreachedAt: instant.nullable(), completionOnTime: z.boolean().nullable(),
})
const message = z.object({ messageId: id })
const waiting = message.extend({ waitingSince: instant, cutoff: instant, resolution: clock })
const kind = z.enum(['RESPONSE', 'RESOLUTION'])
const metadata = {
  CREATED: z.object({ sourceTicketId: id.optional() }),
  CLAIMED: z.object({ previousAssigneeId: z.null(), assigneeId: id }),
  PUBLIC_REPLY: message.extend({ firstResponse: z.object({
    status: z.enum(['COMPLETED_ON_TIME', 'COMPLETED_LATE']), deadline: instant.nullable(), completedAt: instant,
  }).optional() }),
  PRIVATE_NOTE: message,
  CUSTOMER_REPLY: message,
  WAIT_STARTED: waiting,
  WAIT_ENDED: waiting,
  RESOLVED: z.object({ messageId: id.nullable(), resolution: clock }),
  AUTO_CLOSED: z.object({ waitingSince: instant, cutoff: instant, processedAt: instant, resolutionCycle: cycle.nullable() }),
  REOPENED: message.extend({ previousResolvedAt: instant, previousCycle: cycle.nullable(), resolution: clock }),
  PRIORITY_CHANGED: z.object({ oldPriority: z.enum(Priority), priority: z.enum(Priority),
    clocks: z.array(z.object({ kind, old: clock, current: clock })).max(2) }),
  SLA_BREACHED: z.object({ kind, cycle, messageId: id.optional() }),
} satisfies Record<AuditAction, z.ZodType>

export const auditQuery = z.strictObject({
  afterId: z.string().regex(/^[1-9]\d{0,18}$/).transform(BigInt)
    .refine((value) => value <= 9_223_372_036_854_775_807n).optional(),
  limit: z.string().regex(/^(?:[1-9]\d?|100)$/).transform(Number).optional(),
})

export async function readAudit(db: PrismaClient, ticketId: string, query: z.output<typeof auditQuery>, now: () => Date) {
  await reconcileTicket(db, ticketId, now)
  const limit = query.limit ?? 30
  const rows = await db.auditEvent.findMany({
    where: { ticketId, id: { gt: query.afterId } }, orderBy: { id: 'asc' }, take: limit + 1,
    select: { id: true, ticketId: true, action: true, actorId: true, actorKind: true, effectiveAt: true,
      recordedAt: true, oldStatus: true, newStatus: true, details: true },
  })
  const items = rows.slice(0, limit).map(({ id: eventId, actorId, actorKind, details, ...fields }) => ({
    ...fields, id: eventId.toString(), actor: { kind: actorKind, id: actorId },
    details: metadata[fields.action].safeParse(details).data ?? {},
  }))
  return { items, nextAfterId: rows.length > limit ? items[items.length - 1].id : null }
}
