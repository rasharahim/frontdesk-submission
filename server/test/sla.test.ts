import { afterAll, describe, expect, it } from 'vitest'
import { businessCalendar, MINUTE_MS } from '../src/sla/calendar.js'
import { changeBudget, complete, evaluate, nextResolution, pauseResolution, resumeResolution, startClock } from '../src/sla/clock.js'

const local = (date: string, time = '09:30:00.000') => new Date(date + 'T' + time + '+05:30')
const minutes = (n: number) => n * MINUTE_MS
const regular = businessCalendar()
const monday = local('2026-11-23')
const at = (time: string) => local('2026-11-23', time)

describe('business calendar', () => {
  it.each([
    ['normal working day', '2026-11-23', '09:30:00', '2026-11-23', '18:30:00', 540],
    ['before opening', '2026-11-23', '08:30:00', '2026-11-23', '09:31:00', 1],
    ['after closing', '2026-11-23', '18:29:00', '2026-11-23', '23:00:00', 1],
    ['overnight', '2026-11-23', '18:00:00', '2026-11-24', '10:00:00', 60],
    ['Saturday', '2026-11-21', '09:30:00', '2026-11-21', '18:30:00', 0],
    ['Sunday', '2026-11-22', '09:30:00', '2026-11-22', '18:30:00', 0],
    ['two weekends', '2026-11-20', '18:30:00', '2026-11-30', '09:30:00', 2700],
    ['leap day', '2024-02-28', '18:30:00', '2024-03-01', '09:30:00', 540],
    ['year boundary', '2026-12-31', '18:00:00', '2027-01-01', '10:00:00', 60],
  ] as const)('counts %s', (_name, from, start, to, end, expected) => {
    expect(regular.between(local(from, start), local(to, end))).toBe(minutes(expected))
  })

  it('skips consecutive festivals, with no extra weekend deduction', () => {
    const calendar = businessCalendar(['2026-11-21', '2026-11-23', '2026-11-24'])
    expect(calendar.isWorkingDate('2026-11-23')).toBe(false)
    expect(calendar.isWorkingDate('2026-11-21')).toBe(false)
    expect(calendar.isWorkingDate('2026-11-25')).toBe(true)
    expect(calendar.between(local('2026-11-20', '18:00:00'), local('2026-11-25', '10:00:00'))).toBe(minutes(60))
    expect(calendar.nextOpening(local('2026-11-20', '17:00:00'))).toEqual(local('2026-11-25'))
    expect(calendar.normalize(local('2026-11-23'))).toEqual(local('2026-11-25'))
  })

  it.each([
    [local('2026-11-23', '00:01:00'), monday],
    [at('09:30:00'), monday],
    [at('18:30:00'), local('2026-11-24')],
    [local('2026-11-21', '12:00:00'), monday],
  ])('normalizes %s to %s', (from, expected) => {
    expect(regular.normalize(from)).toEqual(expected)
  })

  it('uses half-open intervals and keeps exact closing deadlines', () => {
    expect(regular.isWorkingInstant(monday)).toBe(true)
    expect(regular.isWorkingInstant(at('18:29:59.999'))).toBe(true)
    expect(regular.isWorkingInstant(at('18:30:00'))).toBe(false)
    expect(regular.closing(monday)).toEqual(at('18:30:00'))
    expect(regular.add(monday, minutes(540))).toEqual(at('18:30:00'))
  })

  it('normalizes zero duration and rejects invalid and reversed ranges', () => {
    expect(regular.add(at('18:30:00'), 0)).toEqual(local('2026-11-24'))
    expect(regular.between(monday, monday)).toBe(0)
    expect(() => regular.between(at('18:30:00'), monday)).toThrow(RangeError)
    expect(() => regular.between(new Date('invalid'), monday)).toThrow(RangeError)
    expect(() => regular.closing(local('2026-11-21'))).toThrow(RangeError)
    for (const invalid of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => regular.add(monday, invalid)).toThrow(RangeError)
  })

  it.each(['2026-02-29', '2026-2-03', 'not-a-date', '10000-01-01'])('rejects invalid holiday %s', (date) => {
    expect(() => businessCalendar([date])).toThrow(RangeError)
  })

  it('preserves milliseconds and adding/measuring are inverse across closures', () => {
    const calendar = businessCalendar(['2026-11-23', '2026-11-24'])
    for (const duration of [0, 1, 60_001, minutes(271) + 456, minutes(2699) + 59_999]) {
      const from = local('2026-11-20', '18:29:59.999')
      expect(calendar.between(from, calendar.add(from, duration))).toBe(duration)
    }
  })

  const originalTimezone = process.env.TZ
  afterAll(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone })
  it('produces the same UTC deadline under different process timezones', () => {
    for (const timezone of ['UTC', 'America/New_York', 'Pacific/Auckland']) {
      process.env.TZ = timezone
      expect(regular.add(monday, minutes(120)).toISOString()).toBe('2026-11-23T06:00:00.000Z')
    }
  })
})

