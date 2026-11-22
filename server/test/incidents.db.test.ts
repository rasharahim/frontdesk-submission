import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as poll } from 'node:timers/promises'
import bcrypt from 'bcrypt'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { isLocalDatabase, loadLocalEnv } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import type { PrismaClient } from '../src/generated/prisma/client.js'
import { reconcileDue } from '../src/tickets/reconciliation.js'

const origin = 'http://127.0.0.1'
const initial = new Date('2026-11-23T04:00:00.000Z')
const password = randomBytes(24).toString('base64url')
const labels = ['claim-a-' + randomUUID(), 'claim-b-' + randomUUID()]
let runtime: PrismaClient
let otherRuntime: PrismaClient
let owner: PrismaClient
let users: { id: string; email: string }[]
let now = initial

function app(db: PrismaClient) {
  return createApp({ checkDatabase: () => db.$queryRaw`SELECT 1`,
    api: { db, now: () => now, settings: { cookieName: 'incident_session', ttlHours: 8, secure: false, origins: [origin] } } })
}
let appA: ReturnType<typeof app>
let appB: ReturnType<typeof app>
let cookies: string[]

async function signIn(which: number) {
  const target = which === 3 ? appB : appA
  const r = await request(target).post('/api/auth/login').set('Origin', origin)
    .send({ email: users[which].email, password }).expect(200)
  return r.headers['set-cookie'][0].split(';')[0] as string
}

function http(method: 'get' | 'post' | 'patch', path: string, index?: number) {
  const target = index === 3 ? appB : appA
  const call = request(target)[method]('/api' + path).set('Origin', origin)
  return index === undefined ? call : call.set('Cookie', cookies[index])
}

async function ticket(subject = 'Incident ' + randomUUID()) {
  const result = await http('post', '/tickets', 0).send({ subject, body: 'Synthetic request', priority: 'MEDIUM' }).expect(201)
  return result.body.id as string
}
const target = (id: string, suffix = '') => '/tickets/' + id + suffix
const clocks = (id: string) => runtime.slaClock.findMany({ where: { ticketId: id }, orderBy: { id: 'asc' } })
const evidence = (id: string) => runtime.auditEvent.findMany({ where: { ticketId: id }, orderBy: { id: 'asc' } })
const claim = (id: string, index?: number) => http('post', target(id, '/claim'), index)

beforeAll(async () => {
  loadLocalEnv('.env.test')
  loadLocalEnv('.env.migrate')
  const runtimeUrl = process.env.TEST_DATABASE_URL
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL
  if (!runtimeUrl || !ownerUrl || !isLocalDatabase(runtimeUrl, 'frontdesk_test', 'runtime') ||
      !isLocalDatabase(ownerUrl, 'frontdesk_test', 'owner')) throw new Error('Isolated incident test connections required.')
  const url = new URL(runtimeUrl)
  url.searchParams.set('application_name', labels[0])
  runtime = createDatabase(url.toString())
  url.searchParams.set('application_name', labels[1])
  otherRuntime = createDatabase(url.toString())
  owner = createDatabase(ownerUrl)
  for (const [db, role] of [[runtime, 'frontdesk_test_runtime'], [otherRuntime, 'frontdesk_test_runtime'], [owner, 'frontdesk_test_owner']] as const) {
    const [actual] = await db.$queryRaw<unknown[]>`SELECT current_database() AS db, current_user AS role,
      session_user AS login, current_setting('TimeZone') AS timezone`
    expect(actual).toEqual({ db: 'frontdesk_test', role, login: role, timezone: 'UTC' })
  }
  const hash = await bcrypt.hash(password, 4)
  users = []
  for (const role of ['CUSTOMER', 'CUSTOMER', 'AGENT', 'AGENT'] as const) {
    users.push(await owner.user.create({ data: { role, email: randomUUID() + '@example.test',
      displayName: 'Incident Fixture', passwordHash: hash }, select: { id: true, email: true } }))
  }
  const existing = await owner.holidayCalendar.findFirst({ where: { publishedAt: { not: null } }, select: { id: true } })
  if (!existing) {
    const row = await owner.holidayCalendar.create({ data: { version: 100 } })
    await owner.holidayCalendar.update({ where: { id: row.id }, data: { publishedAt: new Date(Math.max(Date.now(), +row.createdAt)) } })
  }
  appA = app(runtime)
  appB = app(otherRuntime)
  cookies = await Promise.all(users.map((_u, index) => signIn(index)))
}, 15_000)

