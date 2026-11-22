import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../http/errors.js'
import type { SessionSettings, Sessions } from './session.js'
import { loginLimiter } from './security.js'

const credentials = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).refine((value) => Buffer.byteLength(value) <= 72),
})

export function authRoutes(session: Sessions, settings: SessionSettings, now: () => Date) {
  const router = Router()
  const limitLogin = loginLimiter(now)

  router.post('/login', async (req, res) => {
    const { email, password } = validate(credentials, req.body)
    limitLogin(req.ip ?? 'unknown', email)
    const { user, token, expiresAt } = await session.login(email, password)
    res.cookie(settings.cookieName, token, { ...session.cookie, expires: expiresAt }).json(user)
  })
  router.get('/me', session.requireSession, (req, res) => {
    res.json(session.identity(req).actor)
  })
  router.post('/logout', session.requireSession, async (req, res) => {
    if (req.body !== undefined) validate(z.strictObject({}), req.body)
    await session.logout(req)
    res.clearCookie(settings.cookieName, session.cookie).status(204).end()
  })
  return router
}