describe('initial deadlines', () => {
  it.each([
    ['URGENT', '2026-11-23T06:00:00.000Z', '2026-11-23T13:00:00.000Z'],
    ['MEDIUM', '2026-11-23T08:30:00.000Z', '2026-11-25T13:00:00.000Z'],
    ['LOW', '2026-11-23T13:00:00.000Z', '2026-11-27T13:00:00.000Z'],
  ] as const)('calculates both Monday opening deadlines for %s', (priority, response, resolution) => {
    expect(startClock('RESPONSE', priority, monday, regular).dueAt?.toISOString()).toBe(response)
    expect(startClock('RESOLUTION', priority, monday, regular).dueAt?.toISOString()).toBe(resolution)
  })

  it.each([
    [local('2026-11-20', '17:30:00'), [], '2026-11-23T05:00:00.000Z', '2026-11-23T13:00:00.000Z'],
    [local('2026-11-20', '17:30:00'), ['2026-11-23'], '2026-11-24T05:00:00.000Z', '2026-11-24T13:00:00.000Z'],
    [local('2026-11-20', '18:00:00'), [], '2026-11-23T05:30:00.000Z', '2026-11-23T13:00:00.000Z'],
    [at('16:30:00.000'), [], '2026-11-23T13:00:00.000Z', '2026-11-23T13:00:00.000Z'],
    [at('16:30:00.001'), [], '2026-11-24T04:00:00.001Z', '2026-11-24T13:00:00.000Z'],
    [local('2026-11-21', '12:00:00'), [], '2026-11-23T06:00:00.000Z', '2026-11-23T13:00:00.000Z'],
  ] as const)('calculates urgent deadlines for %s and holidays %s', (start, holidays, response, resolution) => {
    const calendar = businessCalendar(holidays)
    expect(startClock('RESPONSE', 'URGENT', start, calendar).dueAt?.toISOString()).toBe(response)
    expect(startClock('RESOLUTION', 'URGENT', start, calendar).dueAt?.toISOString()).toBe(resolution)
  })

  it('spans weekends and multiple holidays for longer budgets', () => {
    const calendar = businessCalendar(['2026-11-23', '2026-11-24'])
    const start = local('2026-11-20')
    expect(startClock('RESOLUTION', 'MEDIUM', start, calendar).dueAt).toEqual(local('2026-11-26', '18:30:00'))
    expect(startClock('RESOLUTION', 'LOW', start, calendar).dueAt).toEqual(local('2026-11-30', '18:30:00'))
  })
})

