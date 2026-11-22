import bcrypt from 'bcrypt'
import { loadLocalEnv, isLocalDatabase } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'

const users = [
  { displayName: 'Anika Demo', email: 'anika.agent@example.test', role: 'AGENT' },
  { displayName: 'Dev Demo', email: 'dev.agent@example.test', role: 'AGENT' },
  { displayName: 'Leena Demo', email: 'leena.customer@example.test', role: 'CUSTOMER' },
  { displayName: 'Omar Demo', email: 'omar.customer@example.test', role: 'CUSTOMER' },
] as const

async function seed() {
  loadLocalEnv()
  loadLocalEnv('.env.migrate')
  const url = process.env.MIGRATION_DATABASE_URL
  const password = process.env.DEV_SEED_PASSWORD
  if (process.env.NODE_ENV !== 'development' || !url || !isLocalDatabase(url, 'frontdesk_dev', 'owner')) {
    throw new Error('Seed requires NODE_ENV=development and the local development owner URL.')
  }
  if (!password || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set DEV_SEED_PASSWORD to a separate password of 12–72 UTF-8 bytes.')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const db = createDatabase(url)
  try {
    const [identity] = await db.$queryRaw<{ db: string; role: string; timezone: string }[]>`
      SELECT current_database() AS db, current_user AS role, current_setting('TimeZone') AS timezone
    `
    if (identity?.db !== 'frontdesk_dev' || identity.role !== 'frontdesk_dev_owner' || identity.timezone !== 'UTC') {
      throw new Error('Unexpected seed database identity or timezone.')
    }
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(2472002)`
      const accounts = await Promise.all(users.map((user) => tx.user.upsert({
        where: { email: user.email },
        update: {},
        create: { ...user, passwordHash },
        select: { id: true, role: true },
      })))
      if (accounts.some((account, index) => account.role !== users[index].role)) {
        throw new Error('An existing demo identity uses an unexpected role.')
      }

      let calendar = await tx.holidayCalendar.findUnique({ where: { version: 1 } })
      if (!calendar) {
        calendar = await tx.holidayCalendar.create({
          data: { version: 1, holidays: { create: [{ date: new Date('2026-12-25T00:00:00Z'), label: 'Example festival holiday' }] } },
        })
      }
      if (!calendar.publishedAt) {
        calendar = await tx.holidayCalendar.update({
          where: { id: calendar.id }, data: { publishedAt: new Date() },
        })
      }

      const [anika, dev, leena, omar] = accounts
      const createdAt = new Date('2026-11-20T04:00:00.000Z')
      const yesterdayReply = new Date(createdAt.getTime() + 3_600_000)
      const fixtures = [
        { customerId: leena.id, priority: 'URGENT', subject: 'Export blocks closing reports', description: 'Export stops before it saves a file.', status: 'OPEN' },
        { customerId: omar.id, assigneeId: dev.id, priority: 'LOW', subject: 'Add a saved filter', description: 'Could we save the filter for the weekly review?', status: 'OPEN' },
        { customerId: leena.id, assigneeId: anika.id, priority: 'MEDIUM', subject: 'Invoice totals look different', description: 'The invoice and report show different totals.', status: 'WAITING', waitingSince: yesterdayReply,
          messages: { create: [
            { kind: 'AGENT_PUBLIC', authorId: anika.id, body: 'Could you share the report date range?', createdAt: yesterdayReply },
            { kind: 'INTERNAL', authorId: anika.id, body: 'Compare the demo report and invoice date ranges.', createdAt: yesterdayReply },
          ] } },
        { customerId: omar.id, assigneeId: dev.id, priority: 'LOW', subject: 'Update weekly report label', description: 'The weekly report label uses the previous project name.', status: 'RESOLVED', resolvedAt: yesterdayReply,
          messages: { create: [
            { kind: 'CUSTOMER_PUBLIC', authorId: omar.id, body: 'I confirmed the label in the reports tab.', createdAt },
            { kind: 'AGENT_PUBLIC', authorId: dev.id, body: 'The report label has been updated.', createdAt: yesterdayReply },
          ] } },
      ] as const

      for (const [index, fixture] of fixtures.entries()) {
        const id = '40000000-0000-4000-8000-00000000000' + (index + 1)
        if (await tx.ticket.findUnique({ where: { id }, select: { id: true } })) continue
        const { messages, ...fields } = 'messages' in fixture ? fixture : { ...fixture, messages: undefined }
        await tx.ticket.create({
          data: {
            ...fields, id, calendarId: calendar.id, createdAt,
            messages: messages && { create: [...messages.create] },
          },
        })
      }
    })
    console.info('Development seed ready: two agents, two customers and four synthetic tickets.')
  } finally {
    await db.$disconnect()
  }
}

seed().catch((error: unknown) => {
  const message = error instanceof Error && /^(Seed requires|Set DEV_SEED_PASSWORD|An existing demo)/.test(error.message)
    ? error.message : 'Development seed failed. Check local owner credentials and applied migrations.'
  console.error(message)
  process.exitCode = 1
})
