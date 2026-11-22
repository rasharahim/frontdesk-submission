import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { businessCalendar } from '../src/sla/calendar.js'
import { startClock, pauseResolution } from '../src/sla/clock.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { isLocalDatabase, loadLocalEnv } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import { initializeClocks, backfillClocks } from '../src/sla/persistence.js'
import type { PrismaClient, UserRole } from '../src/generated/prisma/client.js'

import { reconcileDue } from '../src/tickets/reconciliation.js'

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
    expect(await runtime.slaClock.count({ where: { ticketId: ticket.id } })).toBe(2)
    expect(result.body).not.toHaveProperty('sla')
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
    expect(result.body.counts).toEqual({ open: 1, waiting: 1, overdue: 0 })
    expect(result.body.items[0]).toMatchObject({ assignee: { id: agent.id }, sla: { resolution: null, historicalBreach: false }, waitingSince: expect.any(String) })
    expect((await get('?scope=unassigned&q=' + foreign, agentCookie).expect(200)).body.items[0].id).toBe(foreign)
    await get('/' + foreign, agentCookie).expect(200)
    await get('?scope=all', customerCookie).expect(403)
    await get('?assigneeId=' + agent.id, customerCookie).expect(403)
    await get('?scope=all&sla=overdue', agentCookie).expect(200)
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
      calendarId, customerId: customer.id, assigneeId: agent.id, priority: 'LOW' } })
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
      await message(rollbackTicket.id, 'public-replies', agentCookie).expect(500)
      expect(await runtime.slaClock.count({ where: { ticketId: rollbackTicket.id } })).toBe(0)
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