describe('clock operations', () => {
  it('reports active consumption, remaining time and working overdue time', () => {
    const clock = startClock('RESPONSE', 'URGENT', monday, regular)
    expect(evaluate(clock, at('10:30:00'), regular)).toMatchObject({ status: 'ACTIVE', consumedMs: minutes(60), remainingMs: minutes(60) })
    expect(evaluate(clock, at('11:30:00.001'), regular)).toMatchObject({ status: 'OVERDUE', remainingMs: 0, overdueWorkingMs: 1 })
  })

  it('distinguishes exact and late completion even when working time is identical', () => {
    const clock = startClock('RESPONSE', 'LOW', monday, regular)
    const deadline = at('18:30:00.000')
    const late = at('18:30:00.001')
    expect(evaluate(clock, deadline, regular).status).toBe('ACTIVE')
    expect(evaluate(clock, late, regular)).toMatchObject({ status: 'OVERDUE', overdueWorkingMs: 0 })
    expect(evaluate(complete(clock, deadline, regular), late, regular).status).toBe('COMPLETED_ON_TIME')
    expect(evaluate(complete(clock, late, regular), late, regular)).toMatchObject({
      status: 'COMPLETED_LATE', firstBreachedAt: deadline, deadline,
    })
  })

  it('preserves partial minutes with repeated pause and resume', () => {
    const clock = startClock('RESOLUTION', 'MEDIUM', monday, regular)
    const paused = pauseResolution(clock, at('09:31:00.123'), regular)
    expect(pauseResolution(paused, at('10:00:00'), regular)).toBe(paused)
    expect(evaluate(paused, local('2026-11-25'), regular)).toMatchObject({ status: 'PAUSED', consumedMs: 60_123 })
    const resumed = resumeResolution(paused, local('2026-11-24'), regular)
    expect(resumeResolution(resumed, at('12:00:00'), regular)).toBe(resumed)
    const again = pauseResolution(resumed, local('2026-11-24', '09:31:00.456'), regular)
    expect(again.elapsedMs).toBe(120_579n)
    const final = resumeResolution(again, local('2026-11-25'), regular)
    expect(final.dueAt).toEqual(local('2026-11-27', '18:27:59.421'))
  })

  it('keeps an exact-deadline pause clean and normalizes zero-budget resume', () => {
    const clock = startClock('RESOLUTION', 'URGENT', monday, regular)
    const paused = pauseResolution(clock, at('18:30:00'), regular)
    expect(paused.firstBreachedAt).toBeNull()
    expect(resumeResolution(paused, at('19:00:00'), regular).dueAt).toEqual(local('2026-11-24'))
  })

  it('settles old breaches and preserves elapsed time across priority changes', () => {
    const original = startClock('RESPONSE', 'MEDIUM', monday, regular)
    const urgent = changeBudget(original, 'URGENT', at('12:00:00'), regular)
    expect(urgent.elapsedMs).toBe(BigInt(minutes(150)))
    expect(evaluate(urgent, at('12:00:00'), regular)).toMatchObject({ status: 'OVERDUE', firstBreachedAt: at('12:00:00') })
    const low = changeBudget(urgent, 'LOW', at('12:15:00'), regular)
    expect(low.originalBudgetMs).toBe(original.originalBudgetMs)
    expect(low.firstBreachedAt).toEqual(at('12:00:00'))
    expect(low.dueAt).toEqual(at('18:30:00'))
    const done = complete(low, at('13:00:00'), regular)
    expect(evaluate(done, at('13:01:00'), regular).status).toBe('COMPLETED_ON_TIME')
    expect(changeBudget(done, 'URGENT', at('13:01:00'), regular)).toBe(done)
  })

  it('recomputes urgent resolution from cycle start without burning paused time', () => {
    const initial = startClock('RESOLUTION', 'MEDIUM', at('17:30:00'), regular)
    const pause = pauseResolution(initial, at('18:00:00'), regular)
    const upgraded = changeBudget(pause, 'URGENT', local('2026-11-24'), regular)
    expect(upgraded.budgetMs).toBe(BigInt(minutes(600)))
    expect(upgraded.elapsedMs).toBe(BigInt(minutes(30)))
    expect(upgraded.dueAt).toBeNull()
    expect(resumeResolution(upgraded, local('2026-11-24'), regular).dueAt).toEqual(local('2026-11-25', '10:00:00'))
  })

  it('preserves a missed deadline during later pause/resume', () => {
    const initial = startClock('RESOLUTION', 'URGENT', monday, regular)
    const paused = pauseResolution(initial, local('2026-11-24', '09:31:00'), regular)
    const resumed = resumeResolution(paused, local('2026-11-25'), regular)
    expect(resumed.firstBreachedAt).toEqual(at('18:30:00'))
    expect(evaluate(resumed, local('2026-11-25'), regular).status).toBe('OVERDUE')
  })

  it('starts independent resolution cycles and excludes calendar-version cross-contamination', () => {
    const first = complete(startClock('RESOLUTION', 'URGENT', monday, regular), at('12:00:00'), regular)
    const calendar = businessCalendar(['2026-11-24'])
    const reopened = nextResolution(first, 'URGENT', local('2026-11-24'), calendar)
    expect(reopened).toMatchObject({ cycle: 2, elapsedMs: 0n, firstBreachedAt: null, dueAt: local('2026-11-25', '18:30:00') })
    expect(first).toMatchObject({ cycle: 1, state: 'COMPLETED', completedDueAt: at('18:30:00') })
    expect(nextResolution(first, 'URGENT', local('2026-11-24'), regular).dueAt).toEqual(local('2026-11-24', '18:30:00'))
  })
})