afterAll(async () => { await Promise.all([runtime?.$disconnect(), otherRuntime?.$disconnect(), owner?.$disconnect()]) })

describe('INC-0291 atomic claims', () => {
  it('assigns only the session actor, preserves SLA and refuses same-agent repeats and theft', async () => {
    const id = await ticket()
    const previous = await runtime.ticket.findUniqueOrThrow({ where: { id } })
    const original = await clocks(id)
    await claim(id, 2).send({ assigneeId: users[3].id }).expect(400)
    await claim(id, 2).send({ actorId: users[3].id, effectiveAt: '2001-01-01T00:00:00Z', status: 'CLOSED' }).expect(400)
    const result = await claim(id, 2).send({}).expect(200)
    expect(result.body).toMatchObject({ id, status: 'OPEN', assignee: { id: users[2].id } })
    expect(result.body).not.toHaveProperty('customerId')
    const first = await runtime.ticket.findUniqueOrThrow({ where: { id } })
    expect(first).toEqual({ ...previous, assigneeId: users[2].id, updatedAt: now })
    for (const contender of [2, 3]) {
      const r = await claim(id, contender).expect(409)
      expect(r.body.error.code).toBe('TICKET_ALREADY_CLAIMED')
    }
    expect(await clocks(id)).toEqual(original)
    expect(await runtime.ticketMessage.count({ where: { ticketId: id } })).toBe(0)
    const events = await evidence(id)
    expect(events.map((e) => e.action)).toEqual(['CREATED', 'CLAIMED'])
    expect(events[1]).toMatchObject({ actorKind: 'USER', actorId: users[2].id, ticketId: id,
      effectiveAt: now, oldStatus: 'OPEN', newStatus: 'OPEN', details: { previousAssigneeId: null, assigneeId: users[2].id } })
  })

  it('rejects unauthorized and nonexistent requests and refuses ineligible states', async () => {
    const id = await ticket()
    await claim(id).expect(401)
    await claim(id, 0).expect(403)
    await claim(randomUUID(), 2).expect(404)
    await claim(id, 2).expect(200)
    await http('post', target(id, '/wait'), 2).send({ body: 'Need details' }).expect(200)
    const denied = await claim(id, 3).expect(409)
    expect(denied.body.error.code).toBe('TICKET_STATE_CONFLICT')
    expect((await evidence(id)).filter((e) => e.action === 'CLAIMED')).toHaveLength(1)
  })

  it('rolls back assignment when the claim audit insert fails', async () => {
    const id = await ticket('Phase six claim rollback ' + randomUUID())
    const before = await runtime.ticket.findUniqueOrThrow({ where: { id } })
    try {
      await owner.$executeRaw`CREATE FUNCTION phase_six_reject_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action = 'CLAIMED' AND EXISTS (SELECT FROM "Ticket" WHERE id = NEW."ticketId"
        AND subject LIKE 'Phase six claim rollback %') THEN RAISE EXCEPTION 'Simulated audit failure'; END IF;
        RETURN NEW; END; $$`
      await owner.$executeRaw`CREATE TRIGGER phase_six_reject_claim BEFORE INSERT ON "AuditEvent"
        FOR EACH ROW EXECUTE FUNCTION phase_six_reject_claim()`
      await claim(id, 2).expect(500)
      expect(await runtime.ticket.findUniqueOrThrow({ where: { id } })).toEqual(before)
      expect((await evidence(id)).map((e) => e.action)).toEqual(['CREATED'])
    } finally {
      await owner.$executeRaw`DROP TRIGGER IF EXISTS phase_six_reject_claim ON "AuditEvent"`
      await owner.$executeRaw`DROP FUNCTION IF EXISTS phase_six_reject_claim()`
    }
  })

  it.each([1, 2, 3, 4, 5])('contends in PostgreSQL across independent apps, trial %i', async () => {
    const id = await ticket()
    const before = await clocks(id)
    let contenders: Promise<request.Response[]> | undefined
    await runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${id}::uuid FOR UPDATE`
      contenders = Promise.all([claim(id, 2), claim(id, 3)])
      // Observe the actual lock queues before releasing the independent fixture lock.
      const until = Date.now() + 2500
      while (Date.now() < until) {
        const rows = await tx.$queryRaw<{ application_name: string }[]>`
          SELECT application_name FROM pg_stat_activity
          WHERE application_name IN (${labels[0]}, ${labels[1]}) AND wait_event_type = 'Lock'
            AND query LIKE '%FOR UPDATE%'`
        if (new Set(rows.map((row) => row.application_name)).size === 2) return
        await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
        await poll(15)
      }
      throw new Error('Both claim transactions did not reach the PostgreSQL lock barrier.')
    }, { timeout: 4500 })
    const results = await contenders!
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const winner = results[0].status === 200 ? 2 : 3
    const loser = winner === 2 ? 3 : 2
    expect(results[loser - 2].body.error.code).toBe('TICKET_ALREADY_CLAIMED')
    expect((await runtime.ticket.findUniqueOrThrow({ where: { id } })).assigneeId).toBe(users[winner].id)
    expect((await evidence(id)).filter((e) => e.action === 'CLAIMED')).toMatchObject([{ actorId: users[winner].id }])
    expect(await clocks(id)).toEqual(before)
    await http('post', target(id, '/public-replies'), loser).send({ body: 'Stale write' }).expect(403)
    await http('post', target(id, '/public-replies'), winner).send({ body: 'Assigned write' }).expect(201)
  })

  it('serializes a customer reply and a claim without changing ownership or clocks', async () => {
    const id = await ticket()
    const before = await clocks(id)
    const [assigned, reply] = await Promise.all([
      claim(id, 2),
      http('post', target(id, '/customer-replies'), 0).send({ body: 'Public update during claim' }),
    ])
    expect(assigned.status).toBe(200)
    expect(reply.status).toBe(201)
    expect(await runtime.ticket.findUnique({ where: { id } })).toMatchObject({
      customerId: users[0].id, assigneeId: users[2].id, status: 'OPEN',
    })
    expect(await clocks(id)).toEqual(before)
    expect((await evidence(id)).filter((row) => row.action === 'CLAIMED')).toHaveLength(1)
  })

  it('allows a distinct ticket claim to commit while another ticket is locked', async () => {
    const claimedLater = await ticket()
    const unrelated = await ticket()
    let pending: Promise<request.Response> | undefined
    await runtime.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${claimedLater}::uuid FOR UPDATE`
      pending = claim(claimedLater, 2).then((r) => r)
      await claim(unrelated, 3).timeout({ deadline: 2000 }).expect(200)
    })
    expect((await pending!).status).toBe(200)
  })
})

