import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { parseEnv } from '../src/config/env.js'

const validUrl = 'postgresql://frontdesk_dev_runtime:validation-only@127.0.0.1/frontdesk_dev'

describe('application foundation', () => {
  it('returns health without calling the database and sets safe headers', async () => {
    const checkDatabase = vi.fn()
    const result = await request(createApp({ checkDatabase })).get('/api/health').expect(200)
    expect(result.body).toEqual({ status: 'ok', service: 'frontdesk' })
    expect(result.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.headers['cache-control']).toBe('no-store')
    expect(checkDatabase).not.toHaveBeenCalled()
  })

  it('returns a sanitized readiness failure', async () => {
    const checkDatabase = vi.fn().mockRejectedValue(new Error('raw connection details'))
    const result = await request(createApp({ checkDatabase })).get('/api/ready').expect(503)
    expect(result.body).toEqual({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable.' } })
    expect(checkDatabase).toHaveBeenCalledOnce()
  })

  it('returns a JSON error for unknown API routes', async () => {
    const result = await request(createApp({ checkDatabase: async () => {} })).get('/api/missing').expect(404)
    expect(result.body.error.code).toBe('NOT_FOUND')
  })

  it('handles malformed JSON without echoing the request', async () => {
    const result = await request(createApp({ checkDatabase: async () => {} }))
      .post('/api/missing').type('json').send('{"private-body"').expect(400)
    expect(result.body).toEqual({ error: { code: 'INVALID_JSON', message: 'Malformed JSON.' } })
  })

  it('limits JSON request size', async () => {
    const result = await request(createApp({ checkDatabase: async () => {} }))
      .post('/api/missing').send({ value: 'x'.repeat(33000) }).expect(413)
    expect(result.body.error.code).toBe('BODY_TOO_LARGE')
  })

  it('uses safe defaults with a development runtime URL', () => {
    const config = parseEnv({ DATABASE_URL: validUrl })
    expect(config).toMatchObject({ PORT: 3000, BUSINESS_TIMEZONE: 'Asia/Kolkata', TRUST_PROXY: false })
  })

  it('reports invalid keys without reflecting values', () => {
    expect(() => parseEnv({ PORT: '70000', DATABASE_URL: 'sensitive-invalid-value' }))
      .toThrow('Missing or invalid configuration: PORT, DATABASE_URL.')
    expect(() => parseEnv({})).toThrow('DATABASE_URL')
    expect(() => parseEnv({ DATABASE_URL: validUrl.replace('_runtime', '_owner') })).toThrow('DATABASE_URL')
  })
  it('requires an exact HTTPS application origin in production', () => {
    const production = { NODE_ENV: 'production', DATABASE_URL: validUrl }
    for (const APP_ORIGIN of [undefined, 'http://example.test', 'https://example.test/path', 'https://example.test/']) {
      expect(() => parseEnv({ ...production, APP_ORIGIN })).toThrow('APP_ORIGIN')
    }
    expect(parseEnv({ ...production, APP_ORIGIN: 'https://example.test' }).APP_ORIGIN).toBe('https://example.test')
  })

})
