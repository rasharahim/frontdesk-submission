import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const envFile = fileURLToPath(new URL('../../.env.migrate', import.meta.url))
const config = fileURLToPath(new URL('../prisma.config.ts', import.meta.url))
const mode = process.argv[2]
if (mode?.startsWith('migrate-') && existsSync(envFile)) process.loadEnvFile(envFile)
let args
const env = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' }
if (mode === 'validate' || mode === 'generate') {
  args = [mode]
} else if (mode === 'migrate-dev' || mode === 'migrate-test') {
  const test = mode === 'migrate-test'
  const key = test ? 'TEST_MIGRATION_DATABASE_URL' : 'MIGRATION_DATABASE_URL'
  const database = test ? 'frontdesk_test' : 'frontdesk_dev'
  try {
    const url = new URL(env[key] ?? '')
    if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/' + database || url.username !== database + '_owner' ||
        !url.password || url.search || url.hash) throw new Error()
    env.DATABASE_URL = url.href
  } catch {
    console.error(key + ' must point to the local ' + database + ' database using its owner role and password.')
    process.exit(1)
  }
  args = ['migrate', 'deploy']
} else {
  console.error('Unknown Prisma task.')
  process.exit(1)
}

const packagePath = require.resolve('prisma/package.json')
const { bin } = JSON.parse(readFileSync(packagePath, 'utf8'))
const cli = resolve(dirname(packagePath), bin.prisma)
const child = spawnSync(process.execPath, [cli, ...args, '--config', config], {
  env,
  stdio: 'inherit',
})
process.exitCode = child.status ?? 1
