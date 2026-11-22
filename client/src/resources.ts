import { useCallback, useEffect, useState } from 'react'
import { errorText, type Request } from './api'

export function useRead<T>(request: Request, path: string, interval = 0) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>()
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => {
    let active: AbortController | undefined
    const read = () => {
      active?.abort()
      const controller = new AbortController()
      active = controller
      request<T>(path, { signal: controller.signal }).then((data) => {
        if (!controller.signal.aborted) setResult({ path, data })
      }, (error: unknown) => {
        if (!controller.signal.aborted) setResult((current) => ({
          path, data: current?.path === path ? current.data : undefined, error: errorText(error),
        }))
      })
    }
    read()
    const timer = interval ? window.setInterval(() => { if (!document.hidden) read() }, interval) : undefined
    return () => { active?.abort(); clearInterval(timer) }
  }, [request, path, version, interval])
  const current = result?.path === path ? result : undefined
  return { data: current?.data, error: current?.error, loading: !current, reload }
}