// Fixed instants at the application boundary keep connection and locking behavior real.
describe('persisted SLA', () => {
  const initial = '2026-11-23T04:00:00.000Z'
  async function timedFixture(start = initial) {
    let now = new Date(start)
    const target = application(() => now)
    const ownerCookie = cookieOf(await login(target, customer.email).expect(200))
    const staffCookie = cookieOf(await login(target, agent.email).expect(200))
    const subject = 'SLA ' + randomUUID()
    const createTicket = () => request(target).post('/api/tickets').set('Origin', origin).set('Cookie', ownerCookie)
      .send({ subject, body: 'SLA fixture', priority: 'URGENT' })
    const makeAssigned = async () => {
      const result = await createTicket().expect(201)
      await owner.ticket.update({ where: { id: result.body.id }, data: { assigneeId: agent.id } })
      return result.body.id as string
    }
    const send = (id: string, path: string, cookie: string) =>
      request(target).post('/api/tickets/' + id + '/' + path).set('Origin', origin).set('Cookie', cookie).send({ body: 'SLA fixture reply' })
    const read = (path: string, cookie = staffCookie) => request(target).get('/api/tickets' + path).set('Cookie', cookie)
    return { subject, ownerCookie, staffCookie, createTicket, makeAssigned, send, read,
      setTime: (value: string) => { now = new Date(value) } }
  }

  it('persists both budgets, deadlines, cycle and calendar at the creation instant', async () => {
    const fixture = await timedFixture()
    const id = await fixture.makeAssigned()
    const ticket = await runtime.ticket.findUniqueOrThrow({ where: { id }, include: { clocks: true } })
    expect(ticket.calendarId).toBe(calendarId)
    expect(ticket.clocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'RESPONSE', cycle: 1, startedAt: new Date(initial), budgetMs: 7_200_000n,
        originalBudgetMs: 7_200_000n, dueAt: new Date('2026-11-23T06:00:00.000Z') }),
      expect.objectContaining({ kind: 'RESOLUTION', cycle: 1, startedAt: new Date(initial), budgetMs: 32_400_000n,
        originalBudgetMs: 32_400_000n, dueAt: new Date('2026-11-23T13:00:00.000Z') }),
    ]))
    const stored = await runtime.$queryRaw<{ kind: string; utc: string; timezone: string }[]>`
      SELECT kind, to_char("dueAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc,
        current_setting('TimeZone') AS timezone
      FROM "SlaClock" WHERE "ticketId" = ${id}::uuid ORDER BY kind
    `
    expect(stored).toEqual([
      { kind: 'RESPONSE', utc: '2026-11-23T06:00:00.000Z', timezone: 'UTC' },
      { kind: 'RESOLUTION', utc: '2026-11-23T13:00:00.000Z', timezone: 'UTC' },
    ])
    expect((await fixture.read('/' + id, fixture.ownerCookie).expect(200)).body).not.toHaveProperty('sla')
  })

  it('rolls back a just-created ticket when clock initialization rejects its instant', async () => {
    const fixture = await timedFixture('1969-01-02T10:00:00.000Z')
    await fixture.createTicket().expect(500)
    expect(await runtime.ticket.count({ where: { subject: fixture.subject } })).toBe(0)
  })

  it('customer, private and unauthorized messages leave both SLA clocks unchanged', async () => {
    const fixture = await timedFixture()
    const id = await fixture.makeAssigned()
    const read = () => runtime.slaClock.findMany({ where: { ticketId: id }, orderBy: { kind: 'asc' } })
    const before = await read()
    await fixture.send(id, 'internal-notes', fixture.staffCookie).expect(201)
    await fixture.send(id, 'customer-replies', fixture.ownerCookie).expect(201)
    await fixture.send(id, 'public-replies', fixture.ownerCookie).expect(403)
    expect(await read()).toEqual(before)
  })

  it('accepts an exact-deadline response once and leaves resolution running', async () => {
    const fixture = await timedFixture()
    const id = await fixture.makeAssigned()
    fixture.setTime('2026-11-23T06:00:00.000Z')
    const clock = () => runtime.slaClock.findUniqueOrThrow({ where: { ticketId_kind_cycle: { ticketId: id, kind: 'RESPONSE', cycle: 1 } } })
    await fixture.send(id, 'public-replies', fixture.staffCookie).expect(201)
    const first = await clock()
    expect(first).toMatchObject({ state: 'COMPLETED', completionOnTime: true, firstBreachedAt: null,
      endedAt: new Date('2026-11-23T06:00:00.000Z'), completedDueAt: new Date('2026-11-23T06:00:00.000Z') })
    fixture.setTime('2026-11-23T06:01:00.000Z')
    await fixture.send(id, 'public-replies', fixture.staffCookie).expect(201)
    expect(await clock()).toEqual(first)
    expect((await fixture.read('/' + id).expect(200)).body.sla).toMatchObject({
      response: { status: 'COMPLETED_ON_TIME' }, resolution: { status: 'ACTIVE' }, historicalBreach: false,
    })
  })

  it('serializes simultaneous late replies and persists exactly one breach and completion', async () => {
    const fixture = await timedFixture()
    const id = await fixture.makeAssigned()
    fixture.setTime('2026-11-23T06:00:00.001Z')
    await Promise.all(Array.from({ length: 3 }, () => fixture.send(id, 'public-replies', fixture.staffCookie).expect(201)))
    const events = await runtime.auditEvent.findMany({ where: { ticketId: id }, orderBy: { id: 'asc' } })
    expect(events.filter((event) => event.action === 'SLA_BREACHED')).toEqual([
      expect.objectContaining({ actorKind: 'SYSTEM', effectiveAt: new Date('2026-11-23T06:00:00.000Z') }),
    ])
    const replies = events.filter((event) => event.action === 'PUBLIC_REPLY')
    expect(replies).toHaveLength(3)
    expect(replies[0].details).toMatchObject({ firstResponse: { status: 'COMPLETED_LATE' } })
    expect(replies[1].details).not.toHaveProperty('firstResponse')
    expect(replies[2].details).not.toHaveProperty('firstResponse')
    expect((await fixture.read('/' + id).expect(200)).body.sla).toMatchObject({
      response: { status: 'COMPLETED_LATE', consumedMs: 7_200_001, firstBreachedAt: '2026-11-23T06:00:00.000Z' },
      historicalBreach: true,
    })
    expect((await fixture.read('?sla=historical&q=' + fixture.subject).expect(200)).body.total).toBe(1)
  })

  it('filters overdue before pagination, uses a shared evaluation instant and leaves reads side-effect free', async () => {
    const fixture = await timedFixture()
    const ids = await Promise.all(Array.from({ length: 3 }, () => fixture.makeAssigned()))
    fixture.setTime('2026-11-23T06:00:00.000Z')
    expect((await fixture.read('?sla=overdue&q=' + fixture.subject).expect(200)).body.total).toBe(0)
    fixture.setTime('2026-11-23T06:00:00.001Z')
    const query = '?sla=overdue&limit=2&q=' + fixture.subject
    const first = (await fixture.read(query).expect(200)).body
    const second = (await fixture.read(query + '&page=2').expect(200)).body
    expect(first).toMatchObject({ total: 3, counts: { overdue: 3 } })
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(1)
    for (const item of [...first.items, ...second.items]) {
      expect(ids).toContain(item.id)
      expect(item.sla).toMatchObject({ asOf: '2026-11-23T06:00:00.001Z', response: { status: 'OVERDUE', overdueWorkingMs: 1 } })
    }
    expect(await runtime.slaClock.count({ where: { ticketId: { in: ids }, firstBreachedAt: { not: null } } })).toBe(0)
  })

  it('keeps existing deadlines when another holiday calendar version is published', async () => {
    const latest = await owner.holidayCalendar.findFirstOrThrow({ orderBy: { version: 'desc' } })
    const day = new Date(Date.UTC(2040, 0, 2 + 7 * latest.version, 4))
    const fixture = await timedFixture(day.toISOString())
    const old = await fixture.makeAssigned()
    const prior = (await fixture.read('/' + old).expect(200)).body.sla
    await owner.$transaction(async (tx) => {
      const newer = await tx.holidayCalendar.create({ data: { version: latest.version + 1,
        holidays: { create: { date: new Date(day.toISOString().slice(0, 10)), label: 'SLA calendar version fixture' } } } })
      await tx.holidayCalendar.update({ where: { id: newer.id }, data: { publishedAt: new Date() } })
    })
    const current = await fixture.makeAssigned()
    expect((await fixture.read('/' + old).expect(200)).body.sla).toEqual(prior)
    const fresh = (await fixture.read('/' + current).expect(200)).body.sla
    expect(fresh.calendarVersion).toBe(latest.version + 1)
    expect(fresh.response.deadline > prior.response.deadline).toBe(true)
  })

  it('backfills factual replies and preserves initialized clocks on rerun', async () => {
    const before = await runtime.slaClock.findMany({ where: { ticketId: assigned }, orderBy: { kind: 'asc' } })
    expect(before).toHaveLength(2)
    const first = await backfillClocks(runtime)
    expect(first.unresolvedTickets).toBeGreaterThan(0)
    const second = await backfillClocks(runtime)
    expect(second).toEqual({ initializedTickets: 0, initializedClocks: 0, unresolvedTickets: first.unresolvedTickets })
    expect(await runtime.slaClock.findMany({ where: { ticketId: assigned }, orderBy: { kind: 'asc' } })).toEqual(before)
    expect(await runtime.slaClock.count({ where: { ticketId: waiting } })).toBe(0)
  })
})

