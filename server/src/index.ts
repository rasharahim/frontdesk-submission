import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { loadLocalEnv, parseEnv } from './config/env.js'
import { createDatabase } from './lib/db.js'

import { reconcileDue } from './tickets/reconciliation.js'
import { startScheduler } from './tickets/scheduler.js'

function start() {
  const production = process.env.NODE_ENV === 'production'
  if (!production) loadLocalEnv()
  const config = parseEnv(process.env)
  const db = createDatabase(config.DATABASE_URL)
  const app = createApp({
    api: { db, settings: {
      cookieName: config.SESSION_COOKIE_NAME, ttlHours: config.SESSION_TTL_HOURS,
      secure: config.NODE_ENV === 'production',
      origins: config.APP_ORIGIN ? [config.APP_ORIGIN] : [
        'http://127.0.0.1:5173', 'http://localhost:5173',
        'http://127.0.0.1:' + config.PORT, 'http://localhost:' + config.PORT,
      ],
    } },
    checkDatabase: () => db.$queryRaw`SELECT 1`,
    logRequests: config.NODE_ENV === 'development',
    trustProxy: config.TRUST_PROXY,
    staticDir: config.NODE_ENV === 'production'
      ? fileURLToPath(new URL('../../client/dist', import.meta.url))
      : undefined,
  })
  const host = config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'
  let stopScheduler: (() => Promise<void>) | undefined
  const server = app.listen(config.PORT, host, () => {
    console.info('Frontdesk listening on ' + host + ':' + config.PORT)
    stopScheduler = startScheduler(() => reconcileDue(db, () => new Date()),
      config.LIFECYCLE_INTERVAL_SECONDS * 1000, console.info)
  })
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('Server could not listen (' + (error.code ?? 'unknown') + ').')
    process.exitCode = 1
  })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    const schedulerStopped = stopScheduler?.()
    server.close(() => { void Promise.resolve(schedulerStopped).finally(() => db.$disconnect()) })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

try {
  start()
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('Missing or invalid configuration:')
    ? error.message
    : 'Frontdesk could not start. Check the local configuration.')
  process.exitCode = 1
}
