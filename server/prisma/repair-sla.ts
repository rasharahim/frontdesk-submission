import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { loadLocalEnv, isLocalDatabase } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import { repairDeadlines, type DeadlineEvidence } from '../src/sla/repair.js'

const manifest = z.object({
  format: z.literal(1),
  database: z.literal('frontdesk_dev'),
  validation: z.array(z.object({
    clock_id: z.uuid(), reference: z.string(), kind: z.enum(['RESPONSE', 'RESOLUTION']),
    state: z.enum(['RUNNING', 'COMPLETED']), cycle: z.literal(1), dueAt: z.iso.datetime().nullable(),
    completedDueAt: z.iso.datetime().nullable(), expected: z.iso.datetime(),
  })).length(6),
})

let stage = 'configuration'

async function run() {
  loadLocalEnv()
  loadLocalEnv('.env.migrate')
  const url = process.env.MIGRATION_DATABASE_URL
  if (process.env.NODE_ENV !== 'development' || !url || !isLocalDatabase(url, 'frontdesk_dev', 'owner') || process.argv.length !== 3) {
    throw new Error('Specify the local development evidence file with development owner credentials.')
  }
  stage = 'evidence validation'
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { validation } = manifest.parse(JSON.parse(readFileSync(resolve(root, process.argv[2]), 'utf8')))
  const scope = validation.map(({ reference, kind, state }) => [reference, kind, state].join(':')).sort()
  const allowed = ['FD-1:RESPONSE:RUNNING', 'FD-1:RESOLUTION:RUNNING', 'FD-2:RESPONSE:RUNNING',
    'FD-2:RESOLUTION:RUNNING', 'FD-3:RESPONSE:COMPLETED', 'FD-4:RESPONSE:COMPLETED']
  if (scope.join(',') !== allowed.sort().join(',')) throw new Error('Evidence is outside the authorized development scope.')
  const evidence: DeadlineEvidence[] = validation.map((item) => {
    const running = item.state === 'RUNNING'
    const deadline = running ? item.dueAt : item.completedDueAt
    if (!deadline) throw new Error('Evidence is missing the original deadline.')
    return { clockId: item.clock_id, reference: item.reference, kind: item.kind, cycle: item.cycle,
      field: running ? 'RUNNING_DUE_AT' : 'COMPLETED_DUE_AT', originalDeadline: new Date(deadline),
      expectedDeadline: new Date(item.expected) }
  })
  stage = 'database identity'
  const db = createDatabase(url)
  try {
    const [identity] = await db.$queryRaw<{ db: string; role: string; timezone: string }[]>`
      SELECT current_database() AS db, current_user AS role, current_setting('TimeZone') AS timezone
    `
    if (identity?.db !== 'frontdesk_dev' || identity.role !== 'frontdesk_dev_owner' || identity.timezone !== 'UTC') {
      throw new Error('Unexpected database identity or timezone.')
    }
    stage = 'repair transaction'
    console.info(JSON.stringify(await repairDeadlines(db, evidence)))
  } finally {
    await db.$disconnect()
  }
}

run().catch(() => {
  console.error('SLA repair rejected during ' + stage + '. Check the evidence and database configuration.')
  process.exitCode = 1
})
