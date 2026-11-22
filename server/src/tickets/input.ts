import { z } from 'zod'
import { Priority, TicketStatus } from '../generated/prisma/client.js'

export const idSchema = z.uuid()
const body = z.string().trim().min(1).max(4000)
export const resolveInput = z.strictObject({ body: body.optional() })
export const priorityInput = z.strictObject({ priority: z.enum(Priority), reason: z.string().trim().min(1).max(500) })
export const messageInput = z.strictObject({ body })
export const createInput = z.strictObject({
  subject: z.string().trim().min(1).max(160),
  body,
  priority: z.enum(Priority),
  sourceTicketId: idSchema.optional(),
})
const integerQuery = (max: number, fallback: number) => z.string().regex(/^[1-9]\d{0,3}$/)
  .transform(Number).pipe(z.number().int().max(max)).optional().transform((value) => value ?? fallback)
export const queueInput = z.strictObject({
  status: z.enum(TicketStatus).optional(),
  priority: z.enum(Priority).optional(),
  q: z.string().trim().min(1).max(160).optional(),
  page: integerQuery(1000, 1),
  limit: integerQuery(50, 20),
  scope: z.enum(['mine', 'unassigned', 'all']).optional(),
  assigneeId: idSchema.optional(),
  sla: z.enum(['overdue', 'historical']).optional(),
})
export type CreateInput = z.output<typeof createInput>
export type QueueInput = z.output<typeof queueInput>
