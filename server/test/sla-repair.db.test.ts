import { randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { isLocalDatabase, loadLocalEnv } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import { repairDeadlines, type DeadlineEvidence } from '../src/sla/repair.js'
import type { PrismaClient } from '../src/generated/prisma/client.js'

const origin = 'https://frontdesk.example.test'
const start = new Date('2026-11-20T14:31:41.804Z')
const factualReply = new Date('2026-11-20T15:31:41.804Z')
const correct = new Date('2026-11-23T06:00:00.000Z')
const shifted = new Date('2026-11-23T00:30:00.000Z')
const password = randomBytes(24).toString('base64url')
let runtime: PrismaClient
let owner: PrismaClient
let customer: { id: string; email: string }
let agent: { id: string; email: string }
let calendarId: string

beforeAll(async () => {
  loadLocalEnv('.env.test')
  loadLocalEnv('.env.migrate')
  const runtimeUrl = process.env.TEST_DATABASE_URL
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL
  if (!runtimeUrl || !ownerUrl || !isLocalDatabase(runtimeUrl, 'frontdesk_test', 'runtime') ||
      !isLocalDatabase(ownerUrl, 'frontdesk_test', 'owner')) throw new Error('Isolated repair test connections required.')
  runtime = createDatabase(runtimeUrl)
  owner = createDatabase(ownerUrl)
  for (const [db, role] of [[runtime, 'frontdesk_test_runtime'], [owner, 'frontdesk_test_owner']] as const) {
    const [actual] = await db.$queryRaw<unknown[]>`SELECT current_database() AS db, current_user AS role,
      session_user AS login, current_setting('TimeZone') AS timezone`
    expect(actual).toEqual({ db: 'frontdesk_test', role, login: role, timezone: 'UTC' })
  }
  const hash = await bcrypt.hash(password, 4)
  customer = await owner.user.create({ data: { email: randomUUID() + '@example.test', displayName: 'Repair Customer', role: 'CUSTOMER', passwordHash: hash } })
  agent = await owner.user.create({ data: { email: randomUUID() + '@example.test', displayName: 'Repair Agent', role: 'AGENT', passwordHash: hash } })
  calendarId = await owner.$transaction(async (tx) => {
    const calendar = await tx.holidayCalendar.upsert({ where: { version: 1 }, create: { version: 1 }, update: {} })
    if (!calendar.publishedAt) await tx.holidayCalendar.update({
      where: { id: calendar.id }, data: { publishedAt: new Date(Math.max(Date.now(), +calendar.createdAt)) },
    })
    return calendar.id
  })
})
afterAll(async () => { await Promise.all([runtime?.$disconnect(), owner?.$disconnect()]) })

async function shiftedFixture(terminal = false, affectedOutcome = false) {
  const subject = 'SLA repair ' + randomUUID()
  const completion = affectedOutcome ? new Date('2026-11-23T05:00:00.000Z') : factualReply
  const ticket = await owner.ticket.create({ data: {
    customerId: customer.id, assigneeId: agent.id, calendarId, priority: 'URGENT', createdAt: start,
    subject, description: 'Isolated repair fixture', status: terminal ? 'RESOLVED' : 'OPEN',
    resolvedAt: terminal ? completion : null,
  } })
  if (terminal) await owner.ticketMessage.create({ data: {
    ticketId: ticket.id, kind: 'AGENT_PUBLIC', authorId: agent.id, body: 'Factual fixture reply', createdAt: completion,
  } })
  const clock = await owner.slaClock.create({ data: {
    ticketId: ticket.id, kind: 'RESPONSE', state: terminal ? 'COMPLETED' : 'RUNNING', cycle: 1, startedAt: start,
    budgetMs: 7_200_000n, originalBudgetMs: 7_200_000n, elapsedMs: affectedOutcome ? 3_600_000n : 0n,
    dueAt: terminal ? null : shifted, activeSince: terminal ? null : start, endedAt: terminal ? completion : null,
    completedDueAt: terminal ? shifted : null, completionOnTime: terminal ? !affectedOutcome : null,
  } })
  const evidence: DeadlineEvidence = { clockId: clock.id, reference: ticket.reference, kind: clock.kind, cycle: 1,
    field: terminal ? 'COMPLETED_DUE_AT' : 'RUNNING_DUE_AT', originalDeadline: shifted, expectedDeadline: correct }
  return { ticket, clock, evidence, subject }
}

function reader() {
  let now = new Date('2026-11-23T05:00:00.000Z')
  const app = createApp({
    checkDatabase: () => runtime.$queryRaw`SELECT 1`,
    api: { db: runtime, now: () => now, settings: { cookieName: 'repair_session', ttlHours: 8, secure: true, origins: [origin] } },
  })
  return {
    setTime: (value: string) => { now = new Date(value) },
    async authenticated(email: string) {
      const login = await request(app).post('/api/auth/login').set('Origin', origin).send({ email, password }).expect(200)
      const cookie = login.headers['set-cookie'][0].split(';')[0]
      return (path: string) => request(app).get('/api/tickets' + path).set('Cookie', cookie).expect(200)
    },
  }
}

const current = (id: string) => runtime.slaClock.findUniqueOrThrow({ where: { id } })
const correction = (id: string) => runtime.slaDeadlineCorrection.findUnique({ where: { clockId: id } })

describe('controlled SLA deadline correction', () => {
  it('repairs the active deadline, preserves unrelated rows and filters before pagination at the corrected instant', async () => {
    const f = await shiftedFixture()
    const unrelated = await shiftedFixture()
    const target = reader()
    const read = await target.authenticated(agent.email)
    const list = () => read('?sla=overdue&limit=1&q=' + f.subject)
    expect((await list()).body.total).toBe(1)
    expect(await repairDeadlines(owner, [f.evidence])).toEqual({ corrections: 1, runningUpdates: 1 })
    expect(await current(f.clock.id)).toEqual({ ...f.clock, dueAt: correct })
    const recorded = await correction(f.clock.id)
    expect(recorded).toMatchObject({ originalDeadline: shifted, correctedDeadline: correct, correctedBy: 'frontdesk_test_owner',
      field: 'RUNNING_DUE_AT', reason: expect.any(String), correctedAt: expect.any(Date) })
    expect((await list()).body.total).toBe(0)
    target.setTime('2026-11-23T06:00:00.000Z')
    expect((await list()).body.total).toBe(0)
    target.setTime('2026-11-23T06:00:00.001Z')
    expect((await list()).body).toMatchObject({ total: 1, items: [
      { sla: { response: { status: 'OVERDUE', deadline: correct.toISOString(), overdueWorkingMs: 1 } } },
    ] })
    expect(await repairDeadlines(owner, [f.evidence])).toEqual({ corrections: 0, runningUpdates: 0 })
    expect(await correction(f.clock.id)).toEqual(recorded)
    expect(await current(unrelated.clock.id)).toEqual(unrelated.clock)
    expect(await correction(unrelated.clock.id)).toBeNull()
    expect(await runtime.auditEvent.count({ where: { ticketId: f.ticket.id } })).toBe(0)
  })

  it('overlays the corrected completed deadline without changing the stored completed clock or outcome', async () => {
    const f = await shiftedFixture(true)
    expect(await repairDeadlines(owner, [f.evidence])).toEqual({ corrections: 1, runningUpdates: 0 })
    expect(await current(f.clock.id)).toEqual(f.clock)
    const target = reader()
    const staff = await target.authenticated(agent.email)
    const owned = await target.authenticated(customer.email)
    expect((await staff('/' + f.ticket.id)).body.sla).toMatchObject({ response: {
      status: 'COMPLETED_ON_TIME', deadline: correct.toISOString(), completedAt: factualReply.toISOString(), firstBreachedAt: null,
    }, resolution: null })
    expect((await staff('?q=' + f.subject)).body.items[0].sla.response.deadline).toBe(correct.toISOString())
    expect((await owned('/' + f.ticket.id)).body).not.toHaveProperty('sla')
    await expect(runtime.slaClock.update({ where: { id: f.clock.id }, data: { completedDueAt: correct } })).rejects.toThrow()
  })

  it('validates exact clock identity and rolls back the whole batch when the second target is wrong', async () => {
    const fixtures = [await shiftedFixture(), await shiftedFixture()].sort((a, b) => a.evidence.reference.localeCompare(b.evidence.reference))
    await expect(repairDeadlines(owner, [fixtures[0].evidence, { ...fixtures[1].evidence, kind: 'RESOLUTION' }])).rejects.toThrow(/evidence/)
    for (const f of fixtures) {
      expect(await current(f.clock.id)).toEqual(f.clock)
      expect(await correction(f.clock.id)).toBeNull()
    }
  })

  it('rejects deadlines that do not match independent calendar reconstruction', async () => {
    const f = await shiftedFixture()
    await expect(repairDeadlines(owner, [{ ...f.evidence,
      originalDeadline: new Date(+shifted + 1), expectedDeadline: new Date(+correct + 1),
    }])).rejects.toThrow(/evidence/)
    expect(await current(f.clock.id)).toEqual(f.clock)
    expect(await correction(f.clock.id)).toBeNull()
  })

  it('rejects repairs that would change a completed outcome', async () => {
    const f = await shiftedFixture(true, true)
    await expect(repairDeadlines(owner, [f.evidence])).rejects.toThrow(/evidence/)
    expect(await current(f.clock.id)).toEqual(f.clock)
    expect(await correction(f.clock.id)).toBeNull()
  })

  it('denies runtime inserts and enforces correction immutability for both roles', async () => {
    const f = await shiftedFixture()
    await expect(repairDeadlines(runtime, [f.evidence])).rejects.toThrow()
    expect(await current(f.clock.id)).toEqual(f.clock)
    expect(await correction(f.clock.id)).toBeNull()
    await repairDeadlines(owner, [f.evidence])
    for (const sql of ['UPDATE "SlaDeadlineCorrection" SET reason = reason', 'DELETE FROM "SlaDeadlineCorrection"', 'TRUNCATE "SlaDeadlineCorrection"']) {
      for (const [db, code] of [[runtime, '42501'], [owner, '55000']] as const) {
        await expect(db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(sql)
          throw new Error('Unexpected mutation authorization.')
        })).rejects.toMatchObject({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: code } } } })
      }
    }
  })

  it('pins writes to UTC and returns the same physical timestamp under different SQL timezones', async () => {
    const configured = new URL(process.env.TEST_DATABASE_URL!)
    configured.searchParams.set('options', '-c timezone=Asia/Calcutta')
    const pinned = createDatabase(configured.toString())
    try {
      const [session] = await pinned.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`
      expect(session.zone).toBe('UTC')
      const f = await shiftedFixture()
      await repairDeadlines(owner, [f.evidence])
      for (const zone of ['Asia/Calcutta', 'America/New_York']) {
        const actual = await pinned.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`
          const [row] = await tx.$queryRaw<{ epoch: string; type: string; zone: string }[]>`
            SELECT (extract(epoch FROM "dueAt")*1000)::bigint::text AS epoch,
              pg_typeof("dueAt")::text AS type, current_setting('TimeZone') AS zone
            FROM "SlaClock" WHERE id = ${f.clock.id}::uuid
          `
          return row
        })
        expect(actual).toEqual({ epoch: correct.getTime().toString(), type: 'timestamp with time zone', zone })
      }
    } finally { await pinned.$disconnect() }
  })
})
