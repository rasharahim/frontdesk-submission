import { loadLocalEnv, isLocalDatabase } from '../src/config/env.js'
import { createDatabase } from '../src/lib/db.js'
import { backfillClocks } from '../src/sla/persistence.js'

async function run() {
  loadLocalEnv()
  const url = process.env.DATABASE_URL
  if (process.env.NODE_ENV !== 'development' || !url || !isLocalDatabase(url, 'frontdesk_dev', 'runtime')) {
    throw new Error('Local development runtime connection required.')
  }
  const db = createDatabase(url)
  try {
    const [identity] = await db.$queryRaw<{ db: string; role: string; timezone: string }[]>`SELECT current_database() AS db, current_user AS role, current_setting('TimeZone') AS timezone`
    if (identity?.db !== 'frontdesk_dev' || identity.role !== 'frontdesk_dev_runtime' || identity.timezone !== 'UTC') throw new Error('Unexpected database identity.')
    console.info(JSON.stringify(await backfillClocks(db)))
  } finally {
    await db.$disconnect()
  }
}

run().catch(() => {
  console.error('SLA backfill failed. Check the development runtime connection and migrations.')
  process.exitCode = 1
})
