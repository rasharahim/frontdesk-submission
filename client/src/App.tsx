import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Eye, EyeOff, Inbox, UserRound, CircleAlert, Clock3, LogOut, Plus, Users } from 'lucide-react'
import { api, ApiError, errorText, type Request } from './api'
import type { Identity } from './contracts'
import { navigate, queuePath, screen, useLocation } from './navigation'
import { Brand, Busy, Empty, Link, Notice } from './ui'
import { Queue } from './Queue'
const NewTicket = lazy(() => import('./Workspace').then((module) => ({ default: module.NewTicket })))
const Workspace = lazy(() => import('./Workspace').then((module) => ({ default: module.Workspace })))

function Login({ onLogin, expired }: { onLogin: (user: Identity) => void; expired: boolean }) {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (new TextEncoder().encode(password).length > 72) { setError('Password must be 72 UTF-8 bytes or fewer.'); return }
    submitting.current = true
    setBusy(true)
    setError('')
    try { onLogin(await api<Identity>('/auth/login', { method: 'POST', body: { email: String(form.get('email')).trim(), password } })) }
    catch (failure) { setError(errorText(failure)) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <main className="login" tabIndex={-1}>
    <section className="login-brand"><Brand /><div><span className="login-accent" /><h1>Support workspace<br />for Arvo Systems</h1><p>Track requests and keep support conversations in one place.</p></div></section>
    <section className="login-main"><form className="login-form" onSubmit={login}>
      <h2>Sign in to Frontdesk</h2><p>Use your Arvo Systems account.</p>
      {expired && <Notice>Your session ended. Sign in again to continue.</Notice>}
      {error && <Notice>{error}</Notice>}
      <label>Email address<input name="email" type="email" autoComplete="username" maxLength={254} required placeholder="name@example.com" /></label>
      <label>Password<span className="password"><input name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required />
        <button type="button" className="icon-button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
      <button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} aria-hidden /></button>
    </form></section>
  </main>
}

function Shell({ user, request, url, logout }: { user: Identity; request: Request; url: URL; logout: () => Promise<void> }) {
  const base = queuePath(user.role)
  const current = screen(url.pathname, user.role)
  const staff = user.role === 'AGENT'
  const lastQueue = useRef(base)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  useEffect(() => {
    if (current.name === 'queue') lastQueue.current = base + url.search
    if (current.name === 'redirect') navigate(base, true)
  }, [current.name, url.search, base])
  const nav = staff ? [
    [base, 'All tickets', Inbox], [base + '?scope=mine', 'Assigned to me', UserRound],
    [base + '?scope=unassigned', 'Unassigned', Users], [base + '?sla=overdue', 'Overdue', CircleAlert],
    [base + '?status=WAITING', 'Waiting', Clock3],
  ] as const : [[base, 'My tickets', Inbox], [base + '/new', 'New ticket', Plus]] as const
  const navKey = url.searchParams.get('sla') === 'overdue' ? '?sla=overdue' : url.searchParams.get('status') === 'WAITING' ? '?status=WAITING'
    : ['mine', 'unassigned'].includes(url.searchParams.get('scope') ?? '') ? '?scope=' + url.searchParams.get('scope') : ''
  const navCurrent = url.pathname + (current.name === 'queue' && staff ? navKey : '')
  async function signOut() {
    setLogoutBusy(true)
    setLogoutError('')
    try { await logout() } catch (failure) { setLogoutError(errorText(failure)); setLogoutBusy(false) }
  }
  return <div className="shell">
    <a className="skip" href="#main">Skip to content</a>
    <aside className="sidebar">
      <Brand />
      <nav aria-label={staff ? 'Agent workspace' : 'Customer workspace'}>
        <p className="nav-heading">{staff ? 'Support workspace' : 'Customer support'}</p>
        {nav.map(([to, label, Icon]) => <Link key={to} to={to} current={navCurrent === to}><Icon size={17} aria-hidden />{label}</Link>)}
      </nav>
      <div className="identity"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{staff ? 'Support agent' : 'Customer'}</small></div>
        <button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logoutBusy} onClick={() => void signOut()}><LogOut size={18} aria-hidden /></button>
      </div>
    </aside>
    <main id="main" className="main" tabIndex={-1}>
      {logoutError && <Notice>{logoutError}</Notice>}
      {current.name === 'queue' && <Queue user={user} request={request} url={url} />}
      <Suspense fallback={<Busy />}>
        {current.name === 'detail' && <Workspace key={current.id} id={current.id} user={user} request={request} back={lastQueue.current} />}
        {current.name === 'new' && <NewTicket request={request} back={lastQueue.current} source={url.searchParams.get('from')} />}
      </Suspense>
      {current.name === 'missing' && <Empty title="Page not available"><Link to={base}>Return to tickets</Link></Empty>}
      {current.name === 'redirect' && <Busy />}
    </main>
  </div>
}

export function App() {
  const url = useLocation()
  const [user, setUser] = useState<Identity | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const returnPath = useRef('')
  const clear = useCallback((sessionExpired: boolean) => {
    generation.current += 1
    returnPath.current = sessionExpired ? location.pathname + location.search : ''
    setExpired(sessionExpired)
    setUser(null)
    navigate('/login', true)
  }, [])
  const request = useCallback<Request>(async <T,>(path: string, options?: Parameters<Request>[1]) => {
    const activeGeneration = generation.current
    const result = await api<T>(path, options, () => { if (activeGeneration === generation.current) clear(true) })
    if (activeGeneration !== generation.current) throw new DOMException('Session changed', 'AbortError')
    return result
  }, [clear])
  useEffect(() => {
    const controller = new AbortController()
    api<Identity>('/auth/me', { signal: controller.signal }).then((identity) => {
      if (!controller.signal.aborted) setUser(identity)
    }, (failure: unknown) => {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status === 401) {
        returnPath.current = location.pathname + location.search
        setUser(null)
        navigate('/login', true)
      } else setError(errorText(failure))
    })
    return () => controller.abort()
  }, [attempt])
  if (user === undefined) return <main className="startup">{error
    ? <Notice retry={() => { setError(''); setAttempt(attempt + 1) }}>{error}</Notice>
    : <Busy label="Checking your session…" />}</main>
  if (!user) return <Login expired={expired} onLogin={(identity) => {
    generation.current += 1
    setExpired(false)
    setUser(identity)
    const requested = returnPath.current
    returnPath.current = ''
    const path = screen(requested.split('?')[0], identity.role)
    navigate(path.name === 'detail' || path.name === 'queue' || path.name === 'new' ? requested : queuePath(identity.role), true)
  }} />
  return <Shell key={user.id} user={user} request={request} url={url} logout={async () => {
    await request('/auth/logout', { method: 'POST' })
    clear(false)
  }} />
}
