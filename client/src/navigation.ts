import { useEffect, useState } from 'react'
import type { Identity } from './contracts'

const changed = 'frontdesk:navigate'
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return
  const samePage = to.split('?')[0] === location.pathname
  history[replace ? 'replaceState' : 'pushState'](null, '', to)
  dispatchEvent(new Event(changed))
  if (!samePage) {
    scrollTo(0, 0)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true }))
  }
}
export function useLocation() {
  const [url, setUrl] = useState(() => new URL(location.href))
  useEffect(() => {
    const sync = () => setUrl(new URL(location.href))
    addEventListener('popstate', sync)
    addEventListener(changed, sync)
    return () => { removeEventListener('popstate', sync); removeEventListener(changed, sync) }
  }, [])
  return url
}
export function queuePath(role: Identity['role']) { return '/' + role.toLowerCase() + '/tickets' }
export function screen(path: string, role: Identity['role']) {
  const base = queuePath(role)
  if (['/', '/login', '/' + role.toLowerCase()].includes(path)) return { name: 'redirect' } as const
  if (path === base) return { name: 'queue' } as const
  if (role === 'CUSTOMER' && path === base + '/new') return { name: 'new' } as const
  const id = path.startsWith(base + '/') ? path.slice(base.length + 1) : ''
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return { name: 'detail', id } as const
  return { name: 'missing' } as const
}
export function queueQuery(search: string, staff: boolean) {
  const source = new URLSearchParams(search)
  const result = new URLSearchParams()
  if (staff) {
    const scope = source.get('scope')
    result.set('scope', scope === 'mine' || scope === 'unassigned' ? scope : 'all')
  }
  for (const key of ['q', 'priority', 'status', 'page', ...(staff ? ['sla', 'assigneeId'] : [])]) {
    const value = source.get(key)?.trim()
    if (value) result.set(key, value)
  }
  return result
}