describe('INC-0304 private note isolation', () => {
  it('keeps the canary, note ID, and note activity out of every implemented customer ticket response', async () => {
    const canary = 'private-' + randomUUID() + ' " <tag> & \\'
    const id = await ticket()
    await claim(id, 2).expect(200)
    const beforePublic = await http('post', target(id, '/public-replies'), 2).send({ body: 'Before note' }).expect(201)
    const before = await runtime.ticket.findUniqueOrThrow({ where: { id } })
    const oldClocks = await clocks(id)
    const beforeList = await http('get', '/tickets?limit=50', 0).expect(200)
    const note = await http('post', target(id, '/internal-notes'), 2).send({ body: canary }).expect(201)
    expect(await runtime.ticket.findUniqueOrThrow({ where: { id } })).toEqual(before)
    expect(await clocks(id)).toEqual(oldClocks)
    expect((await http('get', '/tickets?limit=50', 0).expect(200)).body).toEqual(beforeList.body)
    const staff = await http('get', target(id), 2).expect(200)
    expect(staff.body.messages).toContainEqual(expect.objectContaining({ body: canary, kind: 'INTERNAL' }))
    const afterPublic = await http('post', target(id, '/public-replies'), 2).send({ body: 'After note' }).expect(201)
    const owned = await http('get', target(id), 0).expect(200)
    expect(owned.body.messages.map((m: { id: string }) => m.id).sort()).toEqual([beforePublic.body.id, afterPublic.body.id].sort())
    const responses = [owned, await http('get', '/tickets', 0).expect(200),
      await http('post', target(id, '/customer-replies'), 0).send({ body: 'Customer reply' }).expect(201),
      await http('get', target(id), 1).expect(404),
      await http('get', target(id)).expect(401),
      await http('get', target(id, '/audit'), 0).expect(403),
      await http('get', '/auth/me', 0).expect(200),
      await http('get', '/health', 0).expect(200),
      await http('get', '/ready', 0).expect(200),
      await http('get', target(id, '?includeInternal=true'), 0).expect(400),
      await http('post', target(id, '/internal-notes'), 0).send({ body: canary }).expect(403),
    ]
    for (const kind of ['INTERNAL', 'AGENT_PUBLIC']) {
      responses.push(await http('post', target(id, '/customer-replies'), 0).send({ body: canary, kind }).expect(400))
    }
    const htmlEscaped = canary.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    for (const value of [canary, encodeURIComponent(canary), JSON.stringify(canary), htmlEscaped]) {
      const search = await http('get', '/tickets?q=' + encodeURIComponent(value), 0).expect(200)
      expect(search.body.total).toBe(0)
      responses.push(search)
    }
    await http('post', target(id, '/resolve'), 2).send({}).expect(200)
    const followUp = await http('post', '/tickets', 0).send({ subject: 'Follow-up', body: 'Public', priority: 'LOW', sourceTicketId: id }).expect(201)
    responses.push(followUp, await http('post', target(id, '/reopen'), 0).send({ body: 'Public reopen' }).expect(200))
    for (const r of responses) {
      expect(r.text).not.toContain(canary.slice(0, 44))
      expect(r.text).not.toContain(note.body.id)
    }
    const recorded = (await evidence(id)).find((e) => e.action === 'PRIVATE_NOTE')
    expect(recorded).toMatchObject({ actorId: users[2].id, effectiveAt: now, details: { messageId: note.body.id } })
    expect(recorded?.details).toEqual({ messageId: note.body.id })
  })
})

