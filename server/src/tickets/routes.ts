import { Router } from 'express'
import type { Sessions } from '../auth/session.js'
import type { PrismaClient } from '../generated/prisma/client.js'
import { validate } from '../http/errors.js'
import { createInput, idSchema, messageInput, queueInput } from './input.js'
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
    res.json(await service.get(session.identity(req).actor, validate(idSchema, req.params.id)))
  })
  for (const [path, role, internal] of [
    ['customer-replies', 'CUSTOMER', false], ['public-replies', 'AGENT', false], ['internal-notes', 'AGENT', true],
  ] as const) {
    router.post('/:id/' + path, session.requireRole(role), async (req, res) => {
      const id = validate(idSchema, req.params.id)
      const { body } = validate(messageInput, req.body)
      res.status(201).json(await service.writeMessage(session.identity(req).actor, id, body, internal))
    })
  }
  return router
}
