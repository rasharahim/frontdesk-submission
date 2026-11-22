import type { RequestHandler } from 'express'
import { HttpError } from '../http/errors.js'

export function requireSameOrigin(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins)
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
    const origin = req.get('origin')
    let source = origin
    if (origin === undefined) {
      try { source = new URL(req.get('referer') ?? '').origin } catch { /* Reject below. */ }
    }
    if (!source || !allowed.has(source)) {
      return next(new HttpError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.'))
    }
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
    if (hasBody && !req.is('application/json')) {
      return next(new HttpError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Use an application/json request body.'))
    }
    next()
  }
}

export function loginLimiter(now: () => Date) {
  const windowMs = 15 * 60_000
  const limit = 10_000
  const attempts = new Map<string, { count: number; expiresAt: number }>()
  let nextSweep = 0
  return (ip: string, email: string) => {
    const timestamp = now().getTime()
    if (timestamp >= nextSweep) {
      for (const [key, entry] of attempts) if (entry.expiresAt <= timestamp) attempts.delete(key)
      nextSweep = timestamp + 60_000
    }
    const keys = [{ key: 'ip:' + ip, max: 30 }, { key: 'account:' + email, max: 10 }]
    const active = keys.map(({ key }) => {
      const entry = attempts.get(key)
      return entry && entry.expiresAt > timestamp ? entry : undefined
    })
    const newKeys = keys.filter(({ key }) => !attempts.has(key)).length
    if (attempts.size + newKeys > limit || keys.some(({ max }, i) => (active[i]?.count ?? 0) >= max)) {
      throw new HttpError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts. Try again later.')
    }
    keys.forEach(({ key }, i) => {
      const entry = active[i]
      attempts.set(key, { count: (entry?.count ?? 0) + 1, expiresAt: entry?.expiresAt ?? timestamp + windowMs })
    })
  }
}
