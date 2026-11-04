// Client for the dsh-rdm browser route: POST /api/dsh-rdm/api.
// Every action answers one JSON envelope `{ok:true,value}` or
// `{ok:false,error:{code,message}}`; transport failures are normalized to a
// RouteError with a stable code so the panel can translate common cases.

import type { ControlOp, TFunction } from './types'

/** Route path registered by the host half through the connection service. */
export const ROUTE = '/api/dsh-rdm/api'

/** Normalized failure from the route or from the transport. */
export class RouteError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

interface Envelope {
  ok?: unknown
  value?: unknown
  error?: { code?: unknown; message?: unknown } | null
}

/** POST one action to the plugin route and unwrap its envelope. */
export async function request<T>(payload: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
    controller = new AbortController()
    timer = setTimeout(() => controller?.abort(), timeoutMs)
  }

  let response: Response
  try {
    response = await fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    })
  } catch (error) {
    if (controller && controller.signal.aborted) {
      throw new RouteError('timeout', `request timed out after ${timeoutMs}ms`)
    }
    throw new RouteError('network', messageOf(error))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new RouteError('network', messageOf(error))
  }

  let envelope: Envelope
  try {
    envelope = text === '' ? {} : (JSON.parse(text) as Envelope)
  } catch {
    throw new RouteError('invalid_response', `HTTP ${response.status}`)
  }

  if (envelope && envelope.ok === true) return envelope.value as T
  if (envelope && envelope.ok === false && envelope.error) {
    const code = typeof envelope.error.code === 'string' && envelope.error.code !== '' ? envelope.error.code : 'internal'
    const message = typeof envelope.error.message === 'string' ? envelope.error.message : ''
    throw new RouteError(code, message)
  }
  throw new RouteError('invalid_response', `HTTP ${response.status}`)
}

/** Coerce any failure value into a RouteError (route failures, task errors, transport errors). */
export function toRouteError(error: unknown): RouteError {
  if (error instanceof RouteError) return error
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (typeof candidate.code === 'string' && candidate.code !== '') {
      return new RouteError(candidate.code, typeof candidate.message === 'string' ? candidate.message : '')
    }
  }
  return new RouteError('internal', messageOf(error))
}

/**
 * Translate a failure for display: a known error code becomes localized text,
 * with the host message appended when it adds detail; unknown codes fall back
 * to the message, then to the generic unknown-error string.
 */
export function errorText(t: TFunction, error: unknown): string {
  const routeError = toRouteError(error)
  const key = `error.code.${routeError.code}`
  const localized = t(key)
  if (localized !== key) return localized
  return routeError.message || t('error.code.unknown')
}

/** Run one control verb against a task. */
export function controlTask(id: string, control: ControlOp): Promise<unknown> {
  return request({ action: 'control', id, control }, 20000)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