describe('Phase 5 lifecycle', () => {
  const start = new Date('2026-11-23T04:00:00.000Z')
  const cutoff = new Date('2026-11-27T13:00:00.000Z')
  const hours = 3_600_000
  async function setup(priority: 'MEDIUM' | 'URGENT' = 'MEDIUM') {
    let now = start
    const target = application(() => now)
    const subject = 'Lifecycle ' + randomUUID()
    const data = { customerId: customer.id, assigneeId: agent.id, calendarId, priority, subject, description: 'Lifecycle fixture', createdAt: start }
    const ticket = await runtime.$transaction(async (tx) => {
      const result = await tx.ticket.create({ data })
      await initializeClocks(tx, result, [])
      return result
    })
    const cookies = new Map<string, { cookie: string; expires: number }>()
    async function headers(email: string) {
      let saved = cookies.get(email)
      if (!saved || saved.expires <= +now) {
        const response = await login(target, email).expect(200)
        saved = { cookie: cookieOf(response), expires: +now + 8 * hours }
        cookies.set(email, saved)
      }
      return { Cookie: saved.cookie, Origin: origin }
    }
    async function act(path: string, email: string, body?: Record<string, unknown>) {
      const url = '/api/tickets/' + ticket.id + '/' + path
      const req = path === 'priority' ? request(target).patch(url) : request(target).post(url)
      req.set(await headers(email))
      return body === undefined ? req : req.send(body)
    }
    const read = async (suffix: string, email = agent.email) => request(target).get('/api/tickets' + suffix).set(await headers(email))
    const clock = (kind: 'RESPONSE' | 'RESOLUTION' = 'RESOLUTION') => runtime.slaClock.findFirstOrThrow({
      where: { ticketId: ticket.id, kind }, orderBy: { cycle: 'desc' },
    })
    const event = (action: 'WAIT_STARTED' | 'WAIT_ENDED' | 'RESOLVED' | 'REOPENED' | 'AUTO_CLOSED' | 'PRIORITY_CHANGED' | 'SLA_BREACHED') =>
      runtime.auditEvent.findMany({ where: { ticketId: ticket.id, action }, orderBy: { id: 'asc' } })
    return { id: ticket.id, subject, at: (t: Date | string) => { now = new Date(t) }, act, read, clock, event,
      ticket: () => runtime.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      wait: () => act('wait', agent.email, { body: 'Could you confirm?' }),
      reply: () => act('customer-replies', customer.email, { body: 'Confirmed.' }),
      resolve: (body?: string) => act('resolve', agent.email, body ? { body } : undefined),
      reopen: () => act('reopen', customer.email, { body: 'Issue remains.' }),
    }
  }

  it('pauses for a public question and resumes the worked Medium example at Friday 15:30 IST', async () => {
    const f = await setup()
    f.at('2026-11-23T08:00:00.000Z')
    expect((await f.wait()).status).toBe(200)
    expect(await f.clock()).toMatchObject({ state: 'PAUSED', elapsedMs: 14_400_000n })
    expect(await f.clock('RESPONSE')).toMatchObject({ state: 'COMPLETED', completionOnTime: true })
    expect(await f.ticket()).toMatchObject({ status: 'WAITING', waitingSince: new Date('2026-11-23T08:00:00Z'),
      closeDueAt: new Date('2026-11-30T08:00:00Z') })
    const [utc] = await runtime.$queryRaw<{ at: string; zone: string }[]>`
      SELECT to_char("waitingSince" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      current_setting('TimeZone') AS zone FROM "Ticket" WHERE id = ${f.id}::uuid`
    expect(utc).toEqual({ at: '2026-11-23T08:00:00.000Z', zone: 'UTC' })
    f.at('2026-11-25T05:00:00.000Z')
    expect((await f.reply()).status).toBe(201)
    expect(await f.clock()).toMatchObject({ state: 'RUNNING', elapsedMs: 14_400_000n, dueAt: new Date('2026-11-27T10:00:00Z') })
    expect(await f.ticket()).toMatchObject({ status: 'OPEN', waitingSince: null, closeDueAt: null })
    expect(await f.event('WAIT_ENDED')).toMatchObject([{ actorId: customer.id, oldStatus: 'WAITING', newStatus: 'OPEN' }])
  })

  it('rejects unauthorized and repeated waits, keeps reminders and notes private and preserves multiple sub-minute waits', async () => {
    const f = await setup()
    expect((await f.act('wait', customer.email, { body: 'forbidden' })).status).toBe(403)
    f.at('2026-11-23T04:00:00.123Z')
    expect((await f.wait()).status).toBe(200)
    const waiting = await f.ticket()
    expect((await f.wait()).status).toBe(409)
    expect((await f.act('customer-replies', other.email, { body: 'foreign' })).status).toBe(404)
    expect((await f.act('internal-notes', agent.email, { body: 'PRIVATE lifecycle note' })).status).toBe(201)
    expect((await f.act('public-replies', agent.email, { body: 'Reminder' })).status).toBe(201)
    expect(await f.ticket()).toMatchObject({ waitingSince: waiting.waitingSince, closeDueAt: waiting.closeDueAt })
    expect((await f.resolve()).status).toBe(409)
    expect((await f.read('/' + f.id, customer.email)).text).not.toContain('PRIVATE lifecycle note')
    f.at('2026-11-24T04:00:00.000Z')
    expect((await f.reply()).status).toBe(201)
    f.at('2026-11-24T04:00:00.456Z')
    expect((await f.wait()).status).toBe(200)
    expect(await f.clock()).toMatchObject({ state: 'PAUSED', elapsedMs: 579n })
    expect(await f.event('WAIT_STARTED')).toHaveLength(2)
  })

  it('resumes one millisecond before closure and clears the old cutoff', async () => {
    const f = await setup()
    expect((await f.wait()).status).toBe(200)
    f.at(new Date(+cutoff - 1))
    expect((await f.reply()).status).toBe(201)
    expect(await f.ticket()).toMatchObject({ status: 'OPEN', closeDueAt: null })
    expect(await f.event('AUTO_CLOSED')).toHaveLength(0)
  })

  it('commits closure before rejecting a reply at the exact cutoff', async () => {
    const f = await setup()
    expect((await f.wait()).status).toBe(200)
    f.at(cutoff)
    const rejected = await f.reply()
    expect(rejected.status).toBe(409)
    expect(rejected.body.error.code).toBe('TICKET_CLOSED')
    expect(await f.ticket()).toMatchObject({ status: 'CLOSED', closedAt: cutoff, closeProcessedAt: cutoff })
    expect(await f.clock()).toMatchObject({ state: 'CANCELED', endedAt: cutoff, elapsedMs: 0n, completionOnTime: null })
    expect(await f.event('AUTO_CLOSED')).toMatchObject([{ actorKind: 'SYSTEM', actorId: null, effectiveAt: cutoff }])
    expect((await f.reopen()).body.error.code).toBe('TICKET_CLOSED')
    expect(await runtime.ticketMessage.count({ where: { ticketId: f.id } })).toBe(1)
  })

  it.each([
    ['2026-11-25T12:59:59.999Z', true],
    ['2026-11-25T13:00:00.000Z', true],
    ['2026-11-25T13:00:00.001Z', false],
  ])('records manual resolution at %s with final deadline and exact outcome', async (time, onTime) => {
    const f = await setup()
    expect((await f.resolve()).body.error.code).toBe('FIRST_RESPONSE_REQUIRED')
    f.at(time)
    expect((await f.resolve('This fixes the problem.')).status).toBe(200)
    const clock = await f.clock()
    const due = new Date('2026-11-25T13:00:00.000Z')
    expect(clock).toMatchObject({ state: 'COMPLETED', completedDueAt: due, completionOnTime: onTime,
      firstBreachedAt: onTime ? null : due })
    expect((await f.resolve()).status).toBe(409)
    expect(await f.clock()).toEqual(clock)
  })

  it('serializes concurrent resolution and reopening while preserving both earlier clocks', async () => {
    const f = await setup()
    const results = await Promise.all([f.resolve('Fixed.'), f.resolve('Another resolution')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await f.event('RESOLVED')).toHaveLength(1)
    const old = await f.clock()
    const originalResponse = await f.clock('RESPONSE')
    f.at(new Date(+start + 168 * hours - 1))
    const reopen = await Promise.all([f.reopen(), f.reopen()])
    expect(reopen.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await f.clock()).toMatchObject({ cycle: 2, elapsedMs: 0n, state: 'RUNNING' })
    expect(await runtime.slaClock.findUnique({ where: { id: old.id } })).toEqual(old)
    expect(await f.clock('RESPONSE')).toEqual(originalResponse)
    expect(await f.event('REOPENED')).toHaveLength(1)
  })

  it('rejects reopening at 168 hours without creating a second cycle', async () => {
    const f = await setup()
    expect((await f.resolve('Fixed.')).status).toBe(200)
    f.at(new Date(+start + 168 * hours))
    expect((await f.reopen()).body.error.code).toBe('REOPEN_EXPIRED')
    expect(await f.clock()).toMatchObject({ cycle: 1, state: 'COMPLETED' })
  })

  it('keeps elapsed time and earlier breach on downgrade, then updates a paused budget without resetting waiting', async () => {
    const f = await setup('URGENT')
    f.at('2026-11-23T07:00:00Z')
    expect((await f.act('priority', agent.email, { priority: 'LOW', reason: 'Lower impact' })).status).toBe(200)
    expect(await f.clock('RESPONSE')).toMatchObject({ elapsedMs: 10_800_000n, budgetMs: 32_400_000n,
      firstBreachedAt: new Date('2026-11-23T06:00:00Z') })
    expect(await f.clock()).toMatchObject({ elapsedMs: 10_800_000n, originalBudgetMs: 32_400_000n, budgetMs: 162_000_000n })
    expect((await f.wait()).status).toBe(200)
    const waiting = await f.ticket()
    f.at('2026-11-24T07:00:00Z')
    expect((await f.act('priority', agent.email, { priority: 'MEDIUM', reason: 'More users affected' })).status).toBe(200)
    expect(await f.clock()).toMatchObject({ state: 'PAUSED', elapsedMs: 10_800_000n, budgetMs: 97_200_000n, dueAt: null })
    expect(await f.ticket()).toMatchObject({ waitingSince: waiting.waitingSince, closeDueAt: waiting.closeDueAt })
    expect((await f.act('priority', agent.email, { priority: 'MEDIUM', reason: 'Same priority' })).body.error.code).toBe('PRIORITY_UNCHANGED')
    expect(await f.event('PRIORITY_CHANGED')).toHaveLength(2)
  })

  it('serializes worker/late reply races and records cutoff and processing times independently', async () => {
    const f = await setup()
    expect((await f.wait()).status).toBe(200)
    await reconcileDue(runtime, () => new Date(+cutoff - 1))
    expect((await f.ticket()).status).toBe('WAITING')
    const later = new Date('2026-11-30T04:01:00Z')
    f.at(later)
    const [reply] = await Promise.all([f.reply(), reconcileDue(runtime, () => later), reconcileDue(runtime, () => later)])
    expect(reply.status).toBe(409)
    expect(await f.ticket()).toMatchObject({ status: 'CLOSED', closedAt: cutoff, closeProcessedAt: later })
    expect(await f.event('AUTO_CLOSED')).toMatchObject([{ effectiveAt: cutoff,
      details: { cutoff: cutoff.toISOString(), processedAt: later.toISOString() } }])
    await reconcileDue(runtime, () => later)
    expect(await f.event('AUTO_CLOSED')).toHaveLength(1)
  })

  it('catches up due tickets before queue filtering and refuses unsafe legacy resume', async () => {
    const f = await setup()
    expect((await f.wait()).status).toBe(200)
    f.at(cutoff)
    const q = '&q=' + f.subject
    expect((await f.read('?status=WAITING&limit=1' + q)).body.total).toBe(0)
    const result = await f.read('?status=CLOSED&limit=1' + q)
    expect(result.body.items).toMatchObject([{ status: 'CLOSED', sla: { resolution: { status: 'CANCELED' } } }])
    const legacy = await message(waiting, 'customer-replies', customerCookie)
    expect(legacy.body.error.code).toBe('SLA_HISTORY_UNAVAILABLE')
  })

  it('serializes an open reply against manual resolution and keeps the terminal clock immutable', async () => {
    const f = await setup()
    const [reply, resolution] = await Promise.all([f.reply(), f.resolve('Fixed.')])
    expect(resolution.status).toBe(200)
    expect([201, 409]).toContain(reply.status)
    expect(await f.event('RESOLVED')).toHaveLength(1)
    expect((await f.ticket()).status).toBe('RESOLVED')
    expect((await f.clock()).state).toBe('COMPLETED')
  })

  it('serializes a public reply against waiting without changing the waiting origin', async () => {
    const f = await setup()
    const [waitingResult, publicReply] = await Promise.all([f.wait(), f.act('public-replies', agent.email, { body: 'Reply' })])
    expect(waitingResult.status).toBe(200)
    expect(publicReply.status).toBe(201)
    expect(await f.ticket()).toMatchObject({ status: 'WAITING', waitingSince: start, closeDueAt: cutoff })
    expect(await f.clock('RESPONSE')).toMatchObject({ state: 'COMPLETED', endedAt: start })
    expect(await f.event('WAIT_STARTED')).toHaveLength(1)
  })

  it('serializes priority changes against resolution and first response', async () => {
    const f = await setup()
    f.at('2026-11-23T06:30:00Z')
    const [priority, first] = await Promise.all([
      f.act('priority', agent.email, { priority: 'URGENT', reason: 'Escalation' }),
      f.act('public-replies', agent.email, { body: 'Acknowledged' }),
    ])
    expect(priority.status).toBe(200)
    expect(first.status).toBe(201)
    const response = await f.clock('RESPONSE')
    expect(response).toMatchObject({ state: 'COMPLETED', endedAt: new Date('2026-11-23T06:30:00Z') })
    const [changed, resolved] = await Promise.all([f.act('priority', agent.email, { priority: 'LOW', reason: 'Lower impact' }), f.resolve()])
    expect(resolved.status).toBe(200)
    expect([200, 409]).toContain(changed.status)
    expect(await f.clock('RESPONSE')).toEqual(response)
    expect(await f.event('RESOLVED')).toHaveLength(1)
  })

  it('prioritizes closure over a priority mutation at the cutoff', async () => {
    const f = await setup()
    expect((await f.wait()).status).toBe(200)
    f.at(cutoff)
    const [priority] = await Promise.all([
      f.act('priority', agent.email, { priority: 'LOW', reason: 'Lower impact' }),
      reconcileDue(runtime, () => cutoff),
    ])
    expect(priority.body.error.code).toBe('TICKET_CLOSED')
    expect(await f.ticket()).toMatchObject({ status: 'CLOSED', priority: 'MEDIUM' })
    expect(await f.event('PRIORITY_CHANGED')).toHaveLength(0)
    expect(await f.event('AUTO_CLOSED')).toHaveLength(1)
  })

  it.each(['audit', 'clock'] as const)('rolls back waiting, the reply and all SLA changes when the %s write fails', async (failure) => {
    const f = await setup()
    await owner.ticket.update({ where: { id: f.id }, data: { subject: 'Phase five rollback ' + randomUUID() } })
    const table = failure === 'audit' ? '"AuditEvent"' : '"SlaClock"'
    const condition = failure === 'audit' ? "NEW.action = 'WAIT_STARTED'" : "NEW.state = 'PAUSED'"
    const operation = failure === 'audit' ? 'INSERT' : 'UPDATE'
    const ticket = await f.ticket()
    const resolution = await f.clock()
    const response = await f.clock('RESPONSE')
    try {
      await owner.$executeRawUnsafe(`CREATE FUNCTION phase_five_reject_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} AND EXISTS (SELECT FROM "Ticket" WHERE id = NEW."ticketId" AND subject LIKE 'Phase five rollback %')
        THEN RAISE EXCEPTION 'Simulated lifecycle write failure'; END IF; RETURN NEW; END; $$`)
      await owner.$executeRawUnsafe(`CREATE TRIGGER phase_five_reject_write BEFORE ${operation} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION phase_five_reject_write()`)
      expect((await f.wait()).status).toBe(500)
      expect(await f.ticket()).toEqual(ticket)
      expect(await f.clock()).toEqual(resolution)
      expect(await f.clock('RESPONSE')).toEqual(response)
      expect(await runtime.ticketMessage.count({ where: { ticketId: f.id } })).toBe(0)
      expect(await runtime.auditEvent.count({ where: { ticketId: f.id } })).toBe(0)
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS phase_five_reject_write ON ${table}`)
      await owner.$executeRaw`DROP FUNCTION IF EXISTS phase_five_reject_write()`
    }
  })

  it('reopens a legacy manual resolution without fabricating its unavailable previous cycle', async () => {
    // Use the existing legacy fixture, which has no resolution clock.
    const historical = new Date('2025-01-01T00:00:00.000Z')
    const target = application(() => historical)
    const cookie = cookieOf(await login(target, customer.email).expect(200))
    await request(target).post('/api/tickets/' + resolved + '/reopen').set('Origin', origin).set('Cookie', cookie)
      .send({ body: 'Reopening legacy issue' }).expect(200)
    expect(await runtime.slaClock.findMany({ where: { ticketId: resolved } })).toMatchObject([{ kind: 'RESOLUTION', cycle: 2,
      startedAt: historical, elapsedMs: 0n }])
    expect(await runtime.auditEvent.findFirst({ where: { ticketId: resolved, action: 'REOPENED' } })).toMatchObject({
      details: { previousCycle: null },
    })
  })

  it('starts runtime reconciliation through the actual server entry point after downtime', async () => {
    // These fixed dates are in the past even if the tests are run years later.
    const createdAt = new Date('1971-01-04T04:00:00.000Z')
    const dueAt = new Date('1971-01-08T13:00:00.000Z')
    const stale = await runtime.$transaction(async (tx) => {
      const ticket = await tx.ticket.create({ data: {
        customerId: customer.id, assigneeId: agent.id, calendarId, priority: 'MEDIUM',
        subject: 'Startup ' + randomUUID(), description: 'Startup fixture', createdAt,
        status: 'WAITING', waitingSince: createdAt, closeDueAt: dueAt,
      } })
      const clock = startClock('RESOLUTION', 'MEDIUM', createdAt, businessCalendar())
      await tx.slaClock.create({ data: { ticketId: ticket.id, ...pauseResolution(clock, createdAt, businessCalendar()) } })
      return ticket
    })
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('Test port unavailable.')
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', PORT: String(address.port), DATABASE_URL: process.env.TEST_DATABASE_URL,
      LIFECYCLE_INTERVAL_SECONDS: '60' }
    delete env.MIGRATION_DATABASE_URL
    delete env.TEST_MIGRATION_DATABASE_URL
    delete env.DEV_SEED_PASSWORD
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const done = once(child, 'exit')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup reconciliation timed out.')), 9000)
        child.once('error', () => { clearTimeout(timer); reject(new Error('Startup process failed.')) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Startup process exited early.')) })
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('Lifecycle reconciliation closed')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      expect(await runtime.ticket.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'CLOSED', closedAt: dueAt, closeProcessedAt: expect.any(Date),
      })
      const events = await runtime.auditEvent.findMany({ where: { ticketId: stale.id, action: 'AUTO_CLOSED' } })
      expect(events).toHaveLength(1)
      expect(events[0].effectiveAt).toEqual(dueAt)
      expect(events[0].recordedAt.getTime()).toBeGreaterThan(+dueAt)
    } finally {
      child.kill()
      await done
    }
  }, 13_000)

  it('batches closure work with a caller-supplied bound', async () => {
    const begin = new Date('1970-01-05T04:00:00.000Z')
    const due = new Date('1970-01-09T13:00:00.000Z')
    const fixtures = []
    for (let i = 0; i < 2; i++) {
      fixtures.push(await runtime.ticket.create({ data: {
        customerId: customer.id, assigneeId: agent.id, calendarId, priority: 'MEDIUM',
        subject: 'Bounded ' + randomUUID(), description: 'Bounded closure fixture', createdAt: begin,
        status: 'WAITING', waitingSince: begin, closeDueAt: due,
      } }))
    }
    expect((await reconcileDue(runtime, () => due, 1)).closed).toBe(1)
    expect(await runtime.ticket.count({ where: { id: { in: fixtures.map((f) => f.id) }, status: 'WAITING' } })).toBe(1)
    expect((await reconcileDue(runtime, () => due, 1)).closed).toBe(1)
    expect((await reconcileDue(runtime, () => due, 1)).closed).toBe(0)
    expect(await runtime.auditEvent.count({ where: { ticketId: { in: fixtures.map((f) => f.id) }, action: 'AUTO_CLOSED' } })).toBe(2)
  })
})
