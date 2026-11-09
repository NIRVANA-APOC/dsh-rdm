/**
 * Browser route `POST /api/dsh-rdm/api` for the `dsh-rdm` review surfaces.
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
 * Protocol v3 actions (design §4):
 * - `list` — kernel + tasks + aggregate + `sessions`/`workspaces` labels;
 * - `get` / `stats` / `start` — unchanged;
 * - `control` — `ids[]` (1..100) or a legacy single `id`, executed
 *   sequentially with one result per id. `pause`/`cancel`/`remove` queue a
 *   short notice to the owning agent when that session has a live agent;
 * - `open` — resolve a task's `path`/`dir` on the host and launch the desktop
 *   opener. The browser never supplies a path.
 *
 * @module dsh-rdm/host-api
 */

import { createSessionCatalog, resolveTaskOpenPath } from './session-catalog'
import type { OpenPathResult, SessionCatalogResult, SessionMeta, WorkspaceMeta } from './session-catalog'
import { toKernelLogger } from './kernel-client'
import {
  KernelError,
  normalizeAggregate,
  normalizeControlAction,
  normalizeRequestSpec,
  normalizeSessionId,
  normalizeTaskId,
  normalizeStatusFilter,
} from './kernel-client'
import type { KernelService } from './kernel-client'
import {
  DEFAULT_EVENTS,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  ROUTE_MAX_EVENTS,
  TERMINAL_STATUSES,
  type Aggregate,
  type ApiErrorEnvelope,
  type ApiSuccessEnvelope,
  type ControlAction,
  type KernelStatusView,
  type TaskDetail,
  type TaskEvent,
  type TaskView,
} from './protocol'

/** Path of the panel's single JSON endpoint. */
export const RDM_API_PATH = '/api/dsh-rdm/api'

/** Batch-control bound (design §4: 1..100 ids per request). */
const MAX_CONTROL_IDS = 100

/** Control verbs that may notify the owning agent (design §4). */
const NOTIFY_ACTIONS: ReadonlySet<ControlAction> = new Set<ControlAction>(['pause', 'cancel', 'remove'])

/** The catalog surface this route reads (tests substitute a fake). */
export interface HostApiCatalog {
  describe(ids: readonly string[]): Promise<SessionCatalogResult>
  notify(sessionId: string, text: string): Promise<boolean>
  openPath(path: string, target: 'file' | 'folder'): Promise<OpenPathResult>
}

/**
 * Register the browser route on the connection service.
 *
 * A deployment without `connection.fetch` (or with a non-browser connection
 * service) simply has no panel API; the tools keep working. The catalog is
 * passed in by the plugin entry so `list` and `rdm_search` share one cache;
 * a caller that omits it gets a lazily created one from this context.
 *
 * @param ctx - Host plugin context.
 * @param kernel - The shared kernel service.
 * @param catalog - Shared session/workspace catalog (optional).
 */
