import { MINUTE_MS, type Calendar } from './calendar.js'

type Priority = 'URGENT' | 'MEDIUM' | 'LOW'
type Kind = 'RESPONSE' | 'RESOLUTION'
export type Clock = {
  kind: Kind
  cycle: number
  state: 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELED'
  originalBudgetMs: bigint
  budgetMs: bigint
  elapsedMs: bigint
  startedAt: Date
  activeSince: Date | null
  pausedAt: Date | null
  dueAt: Date | null
  endedAt: Date | null
  completedDueAt: Date | null
  completionOnTime: boolean | null
  firstBreachedAt: Date | null
}

const responses = { URGENT: 120, MEDIUM: 270, LOW: 540 }
const resolutions = { MEDIUM: 1620, LOW: 2700 }

function budget(kind: Kind, priority: Priority, start: Date, calendar: Calendar) {
  if (kind === 'RESPONSE') return responses[priority] * MINUTE_MS
  if (priority !== 'URGENT') return resolutions[priority] * MINUTE_MS
  const effective = calendar.normalize(start)
  const close = calendar.closing(effective)
  const remainder = close.getTime() - effective.getTime()
  return remainder >= 120 * MINUTE_MS
    ? remainder
    : remainder + 540 * MINUTE_MS
}

export function startClock(kind: Kind, priority: Priority, startedAt: Date, calendar: Calendar, cycle = 1): Clock {
  if (!Number.isSafeInteger(cycle) || cycle < 1 || (kind === 'RESPONSE' && cycle !== 1)) {
    throw new RangeError('Invalid SLA cycle.')
  }
  const duration = budget(kind, priority, startedAt, calendar)
  return { kind, cycle, state: 'RUNNING', startedAt, activeSince: startedAt, dueAt: calendar.add(startedAt, duration),
    originalBudgetMs: BigInt(duration), budgetMs: BigInt(duration), elapsedMs: 0n, pausedAt: null,
    endedAt: null, completedDueAt: null, completionOnTime: null, firstBreachedAt: null }
}

function consumed(clock: Clock, now: Date, calendar: Calendar) {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid SLA evaluation instant.')
  const segment = clock.activeSince && now > clock.activeSince ? calendar.between(clock.activeSince, now) : 0
  return clock.elapsedMs + BigInt(segment)
}

export function missedDeadline(clock: Clock, now: Date) {
  const due = clock.dueAt
  return clock.state === 'RUNNING' && due &&
    (now > due || (now >= due && clock.elapsedMs > clock.budgetMs)) ? due : null
}

export function evaluate(clock: Clock, now: Date, calendar: Calendar) {
  const elapsed = consumed(clock, now, calendar)
  const overdue = missedDeadline(clock, now) !== null
  const status = clock.state === 'RUNNING' ? overdue ? 'OVERDUE' : 'ACTIVE'
    : clock.state === 'COMPLETED' ? clock.completionOnTime === null ? 'COMPLETED_UNKNOWN'
      : clock.completionOnTime ? 'COMPLETED_ON_TIME' : 'COMPLETED_LATE' : clock.state
  return { kind: clock.kind, cycle: clock.cycle, status, deadline: clock.dueAt ?? clock.completedDueAt,
    startedAt: clock.startedAt, pausedAt: clock.pausedAt, completedAt: clock.endedAt,
    originalBudgetMs: Number(clock.originalBudgetMs), budgetMs: Number(clock.budgetMs),
    consumedMs: Number(elapsed), remainingMs: Number((clock.state === 'RUNNING' || clock.state === 'PAUSED') && elapsed < clock.budgetMs
      ? clock.budgetMs - elapsed : 0n),
    overdueWorkingMs: overdue && elapsed > clock.budgetMs ? Number(elapsed - clock.budgetMs) : 0,
    firstBreachedAt: clock.firstBreachedAt, overdue }
}

function checkTransition(clock: Clock, at: Date) {
  const since = clock.pausedAt ?? clock.activeSince ?? clock.startedAt
  if (!Number.isFinite(at.getTime()) || at < since) throw new RangeError('Invalid SLA transition instant.')
}

export function complete(clock: Clock, at: Date, calendar: Calendar): Clock {
  if (clock.state !== 'RUNNING') return clock
  checkTransition(clock, at)
  const missed = missedDeadline(clock, at)
  return { ...clock, state: 'COMPLETED', elapsedMs: consumed(clock, at, calendar), endedAt: at,
    activeSince: null, dueAt: null, completedDueAt: clock.dueAt, completionOnTime: !missed,
    firstBreachedAt: clock.firstBreachedAt ?? missed }
}

export function pauseResolution(clock: Clock, at: Date, calendar: Calendar): Clock {
  if (clock.kind !== 'RESOLUTION' || clock.state !== 'RUNNING') return clock
  checkTransition(clock, at)
  return { ...clock, state: 'PAUSED', elapsedMs: consumed(clock, at, calendar), activeSince: null,
    dueAt: null, pausedAt: at, firstBreachedAt: clock.firstBreachedAt ?? missedDeadline(clock, at) }
}

export function resumeResolution(clock: Clock, at: Date, calendar: Calendar): Clock {
  if (clock.kind !== 'RESOLUTION' || clock.state !== 'PAUSED') return clock
  checkTransition(clock, at)
  return { ...clock, state: 'RUNNING', activeSince: at, pausedAt: null,
    dueAt: clock.elapsedMs > clock.budgetMs ? at : calendar.add(at, Number(clock.budgetMs - clock.elapsedMs)) }
}

export function changeBudget(clock: Clock, priority: Priority, at: Date, calendar: Calendar): Clock {
  if (clock.state !== 'RUNNING' && clock.state !== 'PAUSED') return clock
  checkTransition(clock, at)
  const budgetMs = BigInt(budget(clock.kind, priority, clock.startedAt, calendar))
  const elapsedMs = consumed(clock, at, calendar)
  const overBudget = elapsedMs > budgetMs
  const firstBreachedAt = clock.firstBreachedAt ?? missedDeadline(clock, at) ?? (overBudget ? at : null)
  if (clock.state === 'PAUSED') return { ...clock, budgetMs, firstBreachedAt }
  return { ...clock, budgetMs, elapsedMs, firstBreachedAt, activeSince: at,
    dueAt: overBudget ? at : calendar.add(at, Number(budgetMs - elapsedMs)) }
}

export function nextResolution(previous: Clock, priority: Priority, at: Date, calendar: Calendar) {
  if (previous.kind !== 'RESOLUTION' || previous.state !== 'COMPLETED' || !previous.endedAt || at < previous.endedAt) {
    throw new RangeError('A new cycle requires a completed resolution.')
  }
  return startClock('RESOLUTION', priority, at, calendar, previous.cycle + 1)
}
