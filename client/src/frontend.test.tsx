import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { api, ApiError, writeErrorText } from './api'
import { queueQuery, screen } from './navigation'
import { Conversation, Timing } from './Workspace'
import type { Clock } from './contracts'

afterEach(() => vi.unstubAllGlobals())

const id = 'fbe7aef0-0a49-4e8a-9b70-c83403dd1d63'
const created = '2026-11-23T04:00:00.000Z'

describe('protected routes and paginated queue queries', () => {
  it('recognizes deep links only within the authenticated role', () => {
    expect(screen('/agent/tickets/' + id, 'AGENT')).toEqual({ name: 'detail', id })
    expect(screen('/agent/tickets/' + id, 'CUSTOMER')).toEqual({ name: 'missing' })
    expect(screen('/customer/tickets/new', 'AGENT')).toEqual({ name: 'missing' })
    expect(screen('/customer/tickets/new', 'CUSTOMER')).toEqual({ name: 'new' })
  })

  it('sends staff filters, search and page to the server', () => {
    const filters = queueQuery('?q=%20export%20&scope=unassigned&status=WAITING&priority=URGENT&sla=historical&page=2', true)
    expect(Object.fromEntries(filters)).toEqual({ q: 'export', scope: 'unassigned', status: 'WAITING', priority: 'URGENT', sla: 'historical', page: '2' })
  })

  it('drops staff filters, unknown keys and blank search for customers', () => {
    expect(queueQuery('?scope=mine&assigneeId=X&sla=overdue&q=%20%20&status=OPEN&includeInternal=true', false).toString()).toBe('status=OPEN')
  })
})

describe('same-origin API requests', () => {
  it('directs ambiguous writes to an authoritative check and preserves explicit conflicts', () => {
    const check = 'Refresh the ticket'
    expect(writeErrorText(new ApiError(0, 'NETWORK', 'Offline'), check))
      .toBe('Frontdesk could not confirm this change. Refresh the ticket before trying again.')
    expect(writeErrorText(new ApiError(503, 'UNAVAILABLE', 'Unavailable'), check))
      .toContain('could not confirm')
    expect(writeErrorText(new ApiError(409, 'TICKET_CLOSED', 'This ticket is closed.'), check))
      .toBe('This ticket is closed.')
  })
  it('sends an empty claim body as JSON with browser session cookies', async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ id }))
    vi.stubGlobal('fetch', transport)
    await expect(api('/tickets/' + id + '/claim', { method: 'POST', body: {} })).resolves.toEqual({ id })
    expect(transport).toHaveBeenCalledWith('/api/tickets/' + id + '/claim', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}',
    }))
  })

  it('accepts a 204 logout response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('invalidates only on a protected 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Response.json({ error: { code: 'INVALID_CREDENTIALS' } }, { status: 401 })))
    await expect(api('/auth/login', { method: 'POST' })).rejects.toMatchObject({ message: 'Email or password is incorrect.' })
    const clear = vi.fn()
    await expect(api('/tickets', {}, clear)).rejects.toMatchObject({ status: 401 })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('surfaces a claim conflict without retrying the write', async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ error: { code: 'TICKET_ALREADY_CLAIMED' } }, { status: 409 }))
    vi.stubGlobal('fetch', transport)
    await expect(api('/tickets/' + id + '/claim', { method: 'POST' })).rejects.toMatchObject({ status: 409, code: 'TICKET_ALREADY_CLAIMED' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable and network conditions without raw diagnostics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'internal' } }, { status: 503 }))
      .mockRejectedValueOnce(new Error('internal')))
    await expect(api('/tickets')).rejects.toMatchObject({ status: 503, message: 'Frontdesk is temporarily unavailable. Please try again.' })
    await expect(api('/tickets')).rejects.toMatchObject({ status: 0, code: 'NETWORK' })
  })
})

describe('conversation and timing presentation', () => {
  it('renders arbitrary message markup as text and distinguishes staff notes', () => {
    const body = '<img data-canary src=x>\nSecond line'
    const markup = renderToStaticMarkup(<Conversation description={body} createdAt={created} messages={[
      { id, kind: 'INTERNAL', body, createdAt: created, author: { displayName: 'Agent' } },
    ]} />)
    expect(markup).not.toContain('<img')
    expect(markup).toContain('&lt;img')
    expect(markup).toContain('Staff only')
    expect(markup).toContain('Second line')
  })

  const clock: Clock = { cycle: 2, status: 'PAUSED', deadline: null, completedAt: null, firstBreachedAt: created,
    remainingMs: 5_400_000, consumedMs: 90_000, overdueWorkingMs: 0 }

  it('shows paused working time and breach history separately', () => {
    const markup = renderToStaticMarkup(<Timing title="Resolution" clock={clock} />)
    expect(markup).toContain('Paused')
    expect(markup).toContain('1 hr 30 min working time remaining')
    expect(markup).toContain('Historical breach')
    expect(markup).not.toContain('Deadline')
  })

  it('shows an explicit unavailable state for legacy clocks', () => {
    const markup = renderToStaticMarkup(<Timing title="Resolution" clock={null} />)
    expect(markup).toContain('Timing history unavailable')
    expect(markup).not.toContain('0 min')
  })

  it('labels a completed late clock and its effective deadline in IST', () => {
    const markup = renderToStaticMarkup(<Timing title="Resolution" clock={{ ...clock, status: 'COMPLETED_LATE', deadline: created, completedAt: created }} />)
    expect(markup).toContain('Completed late')
    expect(markup).toContain('IST')
    expect(markup).toContain('Historical breach')
  })
})
