import { afterEach, describe, expect, it, vi } from 'vitest'
import { businessCalendar } from '../src/sla/calendar.js'
import { closureDeadline, closureDue, reopenEligible, requireTransition } from '../src/tickets/lifecycle-policy.js'
import { startScheduler } from '../src/tickets/scheduler.js'

const mon = new Date('2026-11-23T04:00:00.000Z')

describe('lifecycle policy', () => {
  it('allows only the authorized state and role pairs', () => {
    expect(requireTransition('wait', 'OPEN', 'AGENT')).toBe('WAITING')
    expect(requireTransition('customerReply', 'WAITING', 'CUSTOMER')).toBe('OPEN')
    expect(requireTransition('note', 'WAITING', 'AGENT')).toBe('WAITING')
    expect(requireTransition('publicReply', 'WAITING', 'AGENT')).toBe('WAITING')
    expect(requireTransition('resolve', 'OPEN', 'AGENT')).toBe('RESOLVED')
    expect(requireTransition('reopen', 'RESOLVED', 'CUSTOMER')).toBe('OPEN')
    expect(requireTransition('close', 'WAITING', 'SYSTEM')).toBe('CLOSED')
    expect(() => requireTransition('wait', 'OPEN', 'CUSTOMER')).toThrow()
    for (const action of ['resolve', 'wait'] as const) expect(() => requireTransition(action, 'WAITING', 'AGENT')).toThrow()
    expect(() => requireTransition('reopen', 'CLOSED', 'CUSTOMER')).toThrow()
  })

  it('closes at the exact fifth working-day cutoff and skips holidays and weekends', () => {
    const due = closureDeadline(mon, businessCalendar())
    expect(due.toISOString()).toBe('2026-11-27T13:00:00.000Z')
    expect(closureDue(due, new Date(+due - 1))).toBe(false)
    expect(closureDue(due, due)).toBe(true)
    expect(closureDue(due, new Date(+due + 1))).toBe(true)
    expect(closureDue(null, due)).toBe(false)
    expect(closureDeadline(mon, businessCalendar(['2026-11-24'])).toISOString()).toBe('2026-11-30T13:00:00.000Z')
  })

  it('reopens strictly within 168 elapsed hours', () => {
    const resolution = new Date('2026-11-23T06:30:00.000Z')
    const expiry = +resolution + 168 * 3_600_000
    expect(reopenEligible(resolution, new Date(expiry - 1))).toBe(true)
    expect(reopenEligible(resolution, new Date(expiry))).toBe(false)
    expect(reopenEligible(resolution, new Date(expiry + 1))).toBe(false)
    expect(reopenEligible(resolution, new Date(+resolution - 1))).toBe(false)
  })
})

describe('scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('runs immediately, prevents overlap and waits for in-flight work on shutdown', async () => {
    vi.useFakeTimers()
    let finish!: (value: { closed: number; checked: number }) => void
    const run = vi.fn(() => new Promise<{ closed: number; checked: number }>((resolve) => { finish = resolve }))
    const stop = startScheduler(run, 60_000, vi.fn())
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run).toHaveBeenCalledTimes(1)
    const stopped = stop()
    finish({ closed: 1, checked: 0 })
    await stopped
    await vi.advanceTimersByTimeAsync(180_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries after a rejected database batch and leaves no timer after shutdown', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockRejectedValueOnce(new Error('test outage')).mockResolvedValue({ closed: 0, checked: 0 })
    const log = vi.fn()
    const stop = startScheduler(run, 60_000, log)
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retry'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    await stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a scheduler when the Express app module is imported', async () => {
    vi.useFakeTimers()
    const { createApp } = await import('../src/app.js')
    createApp({ checkDatabase: async () => {} })
    expect(vi.getTimerCount()).toBe(0)
  })
})
