import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { isLocalDatabase, loadLocalEnv } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'

const rollback = new Error('Roll back test fixture')
const fixtureEmail = 'database-fixture@example.test'

function pgError(sqlState: string) {
  return { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: sqlState } } } }
}
let db: PrismaClient
let owner: PrismaClient
let customerId: string
let calendarId: string

async function isolated<T>(client: PrismaClient, run: (tx: Prisma.TransactionClient) => Promise<T>) {
  await expect(client.$transaction(async (tx) => {
    await run(tx)
    throw rollback
  })).rejects.toBe(rollback)
}

function makeTicket(tx: Prisma.TransactionClient, customer = customerId) {
  return tx.ticket.create({
    data: { customerId: customer, calendarId, subject: 'Test ticket', description: 'Test request', priority: 'MEDIUM' },
  })
}

async function appendEvent(tx: Prisma.TransactionClient, ticketId: string) {
  return tx.auditEvent.create({
    data: { ticketId, actorKind: 'SYSTEM', action: 'CREATED', effectiveAt: new Date() },
  })
}

async function assertIdentity(client: PrismaClient, role: string) {
  const [identity] = await client.$queryRaw<Array<{ database: string; actor: string; login: string }>>`
    SELECT current_database() AS database, current_user AS actor, session_user AS login
  `
  expect(identity).toEqual({ database: 'frontdesk_test', actor: role, login: role })
}

beforeAll(async () => {
  loadLocalEnv('.env.test')
  loadLocalEnv('.env.migrate')
  const runtimeUrl = process.env.TEST_DATABASE_URL
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL
  if (!runtimeUrl || !ownerUrl || !isLocalDatabase(runtimeUrl, 'frontdesk_test', 'runtime') ||
      !isLocalDatabase(ownerUrl, 'frontdesk_test', 'owner')) {
    throw new Error('Set the isolated local frontdesk_test runtime and owner URLs before running integration tests.')
  }
  db = createDatabase(runtimeUrl)
  owner = createDatabase(ownerUrl)
  await assertIdentity(db, 'frontdesk_test_runtime')
  await assertIdentity(owner, 'frontdesk_test_owner')
  await owner.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: fixtureEmail }, update: {},
      create: { email: fixtureEmail, role: 'CUSTOMER', displayName: 'Database Fixture', passwordHash: '!disabled', disabledAt: new Date() },
      select: { id: true },
    })
    customerId = user.id
    const calendar = await tx.holidayCalendar.upsert({
      where: { version: 1 }, update: {}, create: { version: 1 },
    })
    calendarId = calendar.id
    if (!calendar.publishedAt) {
      await tx.holidayCalendar.update({ where: { id: calendarId }, data: { publishedAt: new Date() } })
    }
  })
}, 15_000)

afterAll(async () => {
  await Promise.all([db?.$disconnect(), owner?.$disconnect()])
})

