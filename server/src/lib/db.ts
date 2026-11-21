import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

export function createDatabase(url: string) {
  const adapter = new PrismaPg({ connectionString: url, connectionTimeoutMillis: 5000 })
  return new PrismaClient({ adapter })
}
