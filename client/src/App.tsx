import { useEffect, useState } from 'react'
import { Database, Headphones, Server, type LucideIcon } from 'lucide-react'

type Status = 'Checking…' | 'Connected' | 'Ready' | 'Unavailable'

async function check(path: string, expected: string, signal: AbortSignal) {
  const response = await fetch(path, { signal, cache: 'no-store' })
  if (!response.ok) return false
  const payload: unknown = await response.json()
  return typeof payload === 'object' && payload !== null && 'status' in payload && payload.status === expected
}

function Indicator({ label, status, icon: Icon }: { label: string; status: Status; icon: LucideIcon }) {
  const color = status === 'Unavailable' ? 'text-red-700'
    : status === 'Checking…' ? 'text-slate-600' : 'text-emerald-800'
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 py-4 last:border-0">
      <span className="flex items-center gap-3 font-medium"><Icon size={18} aria-hidden="true" />{label}</span>
      <span className={color}>{status}</span>
    </li>
  )
}

export function App() {
  const [backend, setBackend] = useState<Status>('Checking…')
  const [database, setDatabase] = useState<Status>('Checking…')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    async function update(path: string, expected: string, success: Status, setStatus: (status: Status) => void) {
      let available = false
      try { available = await check(path, expected, signal) } catch { /* Display unavailable below. */ }
      if (!controller.signal.aborted) setStatus(available ? success : 'Unavailable')
    }
    void update('/api/health', 'ok', 'Connected', setBackend)
    void update('/api/ready', 'ready', 'Ready', setDatabase)
    return () => controller.abort()
  }, [refresh])

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
      <section className="w-full rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
        <Headphones size={32} className="mb-5 text-teal-800" aria-hidden="true" />
        <h1 className="text-3xl font-bold tracking-tight">Frontdesk</h1>
        <p className="mt-2 text-slate-600">Customer support management system</p>
        <ul className="mt-5" aria-live="polite">
          <Indicator label="Backend" status={backend} icon={Server} />
          <Indicator label="Database" status={database} icon={Database} />
        </ul>
        <button type="button" className="mt-4 rounded-lg bg-teal-800 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-800" onClick={() => {
          setBackend('Checking…')
          setDatabase('Checking…')
          setRefresh((value) => value + 1)
        }}>Refresh status</button>
      </section>
    </main>
  )
}
