import { Router } from 'express'
import { z } from 'zod'
import { auditQuery, readAudit } from './audit.js'
import type { Sessions } from '../auth/session.js'
import type { PrismaClient } from '../generated/prisma/client.js'
import { validate } from '../http/errors.js'
import { createInput, idSchema, messageInput, priorityInput, queueInput, resolveInput } from './input.js'
import { ticketService } from './service.js'

export function ticketRoutes(db: PrismaClient, session: Sessions, now: () => Date) {
  const router = Router()
  const service = ticketService(db, now)
  router.use(session.requireSession)
  router.post('/', session.requireRole('CUSTOMER'), async (req, res) => {
    res.status(201).json(await service.create(session.identity(req).actor, validate(createInput, req.body)))
  })
  router.get('/', async (req, res) => {
    res.json(await service.list(session.identity(req).actor, validate(queueInput, req.query)))
  })
  router.get('/:id', async (req, res) => {
    validate(z.strictObject({}), req.query)
    res.json(await service.get(session.identity(req).actor, validate(idSchema, req.params.id)))
  })
  router.post('/:id/claim', session.requireRole('AGENT'), async (req, res) => {
    const id = validate(idSchema, req.params.id)
    validate(z.strictObject({}), req.body ?? {})
    res.json(await service.claim(session.identity(req).actor, id))
  })
  router.get('/:id/audit', session.requireRole('AGENT'), async (req, res) => {
    res.json(await readAudit(db, validate(idSchema, req.params.id), validate(auditQuery, req.query), now))
  })
  for (const [path, role, action] of [
    ['customer-replies', 'CUSTOMER', 'customerReply'], ['public-replies', 'AGENT', 'publicReply'], ['internal-notes', 'AGENT', 'note'],
  ] as const) {
    router.post('/:id/' + path, session.requireRole(role), async (req, res) => {
      const id = validate(idSchema, req.params.id)
      const { body } = validate(messageInput, req.body)
      res.status(201).json(await service.mutate(session.identity(req).actor, id, { action, body }))
    })
  }
  router.post('/:id/wait', session.requireRole('AGENT'), async (req, res) => {
    const actor = session.identity(req).actor
    const id = validate(idSchema, req.params.id)
    await service.mutate(actor, id, { action: 'wait', ...validate(messageInput, req.body) })
    res.json(await service.get(actor, id))
  })
  router.post('/:id/resolve', session.requireRole('AGENT'), async (req, res) => {
    const actor = session.identity(req).actor
    const id = validate(idSchema, req.params.id)
    await service.mutate(actor, id, { action: 'resolve', ...validate(resolveInput, req.body ?? {}) })
    res.json(await service.get(actor, id))
  })
  router.post('/:id/reopen', session.requireRole('CUSTOMER'), async (req, res) => {
    const actor = session.identity(req).actor
    const id = validate(idSchema, req.params.id)
    await service.mutate(actor, id, { action: 'reopen', ...validate(messageInput, req.body) })
    res.json(await service.get(actor, id))
  })
  router.patch('/:id/priority', session.requireRole('AGENT'), async (req, res) => {
    const actor = session.identity(req).actor
    const id = validate(idSchema, req.params.id)
    await service.mutate(actor, id, { action: 'priority', ...validate(priorityInput, req.body) })
    res.json(await service.get(actor, id))
  })
  return router
}