describe('PostgreSQL foundation', () => {
  it('applies both migrations in the isolated database', async () => {
    const rows = await owner.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
    `
    expect(rows.map((row) => row.migration_name)).toEqual(expect.arrayContaining([
      '20261122000000_init', '20261122000100_integrity',
    ]))
  })

  it('connects and returns readiness through the runtime role', async () => {
    const app = createApp({ checkDatabase: () => db.$queryRaw`SELECT 1` })
    const result = await request(app).get('/api/ready').expect(200)
    expect(result.body).toEqual({ status: 'ready' })
  })

  it('restricts database role privileges and ownership', async () => {
    const [privileges] = await db.$queryRaw<Record<string, boolean>[]>`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
        has_schema_privilege(current_user, 'public', 'CREATE') AS create_schema_objects,
        has_database_privilege(current_user, current_database(), 'CREATE') AS create_schemas,
        pg_has_role(current_user, 'frontdesk_test_owner', 'MEMBER') AS owner_member,
        pg_has_role(current_user, 'frontdesk_dev_runtime', 'MEMBER') AS dev_role_member,
        has_database_privilege(current_user, 'frontdesk_dev', 'CONNECT') AS connects_to_dev,
        pg_get_userbyid(relowner) = current_user AS owns_audit
      FROM pg_roles CROSS JOIN pg_class WHERE rolname = current_user
        AND pg_class.oid = 'public."AuditEvent"'::regclass
    `
    expect(privileges).toBeDefined()
    expect(Object.values(privileges).every((value) => value === false)).toBe(true)
  })

  it('generates references and inserts/reads database-timestamped events as runtime', async () => {
    await isolated(db, async (tx) => {
      const ticket = await makeTicket(tx)
      expect(ticket.reference).toMatch(/^FD-[1-9][0-9]*$/)
      const event = await appendEvent(tx, ticket.id)
      expect(event.recordedAt).toBeInstanceOf(Date)
      await expect(tx.auditEvent.findUnique({ where: { id: event.id } })).resolves.toMatchObject({
        ticketId: ticket.id, actorKind: 'SYSTEM', action: 'CREATED',
      })
    })
  })

  it('rejects duplicate emails', async () => {
    await expect(owner.user.create({
      data: { email: fixtureEmail, role: 'CUSTOMER', displayName: 'Duplicate Fixture', passwordHash: '!disabled', disabledAt: new Date() },
    })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('enforces ticket customer foreign keys', async () => {
    await expect(makeTicket(db, randomUUID())).rejects.toMatchObject({ code: 'P2003' })
  })

  it('enforces ticket lifecycle checks', async () => {
    await expect(db.$executeRaw`
      INSERT INTO "Ticket" ("customerId", "calendarId", subject, description, status, priority, "updatedAt")
      VALUES (${customerId}::uuid, ${calendarId}::uuid, 'Test', 'Test', 'WAITING', 'MEDIUM', now())
    `).rejects.toMatchObject(pgError('23514'))
  })

  it('enforces budgets, cycle identity and unique active clocks', async () => {
    const clock = (ticketId: string, cycle = 1) => ({
      ticketId, kind: 'RESOLUTION' as const, cycle, state: 'RUNNING' as const, originalBudgetMs: 10n,
      budgetMs: 10n, startedAt: new Date(), activeSince: new Date(), dueAt: new Date(),
    })
    for (const { cycle, budget } of [{ cycle: 0, budget: 10n }, { cycle: 1, budget: -10n }]) {
      await expect(db.$transaction(async (tx) => {
        const ticket = await makeTicket(tx)
        await tx.$executeRaw`
          INSERT INTO "SlaClock" ("ticketId", kind, cycle, state, "originalBudgetMs",
            "budgetMs", "startedAt", "activeSince", "dueAt")
          VALUES (${ticket.id}::uuid, 'RESOLUTION', ${cycle}::integer, 'RUNNING', 10, ${budget}, now(), now(), now())
        `
        throw rollback
      })).rejects.toMatchObject(pgError('23514'))
    }
    for (const secondCycle of [1, 2]) {
      await expect(db.$transaction(async (tx) => {
        const ticket = await makeTicket(tx)
        await tx.slaClock.create({ data: clock(ticket.id) })
        await tx.slaClock.create({ data: clock(ticket.id, secondCycle) })
        throw rollback
      })).rejects.toMatchObject({ code: 'P2002' })
    }
  })

  it('preserves historical SLA outcomes and breach timestamps', async () => {
    for (const state of ['RUNNING', 'COMPLETED'] as const) {
      await expect(db.$transaction(async (tx) => {
        const ticket = await makeTicket(tx)
        const now = new Date()
        const clock = await tx.slaClock.create({
          data: { ticketId: ticket.id, kind: 'RESOLUTION', cycle: 1, state, originalBudgetMs: 10n, budgetMs: 10n,
            startedAt: now, firstBreachedAt: now,
            ...(state === 'RUNNING' ? { activeSince: now, dueAt: now } : { endedAt: now }) },
        })
        await tx.$executeRaw`UPDATE "SlaClock" SET "firstBreachedAt" = NULL WHERE id = ${clock.id}::uuid`
        throw rollback
      })).rejects.toMatchObject(pgError('55000'))
    }
  })

  it('rejects edits to a published holiday calendar', async () => {
    await expect(owner.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "HolidayCalendar" SET "publishedAt" = NULL WHERE id = ${calendarId}::uuid`
      throw rollback
    })).rejects.toMatchObject(pgError('55000'))
  })

  it('installs indexes for claims, public history and active clocks', async () => {
    const names = await db.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    expect(names.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'ticket_unassigned_open', 'message_public_history', 'sla_one_active_per_kind',
    ]))
  })

  const auditWrites = [
    ['update', 'UPDATE "AuditEvent" SET details = details'],
    ['delete', 'DELETE FROM "AuditEvent"'],
    ['truncate', 'TRUNCATE "AuditEvent"'],
  ] as const

  it.each(auditWrites)('rejects audit %s via runtime grants', async (_action, statement) => {
    await expect(db.$transaction(async (tx) => {
      const ticket = await makeTicket(tx)
      await appendEvent(tx, ticket.id)
      await tx.$executeRawUnsafe(statement)
      throw rollback
    })).rejects.toMatchObject(pgError('42501'))
  })

  it.each(auditWrites)('rejects audit %s via owner-side statement trigger', async (_action, statement) => {
    await expect(owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(statement)
      throw rollback
    })).rejects.toMatchObject(pgError('55000'))
  })

  it('denies changing the audit table to the runtime role', async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "AuditEvent" ADD COLUMN test_column integer`
      throw rollback
    })).rejects.toMatchObject(pgError('42501'))
  })

  it('denies disabling the protection trigger to the runtime role', async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "AuditEvent" DISABLE TRIGGER "audit_no_update_or_delete"`
      throw rollback
    })).rejects.toMatchObject(pgError('42501'))
  })
})