export function registerRdmHostApi(
  ctx: HostContext,
  kernel: KernelService,
  catalog: HostApiCatalog | null = null,
): void {
  const logger = toKernelLogger(ctx.logger)
  const connection = ctx.connection ?? ctx.get<HostConnectionService>('connection')
  if (connection === undefined || connection === null || typeof connection.fetch?.register !== 'function') {
    logger.warn('browser API not registered: the connection service does not expose ctx.connection.fetch')
    return
  }
  const activeCatalog = catalog ?? createSessionCatalog(ctx)
  ctx.effect(
    () =>
      connection.fetch.register({
        path: RDM_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request: Request) => handleRdmApiRequest(kernel, request, activeCatalog),
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

/** Canonical `{code,message}` for one failed batch item. */
function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof KernelError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}

/** `true` when a task has not reached a terminal status yet. */
function isUnfinished(task: TaskView): boolean {
  return !TERMINAL_STATUSES.includes(task.status)
}

/** Unique non-empty owning-session ids of a task list (bounded by the catalog). */
function taskSessionIds(tasks: readonly TaskView[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    const sessionId = task.sessionId
    if (typeof sessionId !== 'string' || sessionId === '' || ids.includes(sessionId)) continue
    ids.push(sessionId)
  }
  return ids
}

/** Describe sessions through the catalog, degrading to empty labels on failure. */
async function describeSafely(
  catalog: HostApiCatalog | null,
  ids: readonly string[],
): Promise<SessionCatalogResult> {
  if (catalog === null) return { sessions: {}, workspaces: [] }
  try {
    const result = await catalog.describe(ids)
    const record = asRecord(result)
    if (record === null) return { sessions: {}, workspaces: [] }
    const sessions = asRecord(record.sessions)
    return {
      sessions: sessions === null ? {} : (sessions as Record<string, SessionMeta>),
      workspaces: Array.isArray(record.workspaces) ? (record.workspaces as WorkspaceMeta[]) : [],
    }
  } catch {
    // Catalog enrichment is advisory: `list` must keep polling every second.
    return { sessions: {}, workspaces: [] }
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Payload of a successful `list` (v3 adds the display catalog). */
interface ListValue {
  kernel: KernelStatusView
  tasks: TaskView[]
  aggregate: Aggregate
  sessions: Record<string, SessionMeta>
  workspaces: WorkspaceMeta[]
}

/** Payload of a successful `get`. */
interface GetValue {
  task: TaskView
  detail: TaskDetail
  events: TaskEvent[]
}

/** One per-id outcome of a `control` action. */
export interface ControlResultItem {
  id: string
  ok: boolean
  /** Resulting task; `null` for `remove` and for failed items. */
  task?: TaskView | null
  /** Failure detail when `ok` is false. */
  error?: { code: string; message: string }
  /** Whether the owning live agent was told this was a user action. */
  notified?: boolean
}

/** Payload of a successful `control` (batch `results` plus legacy fields). */
export interface ControlBatchValue {
  action: ControlAction
  results: ControlResultItem[]
  /** Legacy single-id compatibility: the resulting task. */
  task?: TaskView | null
  /** Legacy single-id compatibility: removed id for `remove`. */
  removedId?: string
  /** Legacy single-id compatibility: whether resume data was deleted. */
  deletePart?: boolean
}

/** Payload of a successful `open`. */
interface OpenValue {
  opened: true
  path: string
}

/**
 * `list`: kernel status, tasks, their aggregate and the display catalog.
 *
 * `sessionId` scopes the list to one agent session (the right-sidebar tab);
 * omitting it returns every session's tasks (the global review page). A kernel
 * that cannot start is reported through `kernel.error` with an empty task list
 * instead of failing the whole response, because the panel polls this action
 * every second. Catalog failures are equally non-fatal.
 */
async function listAction(
  kernel: KernelService,
  catalog: HostApiCatalog | null,
  body: Record<string, unknown>,
): Promise<ListValue> {
  const status = normalizeStatusFilter(body.status)
  const limit = clampInteger(body.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
  const sessionId = normalizeSessionId(body.sessionId)
  let tasks: TaskView[] = []
  let aggregate = normalizeAggregate(undefined)
  try {
    const result = await kernel.list({
      ...(status === undefined ? {} : { status }),
      ...(sessionId === null ? {} : { sessionId }),
      limit,
    })
    tasks = result.tasks
    aggregate = result.aggregate
  } catch {
    // A kernel that cannot start is reported through `kernel.error` (which the
    // panel renders); the poll loop must keep receiving a valid envelope.
  }
  const enrichment = await describeSafely(catalog, taskSessionIds(tasks))
  return {
    kernel: kernel.kernelStatus(),
    tasks,
    aggregate,
    sessions: enrichment.sessions,
    workspaces: enrichment.workspaces,
  }
}

/** `get`: one task plus its heavy detail and recent diagnostic events. */
async function getAction(kernel: KernelService, body: Record<string, unknown>): Promise<GetValue> {
  const taskId = normalizeTaskId(body.id ?? body.taskId, 'id')
  const events = clampInteger(body.events, DEFAULT_EVENTS, 0, ROUTE_MAX_EVENTS)
  return kernel.get(taskId, events)
}

/**
 * Read the pre-action task so a notice can name the file and session and only
 * fire when the task was still unfinished (design §4). Returns `null` when no
 * notice is requested or the task cannot be read; the control verb itself then
 * reports the real outcome.
 */
async function readTaskForNotice(
  kernel: KernelService,
  id: string,
  wanted: boolean,
): Promise<TaskView | null> {
  if (!wanted) return null
  try {
    const result = await kernel.get(id, 0)
    return result.task
  } catch {
    return null
  }
}

/** Sanitize a file name for one-line model-facing prose. */
function sanitizeName(fileName: string): string {
  if (typeof fileName !== 'string') return ''
  const text = fileName.replace(/[\r\n\t"]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) : text
}

/** Build the short agent notice for one user-initiated control action. */
function controlNotice(verb: 'pause' | 'cancel' | 'remove', task: TaskView): string {
  const name = sanitizeName(task.fileName)
  const label = name === '' ? 'an unnamed file' : `"${name}"`
  const action = verb === 'pause' ? 'paused' : verb === 'cancel' ? 'cancelled' : 'removed'
  const head =
    `[dsh-rdm] The user ${action} download ${task.id} (${label}) from the Downloads panel. ` +
    'This was a user action, not a failure.'
  if (verb === 'remove') {
    return `${head} The task record is gone, so start a new download if it is still wanted.`
  }
  return `${head} It can be resumed with rdm_control action=resume taskId=${task.id} if it is still wanted.`
}

/**
 * Notify the owning live agent after a successful control action.
 *
 * The pre-action record decides: only an unfinished task with a session id is
 * worth a notice, and only a live agent accepts one (a cold session is never
 * resumed just to read a UI click). Everything here is best-effort.
 */
async function notifyControl(
  catalog: HostApiCatalog | null,
  verb: 'pause' | 'cancel' | 'remove',
  pre: TaskView | null,
): Promise<boolean> {
  if (catalog === null || pre === null) return false
  const sessionId = pre.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (!isUnfinished(pre)) return false
  try {
    return (await catalog.notify(sessionId, controlNotice(verb, pre))) === true
  } catch {
    return false
  }
}

/**
 * Read the bounded id list of a `control` action.
 *
 * `ids` (1..100, duplicates collapsed) is the v3 form; a lone `id`/`taskId`
 * keeps older callers working. When both are present `ids` wins.
 */
function readControlIds(body: Record<string, unknown>): { ids: string[]; legacySingle: boolean } {
  const raw = body.ids
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new KernelError('invalid_request', 'ids must contain at least one task id')
    }
    if (raw.length > MAX_CONTROL_IDS) {
      throw new KernelError(
        'invalid_request',
        `ids accepts at most ${MAX_CONTROL_IDS} task ids per call (got ${raw.length})`,
      )
    }
    const ids: string[] = []
    for (const entry of raw) {
      const id = normalizeTaskId(entry, 'ids[]')
      if (!ids.includes(id)) ids.push(id)
    }
    return { ids, legacySingle: false }
  }
  const legacy = body.id ?? body.taskId
  if (legacy === undefined) {
    throw new KernelError(
      'invalid_request',
      'control needs "ids" (array of 1..100 task ids) or a single "id"',
    )
  }
  return { ids: [normalizeTaskId(legacy, 'id')], legacySingle: true }
}

/**
 * `control`: apply one verb to a bounded batch, sequentially, with one result
 * per id. A failing id never aborts the remaining ids.
 *
 * `pause`/`cancel`/`remove` notify the owning agent by default (design §4);
 * `notify:false` opts out. `remove` reads the task before deleting it so the
 * notice still carries the file name and session id.
 */
async function controlAction(
  kernel: KernelService,
  catalog: HostApiCatalog | null,
  body: Record<string, unknown>,
): Promise<ControlBatchValue> {
  // `control` is the panel's verb field; `op`/`command` are tolerated aliases
  // so an older client cannot silently no-op.
  const verb = normalizeControlAction(body.control ?? body.op ?? body.command)
  const { ids, legacySingle } = readControlIds(body)
  const deletePart = body.deletePart === true
  const notifyWanted = NOTIFY_ACTIONS.has(verb) && body.notify !== false
  const results: ControlResultItem[] = []
  for (const id of ids) {
    const pre = await readTaskForNotice(kernel, id, notifyWanted)
    try {
      const task = await kernel.control(id, verb, deletePart)
      const notified = await notifyControl(
        catalog,
        verb as 'pause' | 'cancel' | 'remove',
        notifyWanted ? pre : null,
      )
      results.push({
        id,
        ok: true,
        task: task ?? null,
        ...(notifyWanted ? { notified } : {}),
      })
    } catch (error) {
      results.push({ id, ok: false, task: null, error: errorPayload(error) })
    }
  }
  const value: ControlBatchValue = { action: verb, results }
  if (legacySingle) {
    // Keep the pre-v3 single-id envelope shape: `{action, task, deletePart}`
    // (plus `removedId` for remove) alongside the new `results` array.
    const first = results[0]
    value.task = first !== undefined && first.ok === true ? (first.task ?? null) : null
    if (verb === 'remove') {
      value.deletePart = deletePart
      if (first !== undefined && first.ok === true) value.removedId = first.id
    }
  }
  return value
}

/**
 * `open`: resolve a task's file/folder on the host and launch the desktop
 * opener. Only a task id and the two fixed targets are accepted, so a browser
 * can never hand an arbitrary path to the shell.
 */
async function openAction(
  kernel: KernelService,
  catalog: HostApiCatalog | null,
  body: Record<string, unknown>,
): Promise<OpenValue> {
  const taskId = normalizeTaskId(body.id ?? body.taskId, 'id')
  const target = body.target
  if (target !== 'file' && target !== 'folder') {
    throw new KernelError('invalid_request', 'target must be "file" or "folder"')
  }
  if (catalog === null) {
    throw new KernelError('unsupported', 'the host catalog is unavailable, so open is not supported')
  }
  const result = await kernel.get(taskId, 0)
  const path = resolveTaskOpenPath(result.task, target)
  if (path === null) {
    throw new KernelError(
      'not_found',
      `Task "${taskId}" has no ${target === 'file' ? 'file path' : 'folder'} to open yet.`,
    )
  }
  const opened = await catalog.openPath(path, target)
  if (opened.opened !== true) {
    throw new KernelError(
      opened.code ?? 'io',
      opened.error ?? 'the desktop opener did not accept the path',
    )
  }
  return { opened: true, path }
}

/** Actions the dispatcher understands. */
const ACTIONS = new Set(['list', 'get', 'start', 'control', 'stats', 'open'])

/**
 * Handle one `POST /api/dsh-rdm/api` request.
 *
 * Exported for tests: the fetch registration above is the only production
 * caller. The catalog is optional so a unit test can exercise kernel behavior
 * without a Harness context.
 *
 * @param kernel - The shared kernel service.
 * @param request - The incoming buffered HTTP request.
 * @param catalog - Session/workspace catalog and desktop helpers (optional).
 * @returns JSON envelope response (always HTTP 200).
 */
export async function handleRdmApiRequest(
  kernel: KernelService,
  request: Request,
  catalog: HostApiCatalog | null = null,
): Promise<Response> {
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
        return okResponse(await listAction(kernel, catalog, record))
      case 'get':
        return okResponse(await getAction(kernel, record))
      case 'start': {
        // The workbench composer uses this action; programmatic callers and tests may too.
        const task = await kernel.start(normalizeRequestSpec(record))
        return okResponse({ task })
      }
      case 'control':
        return okResponse(await controlAction(kernel, catalog, record))
      case 'open':
        return okResponse(await openAction(kernel, catalog, record))
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