describe('INC-0318 audit evidence', () => {
  it('retrieves bounded ID-ordered history with safe metadata and rejects unauthorized access', async () => {
    const id = await ticket()
    await claim(id, 2).expect(200)
    await http('post', target(id, '/wait'), 2).send({ body: 'Request' }).expect(200)
    await http('post', target(id, '/customer-replies'), 0).send({ body: 'Reply' }).expect(201)
    await http('patch', target(id, '/priority'), 2).send({ priority: 'LOW', reason: 'Private operational context' }).expect(200)
    await http('post', target(id, '/resolve'), 2).send({}).expect(200)
    await http('post', target(id, '/reopen'), 0).send({ body: 'Reopening' }).expect(200)
    const persisted = await evidence(id)
    expect(persisted.map((e) => e.action)).toEqual([
      'CREATED','CLAIMED','PUBLIC_REPLY','WAIT_STARTED','CUSTOMER_REPLY','WAIT_ENDED','PRIORITY_CHANGED','RESOLVED','CUSTOMER_REPLY','REOPENED',
    ])
    for (const [i, row] of persisted.entries()) {
      expect(row.ticketId).toBe(id)
      expect(row.effectiveAt).toEqual(now)
      expect(row.actorId).toBe(users[[0, 4, 5, 8, 9].includes(i) ? 0 : 2].id)
      expect(row.actorKind).toBe('USER')
    }
    const faultMarker = 'only-raw-' + randomUUID()
    await runtime.auditEvent.create({ data: { ticketId: id, actorKind: 'USER', actorId: users[2].id,
      action: 'PRIVATE_NOTE', effectiveAt: now, details: { messageId: randomUUID(), body: faultMarker } } })
    const page1 = await http('get', target(id, '/audit?limit=3'), 3).expect(200)
    const all = await http('get', target(id, '/audit'), 3).expect(200)
    const rest = await http('get', target(id, '/audit?afterId=' + page1.body.nextAfterId), 3).expect(200)
    expect(page1.body.items).toHaveLength(3)
    expect([...page1.body.items, ...rest.body.items]).toEqual(all.body.items)
    expect(rest.body.nextAfterId).toBeNull()
    expect(all.body.items.slice(0, -1).map((e: { id: string }) => e.id)).toEqual(persisted.map((e) => e.id.toString()))
    expect(all.body.items[6].details).toMatchObject({ oldPriority: 'MEDIUM', priority: 'LOW' })
    expect(all.body.items[9]).toMatchObject({ actor: { kind: 'USER', id: users[0].id }, oldStatus: 'RESOLVED',
      newStatus: 'OPEN', details: { resolution: { cycle: 2 } } })
    expect(all.text).not.toContain(faultMarker)
    expect(all.text).not.toContain('Private operational context')
    await http('get', target(id, '/audit'), 0).expect(403)
    await http('get', target(id, '/audit'), 1).expect(403)
    await http('get', target(id, '/audit')).expect(401)
    await http('get', target(randomUUID(), '/audit'), 2).expect(404)
    for (const q of ['limit=101', 'limit=0', 'afterId=-1', 'afterId=9223372036854775808', 'raw=true']) {
      await http('get', target(id, '/audit?' + q), 2).expect(400)
    }
  })

  it('attributes request-time automatic closure to the system with effective and processing timestamps', async () => {
    const id = await ticket()
    await claim(id, 2).expect(200)
    const wait = await http('post', target(id, '/wait'), 2).send({ body: 'Confirmation?' }).expect(200)
    const cutoff = new Date(wait.body.closeDueAt)
    try {
      now = new Date(+cutoff + 1000)
      cookies[2] = await signIn(2)
      for (let i = 0; i < 2; i++) {
        const audit = await http('get', target(id, '/audit'), 2).expect(200)
        expect(audit.body.items.filter((e: { action: string }) => e.action === 'AUTO_CLOSED')).toMatchObject([{
          actor: { kind: 'SYSTEM', id: null }, effectiveAt: cutoff.toISOString(), oldStatus: 'WAITING',
          newStatus: 'CLOSED', details: { cutoff: cutoff.toISOString(), processedAt: now.toISOString() },
        }])
      }
      await reconcileDue(runtime, () => now)
      expect((await evidence(id)).filter((e) => e.action === 'AUTO_CLOSED')).toHaveLength(1)
    } finally {
      now = initial
      cookies[2] = await signIn(2)
    }
  })

  it('rejects audit protection bypasses using actual restricted role and leaves history unchanged', async () => {
    const id = await ticket()
    const before = await evidence(id)
    for (const statement of [
      'ALTER TABLE "AuditEvent" OWNER TO frontdesk_test_runtime',
      'SET LOCAL ROLE frontdesk_test_owner',
      "SET LOCAL session_replication_role = 'replica'",
    ]) {
      await expect(runtime.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(statement)
        throw new Error('Restricted operation unexpectedly allowed.')
      })).rejects.toMatchObject({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '42501' } } } })
    }
    expect(await evidence(id)).toEqual(before)
  })
})
