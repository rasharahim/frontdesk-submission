import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export function loadLocalEnv(name: '.env' | '.env.test' | '.env.migrate' = '.env') {
  const path = fileURLToPath(new URL('../../../' + name, import.meta.url))
  if (existsSync(path)) process.loadEnvFile(path)
}

const databaseUrl = z.url().refine((raw) => {
  try {
    const url = new URL(raw)
    const user = decodeURIComponent(url.username).toLowerCase()
    return ['postgresql:', 'postgres:'].includes(url.protocol) &&
      !!user && !!url.password && url.pathname.length > 1 &&
      user !== 'postgres' && !user.endsWith('_owner')
  } catch {
    return false
  }
}, 'Use a PostgreSQL URL for a restricted runtime role.')

const environment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: databaseUrl,
  BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata').refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return true
    } catch {
      return false
    }
  }),
  SESSION_COOKIE_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('frontdesk_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
}).superRefine((values, ctx) => {
  if (values.NODE_ENV === 'development' && !isLocalDatabase(values.DATABASE_URL, 'frontdesk_dev', 'runtime')) {
    ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Use the local development runtime role.' })
  }
})

export function isLocalDatabase(raw: string | undefined, database: 'frontdesk_dev' | 'frontdesk_test', role: 'runtime' | 'owner') {
  try {
    if (!raw) return false
    const url = new URL(raw)
    return ['postgresql:', 'postgres:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname === '/' + database && url.username === database + '_' + role &&
      !!url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export function parseEnv(raw: NodeJS.ProcessEnv) {
  const result = environment.safeParse(raw)
  if (!result.success) {
    const invalidKeys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))]
    throw new Error('Missing or invalid configuration: ' + invalidKeys.join(', ') + '. See .env.example.')
  }
  return result.data
}
