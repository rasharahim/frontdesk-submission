import { createHash, randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { isLocalDatabase, loadLocalEnv } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import type { PrismaClient, UserRole } from '../src/generated/prisma/client.js'

const origin = 'https://frontdesk.example.test'
const password = randomBytes(24).toString('base64url')
const run = randomUUID()
const account = (name: string, role: UserRole) => ({
  id: randomUUID(), email: name + '-' + run + '@example.test', displayName: name, role,
})
const customer = account('customer', 'CUSTOMER')
const other = account('other', 'CUSTOMER')
const agent = account('agent', 'AGENT')
const disabled = account('disabled', 'CUSTOMER')
let owner: PrismaClient
let runtime: PrismaClient
let app: ReturnType<typeof createApp>
let calendarId: string
let assigned: string
let waiting: string
let resolved: string
let foreign: string
let customerCookie: string
let agentCookie: string
const sentinel = 'staff only ' + run

function application(now?: () => Date) {
  return createApp({
    checkDatabase: () => runtime.$queryRaw`SELECT 1`,
    api: { db: runtime, now, settings: { cookieName: 'test_session', ttlHours: 8, secure: true, origins: [origin] } },
  })
}

function cookieOf(result: request.Response) {
  const headers = result.headers['set-cookie']
  if (!Array.isArray(headers) || typeof headers[0] !== 'string') throw new Error('Expected session cookie')
  return headers[0].split(';')[0]
}

function login(target: ReturnType<typeof createApp>, email: string, candidate = password) {
  return request(target).post('/api/auth/login').set('Origin', origin).send({ email, password: candidate })
}

function create(cookie: string, body: Record<string, unknown> = {}) {
  return request(app).post('/api/tickets').set('Origin', origin).set('Cookie', cookie)
    .send({ subject: 'Ticket ' + run, body: 'Customer description', priority: 'MEDIUM', ...body })
}

function message(id: string, path: string, cookie: string, body: Record<string, unknown> = { body: 'Hello' }) {
  return request(app).post('/api/tickets/' + id + '/' + path).set('Origin', origin).set('Cookie', cookie).send(body)
}

function get(path: string, cookie: string) {
  return request(app).get('/api/tickets' + path).set('Cookie', cookie)
}

beforeAll(async () => {
  loadLocalEnv('.env.test')
  loadLocalEnv('.env.migrate')
  const testUrl = process.env.TEST_DATABASE_URL
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL
  if (!testUrl || !ownerUrl || !isLocalDatabase(testUrl, 'frontdesk_test', 'runtime') ||
      !isLocalDatabase(ownerUrl, 'frontdesk_test', 'owner')) throw new Error('Requires isolated test connections.')
  runtime = createDatabase(testUrl)
  owner = createDatabase(ownerUrl)
  for (const [db, role] of [[runtime, 'frontdesk_test_runtime'], [owner, 'frontdesk_test_owner']] as const) {
    const [actual] = await db.$queryRaw<unknown[]>`SELECT current_database() AS db, current_user AS role, session_user AS login`
    expect(actual).toEqual({ db: 'frontdesk_test', role, login: role })
  }
  const hash = await bcrypt.hash(password, 4)
  await owner.user.createMany({ data: [customer, other, agent, disabled].map((entry) => ({
    ...entry, passwordHash: hash, disabledAt: entry.id === disabled.id ? new Date() : null,
  })) })
  await owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(824217)`
    let calendar = await tx.holidayCalendar.findFirst({ where: { publishedAt: { not: null } }, orderBy: { version: 'desc' } })
    if (!calendar) {
      const latest = await tx.holidayCalendar.findFirst({ orderBy: { version: 'desc' } })
      calendar = await tx.holidayCalendar.create({ data: { version: (latest?.version ?? 0) + 1 } })
      calendar = await tx.holidayCalendar.update({ where: { id: calendar.id }, data: { publishedAt: new Date() } })
    }
    calendarId = calendar.id
    const baseline = { subject: 'Fixture ' + run, description: 'Fixture description', priority: 'LOW' as const,
      customerId: customer.id, calendarId, createdAt: new Date('2025-01-01T00:00:00Z') }
    assigned = (await tx.ticket.create({ data: { ...baseline, assigneeId: agent.id } })).id
    waiting = (await tx.ticket.create({ data: { ...baseline, assigneeId: agent.id, status: 'WAITING', waitingSince: baseline.createdAt } })).id
    resolved = (await tx.ticket.create({ data: { ...baseline, assigneeId: agent.id, status: 'RESOLVED', resolvedAt: baseline.createdAt } })).id
    foreign = (await tx.ticket.create({ data: { ...baseline, customerId: other.id } })).id
  })
  app = application()
  customerCookie = cookieOf(await login(app, customer.email).expect(200))
  agentCookie = cookieOf(await login(app, agent.email).expect(200))
}, 15_000)

afterAll(async () => {
  await Promise.all([runtime?.$disconnect(), owner?.$disconnect()])
})

describe('authentication', () => {
  it('logs in a normalized customer, stores only the digest and sets a secure expiring cookie', async () => {
    const result = await login(app, ' ' + customer.email.toUpperCase() + ' ').expect(200)
    expect(result.body).toEqual({ id: customer.id, displayName: customer.displayName, role: 'CUSTOMER' })
    const raw = cookieOf(result).split('=')[1]
    expect(result.text).not.toContain(raw)
    expect(result.headers['set-cookie'][0]).toMatch(/Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Lax/)
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32)
    const digest = createHash('sha256').update(raw).digest()
    const session = await runtime.session.findUniqueOrThrow({ where: { tokenHash: digest } })
    expect(Buffer.from(session.tokenHash)).toEqual(digest)
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(8 * 3_600_000)
  })

  it('logs in an agent and returns only the public identity from me', async () => {
    const result = await request(app).get('/api/auth/me').set('Cookie', agentCookie).expect(200)
    expect(result.body).toEqual({ id: agent.id, displayName: agent.displayName, role: 'AGENT' })
  })

  it('uses the same error for unknown, disabled and incorrect credentials', async () => {
    const wrong = await login(app, customer.email, password + 'x').expect(401)
    const unknown = await login(app, 'unknown-' + run + '@example.test').expect(401)
    const inactive = await login(app, disabled.email).expect(401)
    expect(wrong.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } })
    expect(unknown.body).toEqual(wrong.body)
    expect(inactive.body).toEqual(wrong.body)
  })

  it('rejects invalid login bodies and bcrypt byte overflow', async () => {
    await login(app, 'invalid').expect(400)
    await login(app, customer.email, 'é'.repeat(37)).expect(400)
    await request(app).post('/api/auth/login').set('Origin', origin)
      .send({ email: customer.email, password, role: 'AGENT' }).expect(400)
  })

  it('rejects missing, malformed, ambiguous and unknown tokens', async () => {
    await request(app).get('/api/auth/me').expect(401)
    for (const value of ['test_session=short', customerCookie + '; ' + customerCookie,
      'test_session=' + randomBytes(32).toString('base64url')]) {
      await request(app).get('/api/auth/me').set('Cookie', value).expect(401)
    }
  })

  it('rejects a session at the exact expiration time', async () => {
    const start = Date.now()
    let time = start
    const timed = application(() => new Date(time))
    const cookie = cookieOf(await login(timed, customer.email).expect(200))
    time = start + 8 * 3_600_000 - 1
    await request(timed).get('/api/auth/me').set('Cookie', cookie).expect(200)
    time++
    await request(timed).get('/api/auth/me').set('Cookie', cookie).expect(401)
  })

  it('rejects database-revoked sessions', async () => {
    const cookie = cookieOf(await login(app, customer.email).expect(200))
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]).digest()
    await runtime.session.update({ where: { tokenHash }, data: { revokedAt: new Date() } })
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401)
  })

  it('logs out, persists revocation and clears the matching cookie', async () => {
    const cookie = cookieOf(await login(app, customer.email).expect(200))
    const logout = await request(app).post('/api/auth/logout').set('Origin', origin).set('Cookie', cookie).expect(204)
    expect(logout.headers['set-cookie'][0]).toMatch(/test_session=; Path=\/; Expires=.+; HttpOnly; Secure; SameSite=Lax/)
    const tokenHash = createHash('sha256').update(cookie.split('=')[1]).digest()
    expect((await runtime.session.findUniqueOrThrow({ where: { tokenHash } })).revokedAt).toBeInstanceOf(Date)
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401)
  })

  it('requires an allowed Origin or Referer on writes including login and logout', async () => {
    await request(app).post('/api/auth/login').send({ email: customer.email, password }).expect(403)
    await request(app).post('/api/auth/login').set('Origin', origin).type('form')
      .send({ email: customer.email, password }).expect(415)
    await request(app).post('/api/auth/login').set('Origin', 'null').set('Referer', origin + '/')
      .send({ email: customer.email, password }).expect(403)
    await request(app).post('/api/auth/logout').set('Cookie', customerCookie).set('Origin', 'https://untrusted.example.test').expect(403)
    await request(app).post('/api/tickets').set('Cookie', customerCookie)
      .send({ subject: 'CSRF', body: 'test', priority: 'LOW' }).expect(403)
    await request(app).post('/api/auth/login').set('Referer', origin + '/login')
      .send({ email: customer.email, password }).expect(200)
  })

  it('limits attempts per normalized account and resets after the window', async () => {
    let time = Date.now()
    const limited = application(() => new Date(time))
    for (let i = 0; i < 10; i++) await login(limited, customer.email, 'wrong-password').expect(401)
    await login(limited, customer.email.toUpperCase()).expect(429)
    time += 15 * 60_000
    await login(limited, customer.email).expect(200)
  })
})

describe('ticket API and privacy', () => {
  it('creates an owned open ticket with the published calendar and matching audit event', async () => {
    const result = await create(customerCookie).expect(201)
    expect(result.body).toMatchObject({ subject: 'Ticket ' + run, description: 'Customer description',
      status: 'OPEN', reference: expect.stringMatching(/^FD-\d+$/), messages: [] })
    const ticket = await runtime.ticket.findUniqueOrThrow({ where: { id: result.body.id } })
    expect(ticket).toMatchObject({ customerId: customer.id, assigneeId: null, calendarId, createdAt: expect.any(Date) })
    expect(await runtime.slaClock.count({ where: { ticketId: ticket.id } })).toBe(0)
    const events = await runtime.auditEvent.findMany({ where: { ticketId: ticket.id } })
    expect(events).toEqual([expect.objectContaining({ action: 'CREATED', actorId: customer.id, actorKind: 'USER',
      effectiveAt: ticket.createdAt, newStatus: 'OPEN', details: {} })])
    expect(result.body).not.toHaveProperty('customerId')
  })

  it('rejects invalid create input, injected fields, agents and missing authentication', async () => {
    for (const fields of [{ subject: ' ' }, { body: ' ' }, { priority: 'FAKE' },
      { customerId: other.id }, { assigneeId: agent.id }, { status: 'RESOLVED' }, { actorId: other.id }, { createdAt: '2025' }]) {
      await create(customerCookie, fields).expect(400)
    }
    await create(agentCookie).expect(403)
    await create('').expect(401)
  })

  it('allows only an owned terminal source ticket', async () => {
    await create(customerCookie, { sourceTicketId: assigned }).expect(404)
    await create(customerCookie, { sourceTicketId: foreign }).expect(404)
    const result = await create(customerCookie, { sourceTicketId: resolved }).expect(201)
    expect((await runtime.ticket.findUniqueOrThrow({ where: { id: result.body.id } })).sourceTicketId).toBe(resolved)
  })

  it('allocates distinct references across concurrent creates', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(customerCookie).expect(201)))
    expect(new Set(results.map(({ body }) => body.reference)).size).toBe(5)
  })

  it('scopes customer pages, search and detail to the customer', async () => {
    await create(customerCookie, { subject: 'Pagination ' + run }).expect(201)
    await create(customerCookie, { subject: 'Pagination ' + run }).expect(201)
    const page = '?limit=1&q=' + encodeURIComponent('Pagination ' + run)
    const first = await get(page, customerCookie).expect(200)
    const second = await get(page + '&page=2', customerCookie).expect(200)
    expect(first.body).toMatchObject({ page: 1, limit: 1, total: 2 })
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id)
    expect((await get(page, customerCookie).expect(200)).body).toEqual(first.body)
    await get('/' + assigned, customerCookie).expect(200)
    const denied = await get('/' + foreign, customerCookie).expect(404)
    expect((await get('/' + randomUUID(), customerCookie).expect(404)).body).toEqual(denied.body)
    expect((await get('?q=' + foreign, customerCookie).expect(200)).body.items).toEqual([])
  })

  it('supports agent scope, assignment, status, priority, counts and validated query bounds', async () => {
    const result = await get('?status=WAITING&priority=LOW&assigneeId=' + agent.id + '&q=' + run, agentCookie).expect(200)
    expect(result.body.items.map((item: { id: string }) => item.id)).toEqual([waiting])
    expect(result.body.counts).toEqual({ open: 1, waiting: 1, overdue: null })
    expect(result.body.items[0]).toMatchObject({ assignee: { id: agent.id }, sla: null, waitingSince: expect.any(String) })
    expect((await get('?scope=unassigned&q=' + foreign, agentCookie).expect(200)).body.items[0].id).toBe(foreign)
    await get('/' + foreign, agentCookie).expect(200)
    await get('?scope=all', customerCookie).expect(403)
    await get('?assigneeId=' + agent.id, customerCookie).expect(403)
    await get('?scope=all&sla=overdue', agentCookie).expect(409)
    for (const query of ['?page=0', '?limit=51', '?page=1&page=2', '?unknown=yes', '/not-a-uuid']) {
      await get(query, agentCookie).expect(400)
    }
  })

  it('writes both public reply kinds and their corresponding actor-bound audit', async () => {
    for (const [path, cookie, kind, action, actor] of [
      ['customer-replies', customerCookie, 'CUSTOMER_PUBLIC', 'CUSTOMER_REPLY', customer],
      ['public-replies', agentCookie, 'AGENT_PUBLIC', 'PUBLIC_REPLY', agent],
    ] as const) {
      const result = await message(assigned, path, cookie, { body: '  public text  ' }).expect(201)
      expect(result.body).toMatchObject({ kind, body: 'public text', author: { displayName: actor.displayName } })
      const event = await runtime.auditEvent.findFirstOrThrow({
        where: { ticketId: assigned, action, details: { path: ['messageId'], equals: result.body.id } },
      })
      expect(event).toMatchObject({ actorId: actor.id, details: { messageId: result.body.id }, effectiveAt: new Date(result.body.createdAt) })
    }
  })

  it('writes internal notes without changing ticket or SLA and excludes them from customer responses', async () => {
    await message(assigned, 'public-replies', agentCookie).expect(201)
    const before = await runtime.ticket.findUniqueOrThrow({ where: { id: assigned } })
    const clocks = await runtime.slaClock.findMany({ where: { ticketId: assigned } })
    const result = await message(assigned, 'internal-notes', agentCookie, { body: sentinel }).expect(201)
    expect(result.body.kind).toBe('INTERNAL')
    expect(await runtime.ticket.findUniqueOrThrow({ where: { id: assigned } })).toEqual(before)
    expect(await runtime.slaClock.findMany({ where: { ticketId: assigned } })).toEqual(clocks)
    const event = await runtime.auditEvent.findFirstOrThrow({ where: { ticketId: assigned, action: 'PRIVATE_NOTE' } })
    expect(event).toMatchObject({ actorId: agent.id, details: { messageId: result.body.id } })
    expect((await get('/' + assigned, agentCookie).expect(200)).text).toContain(sentinel)
    const publicDetail = await get('/' + assigned, customerCookie).expect(200)
    expect(publicDetail.body.messages).toContainEqual(expect.objectContaining({ kind: 'AGENT_PUBLIC' }))
    expect(publicDetail.body.messages.every((entry: { kind: string }) => entry.kind !== 'INTERNAL')).toBe(true)
    for (const response of [publicDetail, await get('', customerCookie).expect(200),
      await get('?q=' + encodeURIComponent(sentinel), customerCookie).expect(200), await create(customerCookie).expect(201),
      await message(assigned, 'customer-replies', customerCookie).expect(201)]) {
      expect(response.text).not.toContain(sentinel)
      expect(response.text).not.toContain(result.body.id)
      expect(response.text).not.toContain('INTERNAL')
    }
    expect((await get('?q=' + encodeURIComponent(sentinel), customerCookie).expect(200)).body.items).toEqual([])
  })

  it('rejects unauthorized, spoofed and unsupported message mutations', async () => {
    await message(assigned, 'internal-notes', customerCookie).expect(403)
    await message(assigned, 'public-replies', customerCookie).expect(403)
    await message(assigned, 'customer-replies', agentCookie).expect(403)
    await message(foreign, 'customer-replies', customerCookie).expect(404)
    await message(foreign, 'public-replies', agentCookie).expect(403)
    await message(waiting, 'customer-replies', customerCookie).expect(409)
    await message(resolved, 'public-replies', agentCookie).expect(409)
    for (const extra of [{ kind: 'AGENT_PUBLIC' }, { authorId: agent.id }, { actorId: agent.id }, { body: ' ' }]) {
      await message(assigned, 'customer-replies', customerCookie, { body: 'Hello', ...extra }).expect(400)
    }
    expect(await runtime.ticketMessage.count({ where: { ticketId: { in: [waiting, resolved, foreign] } } })).toBe(0)
  })

  it('rolls back ticket and message mutations when the audit insert fails', async () => {
    const subject = 'Rollback fixture ' + run
    const rollbackTicket = await owner.ticket.create({ data: { subject, description: 'Fixture',
      calendarId, customerId: customer.id, priority: 'LOW' } })
    // The test owner adds an insert rejection only. Runtime grants and all protection triggers stay intact.
    await owner.$executeRaw`CREATE FUNCTION phase3_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT FROM "Ticket" WHERE id = NEW."ticketId" AND subject LIKE 'Rollback fixture %') THEN
          RAISE EXCEPTION 'test audit write rejected';
        END IF;
        RETURN NEW;
      END;$$`
    try {
      await owner.$executeRaw`CREATE TRIGGER "phase3_reject_audit" BEFORE INSERT ON "AuditEvent"
        FOR EACH ROW EXECUTE FUNCTION phase3_reject_audit()`
      const failure = await create(customerCookie, { subject }).expect(500)
      expect(failure.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } })
      await message(rollbackTicket.id, 'customer-replies', customerCookie).expect(500)
      expect(await runtime.ticket.count({ where: { subject } })).toBe(1)
      expect(await runtime.ticketMessage.count({ where: { ticketId: rollbackTicket.id } })).toBe(0)
      expect(await runtime.auditEvent.count({ where: { ticketId: rollbackTicket.id } })).toBe(0)
      expect(await runtime.ticket.findUniqueOrThrow({ where: { id: rollbackTicket.id } })).toEqual(rollbackTicket)
    } finally {
      await owner.$executeRaw`DROP TRIGGER IF EXISTS "phase3_reject_audit" ON "AuditEvent"`
      await owner.$executeRaw`DROP FUNCTION phase3_reject_audit()`
    }
  })
})
