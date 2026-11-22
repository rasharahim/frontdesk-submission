import { loadLocalEnv, isLocalDatabase } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import { initializeClocks } from '../src/sla/persistence.js'
import { ticketLifecycle } from '../src/tickets/lifecycle.js'

const scenarios = [
  { id: '40000000-0000-4000-8000-000000000051', subject: 'Lifecycle demo: awaiting an export sample',
    event: 'WAIT_STARTED', command: { action: 'wait', body: 'Could you share a sample export with synthetic data?' } },
  { id: '40000000-0000-4000-8000-000000000052', subject: 'Lifecycle demo: resolved export settings',
    event: 'RESOLVED', command: { action: 'resolve', body: 'The export settings are fixed. Please try again.' } },
] as const

async function run() {
  loadLocalEnv()
  loadLocalEnv('.env.migrate')
  const ownerUrl = process.env.MIGRATION_DATABASE_URL
  const runtimeUrl = process.env.DATABASE_URL
  if (process.env.NODE_ENV !== 'development' || !ownerUrl || !runtimeUrl ||
      !isLocalDatabase(ownerUrl, 'frontdesk_dev', 'owner') || !isLocalDatabase(runtimeUrl, 'frontdesk_dev', 'runtime')) {
    throw new Error('Development database required.')
  }
  const owner = createDatabase(ownerUrl)
  const runtime = createDatabase(runtimeUrl)
  try {
    for (const [db, expected] of [[owner, 'frontdesk_dev_owner'], [runtime, 'frontdesk_dev_runtime']] as const) {
      const [actual] = await db.$queryRaw<{ db: string; role: string; timezone: string }[]>`
        SELECT current_database() AS db, current_user AS role, current_setting('TimeZone') AS timezone
      `
      if (actual?.db !== 'frontdesk_dev' || actual.role !== expected || actual.timezone !== 'UTC') throw new Error('Wrong database.')
    }
    const agent = await owner.user.findUniqueOrThrow({ where: { email: 'dev.agent@example.test' },
      select: { id: true, displayName: true, role: true } })
    let added = 0
    let transitioned = 0
    for (const scenario of scenarios) {
      const created = await owner.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(2472052)`
        const existing = await tx.ticket.findUnique({ where: { id: scenario.id }, select: { id: true } })
        if (existing) return false
        const customer = await tx.user.findUniqueOrThrow({ where: { email: 'omar.customer@example.test' }, select: { id: true } })
        const calendar = await tx.holidayCalendar.findFirstOrThrow({ where: { publishedAt: { not: null } },
          orderBy: { version: 'desc' }, select: { id: true, holidays: { select: { date: true } } } })
        const at = new Date()
        const ticket = await tx.ticket.create({ data: { id: scenario.id, customerId: customer.id, assigneeId: agent.id,
          calendarId: calendar.id, priority: 'MEDIUM', subject: scenario.subject, description: 'Synthetic lifecycle walkthrough.',
          createdAt: at, updatedAt: at } })
        await initializeClocks(tx, ticket, calendar.holidays)
        await tx.auditEvent.create({ data: { ticketId: ticket.id, actorKind: 'SYSTEM', action: 'CREATED',
          effectiveAt: at, newStatus: 'OPEN', details: { source: 'development_lifecycle_demo' } } })
        return true
      })
      if (created) added++
      const initialized = await runtime.auditEvent.findFirst({ where: { ticketId: scenario.id, action: scenario.event }, select: { id: true } })
      if (!initialized) {
        await ticketLifecycle(runtime, () => new Date()).mutate(agent, scenario.id, scenario.command)
        transitioned++
      }
    }
    console.info(JSON.stringify({ added, transitioned }))
  } finally {
    await Promise.all([runtime.$disconnect(), owner.$disconnect()])
  }
}

run().catch(() => {
  console.error('Lifecycle demo initialization failed. Check local seed accounts and database configuration.')
  process.exitCode = 1
})
