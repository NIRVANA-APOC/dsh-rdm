/**
 * Browser route `POST /api/dsh-rdm/api` for the `dsh-rdm` sidebar panel.
 *
 * Registered through `ctx.connection.fetch.register`, which enforces the
 * Host/Origin browser authentication; this module only owns the JSON contract
 * and the action dispatcher. Every action calls the same {@link KernelService}
 * methods as the model-facing tools, so validation and error mapping are
 * identical for the two callers.
 *
 * Envelope: `{"ok":true,"value":...}` or
 * `{"ok":false,"error":{"code","message"}}`; responses are never cached.
 *
 * @module dsh-rdm/host-api
 */

import { toKernelLogger } from './kernel-client'
import {
  KernelError,
  normalizeControlAction,
  normalizeRequestSpec,
  normalizeStatusFilter,
  normalizeTaskId,
} from './kernel-client'
import type { KernelService } from './kernel-client'
import {
  DEFAULT_EVENTS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  ROUTE_MAX_EVENTS,
  type ApiErrorEnvelope,
  type ApiSuccessEnvelope,
  type KernelStatusView,
  type TaskEvent,
  type TaskView,
} from './protocol'

/** Path of the panel's single JSON endpoint. */
export const RDM_API_PATH = '/api/dsh-rdm/api'

/**
 * Register the browser route on the connection service.
 *
 * A deployment without `connection.fetch` (or with a non-browser connection
 * service) simply has no panel API; the tools keep working.
 *
 * @param ctx - Host plugin context.
 * @param kernel - The shared kernel service.
 */
export function registerRdmHostApi(ctx: HostContext, kernel: KernelService): void {
  const logger = toKernelLogger(ctx.logger)
  const connection = ctx.connection ?? ctx.get('connection')
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
    logger.warn('browser API not registered: the connection service does not expose ctx.connection.fetch')
    return
  }
  ctx.effect(
    () =>
      connection.fetch.register({
        path: RDM_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request: Request) => handleRdmApiRequest(kernel, request),
      }),
    'dsh-rdm: browser API route',
  )
  logger.debug(`browser API registered at ${RDM_API_PATH}`)
}

// ── Response helpers ────────────────────────────────────────────────────────

/** Serialize a JSON response the panel can cache-control. */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Success envelope. */
function okResponse<Value>(value: Value): Response {
  const envelope: ApiSuccessEnvelope<Value> = { ok: true, value }
  return jsonResponse(envelope)
}

/** Failure envelope (HTTP 200; the panel branches on `ok`). */
function errorResponse(code: string, message: string): Response {
  const envelope: ApiErrorEnvelope = { ok: false, error: { code, message } }
  return jsonResponse(envelope)
}

/** Map a thrown error to a failure envelope. */
function errorResponseFrom(error: unknown): Response {
  if (error instanceof KernelError) return errorResponse(error.code, error.message)
  if (error instanceof Error) return errorResponse('internal', error.message)
  return errorResponse('internal', String(error))
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Clamp a finite number into an integer range (`undefined` -> fallback). */
function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Payload of a successful `list`. */
interface ListValue {
  kernel: KernelStatusView
  tasks: TaskView[]
}

/** Payload of a successful `get`. */
interface GetValue {
  task: TaskView
  events: TaskEvent[]
}

/**
 * `list`: kernel status plus tasks. A kernel that cannot start is reported
 * through `kernel.error` with an empty task list instead of failing the whole
 * response, because the panel polls this action every second.
 */
async function listAction(kernel: KernelService, body: Record<string, unknown>): Promise<ListValue> {
  const status = normalizeStatusFilter(body.status)
  const limit = clampInteger(body.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
  try {
    const tasks = await kernel.list(status, limit)
    return { kernel: kernel.kernelStatus(), tasks }
  } catch {
    // A kernel that cannot start is reported through `kernel.error` (which the
    // panel renders); the poll loop must keep receiving a valid envelope.
    return { kernel: kernel.kernelStatus(), tasks: [] }
  }
}

/** `get`: one task plus recent diagnostic events. */
async function getAction(kernel: KernelService, body: Record<string, unknown>): Promise<GetValue> {
  const taskId = normalizeTaskId(body.id, 'id')
  const events = clampInteger(body.events, DEFAULT_EVENTS, 0, ROUTE_MAX_EVENTS)
  return kernel.get(taskId, events)
}

/** Actions the dispatcher understands. */
const ACTIONS = new Set(['list', 'get', 'start', 'control', 'stats'])

/**
 * Handle one `POST /api/dsh-rdm/api` request.
 *
 * Exported for tests: the fetch registration above is the only production
 * caller.
 *
 * @param kernel - The shared kernel service.
 * @param request - The incoming buffered HTTP request.
 * @returns JSON envelope response (always HTTP 200).
 */
export async function handleRdmApiRequest(kernel: KernelService, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('bad_request', 'request body must be JSON')
  }
  const record = asRecord(body)
  if (record === null) return errorResponse('bad_request', 'request body must be a JSON object')

  const action = record.action
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    return errorResponse(
      'bad_request',
      `unknown action ${JSON.stringify(action)}; expected one of ${[...ACTIONS].join(', ')}`,
    )
  }

  try {
    switch (action) {
      case 'list':
        return okResponse(await listAction(kernel, record))
      case 'get':
        return okResponse(await getAction(kernel, record))
      case 'start': {
        const task = await kernel.start(normalizeRequestSpec(record))
        return okResponse({ task })
      }
      case 'control': {
        // `control` is the panel's verb field; `op`/`command` are tolerated
        // aliases so an older client cannot silently no-op.
        const verb = record.control ?? record.op ?? record.command
        const verbAction = normalizeControlAction(verb)
        const taskId = normalizeTaskId(record.id, 'id')
        const deletePart = record.deletePart === true
        const task = await kernel.control(taskId, verbAction, deletePart)
        return okResponse({ task })
      }
      case 'stats':
        return okResponse(await kernel.stats())
      default:
        // `ACTIONS` already narrowed this; keep the compiler exhaustive.
        return errorResponse('bad_request', `unsupported action ${action}`)
    }
  } catch (error) {
    return errorResponseFrom(error)
  }
}
