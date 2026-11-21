import { randomUUID } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import helmet from 'helmet'

type Options = {
  checkDatabase: () => Promise<unknown>
  logRequests?: boolean
  trustProxy?: boolean
  staticDir?: string
}

export function createApp({ checkDatabase, logRequests, trustProxy, staticDir }: Options) {
  const app = express()
  app.disable('x-powered-by')
  if (trustProxy) app.set('trust proxy', 1)
  app.use(helmet({ strictTransportSecurity: staticDir ? undefined : false }))
  app.use((req, res, next) => {
    const requestId = randomUUID()
    res.set('X-Request-Id', requestId)
    if (logRequests) res.on('finish', () => console.info(req.method, res.statusCode, requestId))
    next()
  })
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use('/api', express.json({ limit: '32kb' }))
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'frontdesk' }))
  app.get('/api/ready', async (_req, res) => {
    try {
      await checkDatabase()
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable.' } })
    }
  })
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  if (staticDir) {
    app.use(express.static(staticDir))
    app.get(/^(?!.*\.[^/]+$).*/, (req, res, next) => {
      if (!req.accepts('html')) return next()
      res.sendFile('index.html', { root: staticDir })
    })
  }
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error)
    const type = error instanceof Error && 'type' in error ? error.type : undefined
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON.' } })
    } else if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' } })
    } else if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Unsupported request encoding.' } })
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } })
    }
  }
  app.use(handleError)
  return app
}
