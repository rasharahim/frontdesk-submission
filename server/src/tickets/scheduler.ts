type Summary = { closed: number; checked: number }

export function startScheduler(run: () => Promise<Summary>, intervalMs: number, log: (message: string) => void) {
  let active: Promise<void> | undefined
  function tick() {
    if (active) return
    active = Promise.resolve().then(run).then(({ closed, checked }) => {
      if (closed || checked) log('Lifecycle reconciliation closed ' + closed + ' tickets and checked ' + checked + ' for SLA breaches.')
    }).catch(() => {
      log('Lifecycle reconciliation failed. A later scheduled run will retry.')
    }).finally(() => { active = undefined })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  return async () => {
    clearInterval(timer)
    await active
  }
}
