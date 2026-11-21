export const BUSINESS_TIMEZONE = 'Asia/Kolkata'
export const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const OPEN = 570 * MINUTE_MS
const CLOSE = 1110 * MINUTE_MS
const MAX_DAYS = 36_600
const MIN_DATE = Date.UTC(1970, 0, 1)
const MAX_DATE = Date.UTC(9999, 11, 31)
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})
const localOffset = new Intl.DateTimeFormat('en', {
  timeZone: BUSINESS_TIMEZONE, timeZoneName: 'longOffset',
})

function dateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Invalid business date.')
  const ms = Date.parse(value + 'T00:00:00.000Z')
  if (!Number.isFinite(ms) || ms < MIN_DATE || ms > MAX_DATE ||
      new Date(ms).toISOString().slice(0, 10) !== value) throw new RangeError('Invalid business date.')
  return ms
}

function dayOf(instant: Date) {
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Invalid instant.')
  const parts = localDate.formatToParts(instant)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return dateKey(part('year') + '-' + part('month') + '-' + part('day'))
}

function interval(day: number) {
  if (day < MIN_DATE || day > MAX_DATE) throw new RangeError('Business date out of range.')
  // Use the IANA offset at local daytime. Kolkata has no daytime shifts in the supported range.
  const offset = localOffset.formatToParts(day + 12 * 60 * MINUTE_MS)
    .find((entry) => entry.type === 'timeZoneName')?.value
  const match = /^GMT([+-])(\d\d):(\d\d)$/.exec(offset ?? '')
  if (!match) throw new RangeError('Invalid business timezone offset.')
  const offsetMs = (Number(match[2]) * 60 + Number(match[3])) * MINUTE_MS * (match[1] === '+' ? 1 : -1)
  return { open: day + OPEN - offsetMs, close: day + CLOSE - offsetMs }
}

export function businessCalendar(holidayDates: readonly string[] = []) {
  const holidays = new Set(holidayDates.map(dateKey))

  function working(day: number) {
    const weekday = new Date(day).getUTCDay()
    return weekday >= 1 && weekday <= 5 && !holidays.has(day)
  }

  function normalize(instant: Date) {
    const timestamp = instant.getTime()
    let day = dayOf(instant)
    for (let i = 0; i <= MAX_DAYS; i++, day += DAY_MS) {
      if (day > MAX_DATE) break
      if (!working(day)) continue
      const { open, close } = interval(day)
      if (timestamp < close) return new Date(Math.max(open, timestamp))
    }
    throw new RangeError('No eligible working interval within supported range.')
  }

  function between(start: Date, end: Date) {
    const first = dayOf(start)
    const last = dayOf(end)
    if (end < start) throw new RangeError('Working interval is reversed.')
    if (last - first > MAX_DAYS * DAY_MS) throw new RangeError('Working interval is too long.')
    let total = 0
    for (let day = first; day <= last; day += DAY_MS) {
      if (!working(day)) continue
      const { open, close } = interval(day)
      total += Math.max(0, Math.min(end.getTime(), close) - Math.max(start.getTime(), open))
    }
    return total
  }

  function add(start: Date, durationMs: number) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_DAYS * (CLOSE - OPEN)) {
      throw new RangeError('Invalid working duration.')
    }
    const timestamp = normalize(start).getTime()
    if (durationMs === 0) return new Date(timestamp)
    let day = dayOf(new Date(timestamp))
    for (let i = 0; i <= MAX_DAYS; i++, day += DAY_MS) {
      if (day > MAX_DATE) break
      if (!working(day)) continue
      const { open, close } = interval(day)
      const from = Math.max(timestamp, open)
      const capacity = close - from
      if (durationMs <= capacity) return new Date(from + durationMs)
      durationMs -= capacity
    }
    throw new RangeError('Working deadline exceeds supported range.')
  }

  function closing(instant: Date) {
    const day = dayOf(instant)
    if (!working(day)) throw new RangeError('Date is not a working day.')
    return new Date(interval(day).close)
  }

  return {
    isWorkingDate: (date: string) => working(dateKey(date)),
    isWorkingInstant: (instant: Date) => {
      const day = dayOf(instant)
      if (!working(day)) return false
      const { open, close } = interval(day)
      return instant.getTime() >= open && instant.getTime() < close
    },
    nextOpening: (instant: Date) => {
      const day = dayOf(instant)
      const open = interval(day).open
      if (working(day) && instant.getTime() <= open) return new Date(open)
      return normalize(new Date(interval(day).close))
    },
    normalize, between, add, closing,
  }
}

export type Calendar = ReturnType<typeof businessCalendar>

export function calendarFromDates(holidays: readonly { date: Date }[]) {
  // Prisma returns a PostgreSQL DATE at UTC midnight. Use the date portion unchanged.
  return businessCalendar(holidays.map(({ date }) => date.toISOString().slice(0, 10)))
}
