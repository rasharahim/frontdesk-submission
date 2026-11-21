import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

export function createDatabase(url: string) {
  // Prisma's PostgreSQL adapter treats unqualified timestamp values as UTC.
  // Pin the session timezone explicitly to preserve their absolute instants.
  const connection = new URL(url)
  const existing = connection.searchParams.get('options')
  connection.searchParams.set('options', [existing, '-c timezone=UTC'].filter(Boolean).join(' '))
  const adapter = new PrismaPg({ connectionString: connection.toString(), connectionTimeoutMillis: 5000 })
  return new PrismaClient({ adapter })
}
