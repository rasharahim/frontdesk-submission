import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcrypt'
import type { Request, RequestHandler } from 'express'
import type { PrismaClient, UserRole } from '../generated/prisma/client.js'
import { HttpError } from '../http/errors.js'

const publicUser = { id: true, displayName: true, role: true } as const
export type Actor = { id: string; displayName: string; role: UserRole }
export type SessionSettings = { cookieName: string; ttlHours: number; secure: boolean; origins: readonly string[] }

const dummyHash = bcrypt.hash(randomBytes(32).toString('hex'), 12)
const digest = (token: string) => createHash('sha256').update(token).digest()

function readToken(req: Request, name: string) {
  const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='))
  if (values.length !== 1) return undefined
  const token = values[0].slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined
}

export function sessions(db: PrismaClient, settings: SessionSettings, now: () => Date) {
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: settings.secure, path: '/' }
  const authenticated = new WeakMap<Request, { actor: Actor; sessionId: string }>()

  const requireSession: RequestHandler = async (req, _res, next) => {
    const token = readToken(req, settings.cookieName)
    const session = token && await db.session.findUnique({
      where: { tokenHash: digest(token) },
      select: { id: true, revokedAt: true, expiresAt: true,
        user: { select: { ...publicUser, disabledAt: true } } },
    })
    if (!session || session.revokedAt || session.expiresAt <= now() || session.user.disabledAt) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
    }
    const { id, displayName, role } = session.user
    authenticated.set(req, { actor: { id, displayName, role }, sessionId: session.id })
    next()
  }

  function identity(req: Request) {
    const session = authenticated.get(req)
    if (!session) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
    return session
  }

  const requireRole = (role: UserRole): RequestHandler => (req, _res, next) => {
    if (identity(req).actor.role !== role) throw new HttpError(403, 'FORBIDDEN', 'Permission denied.')
    next()
  }

  async function login(email: string, password: string) {
    const user = await db.user.findUnique({
      where: { email },
      select: { ...publicUser, passwordHash: true, disabledAt: true },
    })
    const hash = user && /^\$2[ab]\$\d\d\$[./A-Za-z0-9]{53}$/.test(user.passwordHash) ? user.passwordHash : null
    const verified = await bcrypt.compare(password, hash ?? await dummyHash)
    if (!user || user.disabledAt || !hash || !verified) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.')
    }
    const token = randomBytes(32).toString('base64url')
    const createdAt = now()
    const expiresAt = new Date(createdAt.getTime() + settings.ttlHours * 3_600_000)
    await db.session.create({ data: { userId: user.id, tokenHash: digest(token), createdAt, expiresAt }, select: { id: true } })
    const { id, displayName, role } = user
    return { user: { id, displayName, role }, token, expiresAt }
  }

  async function logout(req: Request) {
    await db.session.updateMany({
      where: { id: identity(req).sessionId, revokedAt: null },
      data: { revokedAt: now() },
    })
  }

  return { cookie, requireSession, requireRole, identity, login, logout }
}

export type Sessions = ReturnType<typeof sessions>
