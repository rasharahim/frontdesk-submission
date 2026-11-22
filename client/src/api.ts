export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
type Options = { method?: 'POST' | 'PATCH'; body?: object; signal?: AbortSignal }
export type Request = <T>(path: string, options?: Options) => Promise<T>
export async function api<T>(path: string, { method, body, signal }: Options = {}, expired?: () => void): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, { method, signal, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ApiError(0, 'NETWORK', 'Could not connect to Frontdesk. Check your connection and try again.')
  }
  if (!response.ok) {
    if (response.status === 401 && !signal?.aborted) expired?.()
    const data = await response.json().catch(() => null)
    const code = typeof data?.error?.code === 'string' ? data.error.code : 'UNAVAILABLE'
    const messages: Record<string, string> = {
      INVALID_CREDENTIALS: 'Email or password is incorrect.',
      TICKET_ALREADY_CLAIMED: 'This ticket has already been claimed.',
      TICKET_CLOSED: 'This ticket is closed. Create a new ticket to continue.',
      REOPEN_EXPIRED: 'The reopening window has expired. Create a new ticket to continue.',
      SLA_HISTORY_UNAVAILABLE: 'Timing history is unavailable for this ticket. This action cannot be completed.',
    }
    throw new ApiError(response.status, code, response.status >= 500 ? 'Frontdesk is temporarily unavailable. Please try again.'
      : messages[code] ?? (typeof data?.error?.message === 'string' ? data.error.message : 'The request could not be completed.'))
  }
  if (response.status === 204) return undefined as T
  try { return await response.json() } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', 'Frontdesk returned an unexpected response.') }
}
export const errorText = (error: unknown) => error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'

export function writeErrorText(error: unknown, check: string) {
  if (error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE')) {
    return 'Frontdesk could not confirm this change. ' + check + ' before trying again.'
  }
  return errorText(error)
}
