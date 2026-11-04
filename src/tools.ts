/**
 * Model-facing tool surface of `dsh-rdm`.
 *
 * Five tools drive the resident RDM kernel through {@link KernelService}:
 * `rdm_download`, `rdm_probe`, `rdm_tasks`, `rdm_wait`, `rdm_control`.
 *
 * Conventions (same as other first-party tools):
 *  - parameters are schema-validated before `execute` runs;
 *  - `execute` returns one canonical JSON value, `render` is a pure text
 *    projection of that value;
 *  - `exec.signal` is checked before any work and forwarded to long requests;
 *  - canonical values are bounded (one task view, at most 20 events).
 *
 * @module dsh-rdm/tools
 */

import { defineTool } from './tool-def'
import type { ToolDefinition, ToolRunContext } from './tool-def'

import { KernelError, normalizeStatusFilter, normalizeTaskId } from './kernel-client'
import type { KernelService } from './kernel-client'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_WAIT_MS,
  MAX_LIST_LIMIT,
  MAX_TASK_IDS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  TASK_STATUSES,
  TOOL_MAX_EVENTS,
  type ControlAction,
  type KernelStatusView,
  type TaskEvent,
  type TaskView,
} from './protocol'

// ── Description fragments ───────────────────────────────────────────────────

/**
 * The download-routing policy every rdm_* description repeats: the model must
 * reach for these tools instead of shell downloaders. Keep this sentence
 * literal — it is the reason the plugin exists.
 */
const RDM_POLICY =
  'Use the rdm_* tools for EVERY file download instead of bash/curl/wget/PowerShell downloads: ' +
  'they drive the resident RDM download kernel, which stays warm between calls and provides ' +
  'multi-connection segmented transfers, resumable and pausable downloads, retries with backoff, ' +
  'bandwidth limits and optional SHA-256 verification. Use bash (curl/wget) only if the user ' +
  'explicitly demands a shell download.'

/** Bounded-canonical-value note shared by the list-style tools. */
const BOUNDED_NOTE = 'Results are bounded: one task view per task and at most 20 diagnostic events.'

// ── Bounded formatting helpers (pure; used by render only) ──────────────────

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/** Format a byte count compactly (`23.4 MiB`); `?` when unknown. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rendered = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  return `${rendered} ${BYTE_UNITS[unit]}`
}

/** Format a transfer rate (`8.2 MiB/s`). */
function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Format an ETA (`42s`, `3m12s`, `1h04m`). */
function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '?'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
}

/** Format progress as a whole percentage (`46%`); `?` when total is unknown. */
function formatPercent(downloaded: number, total: number | null): string {
  if (total === null || total <= 0) return '?'
  return `${Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)))}%`
}

/** One compact progress line for a task. */
function taskSummary(task: TaskView): string {
  const parts: string[] = [`${task.id} ${task.status}`]
  if (task.total !== null && task.total > 0) parts.push(formatPercent(task.downloaded, task.total))
  parts.push(`${formatBytes(task.downloaded)} / ${task.total === null ? '?' : formatBytes(task.total)}`)
  if (task.speedBps > 0) parts.push(formatSpeed(task.speedBps))
  if (task.activeWorkers > 0) parts.push(`${task.activeWorkers}w`)
  if (task.etaSecs !== null && task.speedBps > 0 && task.status === 'running') {
    parts.push(`eta ${formatEta(task.etaSecs)}`)
  }
  return parts.join(' · ')
}

/** Where a task writes: resolved path, else directory, else the URL. */
function taskTarget(task: TaskView): string {
  if (task.path !== null && task.path !== '') return task.path
  if (task.dir !== '') return `${task.fileName !== '' ? task.fileName : '(file)'} → ${task.dir}`
  return task.fileName !== '' ? task.fileName : task.url
}

/** A one-line failure description, or '' when the task has no error. */
function taskFailure(task: TaskView): string {
  if (task.error === null) return ''
  return `${task.error.code}: ${task.error.message}`
}

/** One line for the kernel process. */
function kernelSummary(kernel: KernelStatusView): string {
  const parts: string[] = [kernel.running ? 'kernel running' : 'kernel stopped']
  if (kernel.version !== null) parts.push(`v${kernel.version}`)
  if (kernel.pid !== null) parts.push(`pid ${kernel.pid}`)
  if (kernel.starting) parts.push('starting')
  if (kernel.error !== null) parts.push(`error: ${kernel.error}`)
  return parts.join(' · ')
}

/** One line for a diagnostic task event. */
function eventSummary(event: TaskEvent): string {
  const detail = event.message === null || event.message === '' ? '' : `: ${event.message}`
  return `#${event.seq} ${event.at > 0 ? new Date(event.at).toISOString().slice(11, 19) + ' ' : ''}${event.kind}${detail}`
}

// ── Error mapping ───────────────────────────────────────────────────────────

/** Actionable follow-up per kernel error code. */
const ERROR_HINTS: Record<string, string> = {
  kernel_missing:
    'Build the kernel with "node scripts/build-kernel.mjs" (kernel/ directory) or set the plugin config "kernelPath", then retry.',
  kernel_spawn: 'The kernel process could not start; check the binary path/permissions for this platform.',
  kernel_exited:
    'The kernel child exited; the plugin restarts it on the next call. Interrupted tasks keep their resume state — re-check with rdm_tasks before starting over.',
  kernel_crashed:
    'The kernel is crashing repeatedly. Inspect its stderr log or rebuild it; do not keep retrying blindly.',
  kernel_stopped: 'The plugin is unloading/reloading; retry after it registers rdm_* again.',
  kernel_not_running: 'The kernel child is not ready yet; retry in a moment.',
  timeout:
    'The kernel is still busy. Check progress with rdm_tasks (taskId=...) and rdm_wait instead of resubmitting the same download.',
  cancelled: 'The call was cancelled; nothing else was changed.',
  invalid_request: 'Fix the arguments and retry; no task was created.',
  not_found: 'Use rdm_tasks (without taskId) to list the existing task ids.',
  conflict: 'That action is not valid for the current status; re-check the task with rdm_tasks.',
  http_status: 'The origin rejected the request; verify the URL and any cookie/headers/auth values.',
  network: 'Network/DNS/TLS failure after retries; check connectivity, the URL, or the proxy setting.',
  remote_changed:
    'The remote file changed during resume. Use rdm_control action=retry (restarts from zero), then download again.',
  checksum_mismatch:
    'The downloaded bytes did not match expectedSha256, so the file was not finalized. Verify the hash value or retry the download.',
  io: 'Local filesystem error; check that the destination directory exists and is writable.',
  unsupported: 'The kernel cannot honor this request; simplify the parameters (for example drop singleStream/insecure).',
  internal: 'Unexpected kernel error; retry once, then report it to the user with the kernel stderr tail.',
}

/** Map any thrown error to a model-facing, actionable message. */
function toActionableError(error: unknown): Error {
  if (error instanceof KernelError) {
    const hint = ERROR_HINTS[error.code]
    const suffix = hint === undefined ? '' : ` ${hint}`
    return new Error(`[${error.code}] ${error.message}${suffix}`)
  }
  if (error instanceof Error) return error
  return new Error(String(error))
}

/** Run one tool body, converting kernel errors into actionable messages. */
async function runTool<Value>(body: () => Promise<Value>): Promise<Value> {
  try {
    return await body()
  } catch (error) {
    throw toActionableError(error)
  }
}

// ── Schema helpers (the defineTool output DSL) ──────────────────────────────

type SchemaNode = Record<string, any>

/** Object node: the DSL requires an explicit `additionalProperties`. */
function objectNode(properties: Record<string, SchemaNode>, additionalProperties = false): SchemaNode {
  return { type: 'object', additionalProperties, properties }
}

/** Nullable scalar/one-of node. */
function nullableNode(node: SchemaNode, description?: string): SchemaNode {
  const result: SchemaNode = { oneOf: [node, { type: 'null' }] }
  if (description !== undefined) result.description = description
  return result
}

/** Array node with one item schema. */
function arrayNode(items: SchemaNode, description?: string): SchemaNode {
  const result: SchemaNode = { type: 'array', items }
  if (description !== undefined) result.description = description
  return result
}

/** The kernel task view, normalized so every field is always present. */
const TASK_SCHEMA: SchemaNode = objectNode({
  id: { type: 'string', required: true, description: 'Task id, e.g. "t_9f3a1c2d5e6b7a80".' },
  url: { type: 'string', required: true, description: 'Requested URL.' },
  finalUrl: nullableNode({ type: 'string' }, 'Final URL after redirects; null until probed.'),
  fileName: { type: 'string', required: true },
  dir: { type: 'string', required: true },
  path: nullableNode({ type: 'string' }, 'Absolute target path; null until resolved.'),
  status: {
    type: 'string',
    required: true,
    enum: [...TASK_STATUSES],
    description: 'queued|probing|running|paused|completed|failed|cancelled|interrupted.',
  },
  downloaded: { type: 'number', required: true, description: 'Bytes written to the .part file.' },
  total: nullableNode({ type: 'number' }, 'Total bytes; null until known.'),
  speedBps: { type: 'number', required: true, description: 'Current transfer rate in bytes/second (0 when idle).' },
  etaSecs: nullableNode({ type: 'number' }, 'Estimated seconds remaining.'),
  activeWorkers: { type: 'number', required: true },
  peakWorkers: { type: 'number', required: true },
  connections: { type: 'number', required: true, description: 'Planned connection cap.' },
  chunkSize: nullableNode({ type: 'number' }, 'Chunk size in bytes; null for single-stream transfers.'),
  resumedChunks: { type: 'number', required: true },
  rangeSupported: nullableNode({ type: 'boolean' }, 'Whether the origin supports range requests; null until probed.'),
  expectedSha256: nullableNode({ type: 'string' }),
  sha256: nullableNode({ type: 'string' }, 'Actual SHA-256 once verified.'),
  error: nullableNode(
    objectNode({
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
    }),
    'Failure detail: {code,message}.',
  ),
  retries: { type: 'number', required: true },
  createdAt: { type: 'number', required: true, description: 'Milliseconds since epoch.' },
  startedAt: nullableNode({ type: 'number' }),
  finishedAt: nullableNode({ type: 'number' }),
  elapsedMs: { type: 'number', required: true },
  resumable: { type: 'boolean', required: true },
})

/** Kernel process status included by `rdm_tasks`. */
const KERNEL_SCHEMA: SchemaNode = objectNode({
  running: { type: 'boolean', required: true },
  starting: { type: 'boolean', required: true },
  version: nullableNode({ type: 'string' }),
  pid: nullableNode({ type: 'number' }),
  dataDir: { type: 'string', required: true },
  error: nullableNode({ type: 'string' }, 'Last spawn/exit/protocol failure, if any.'),
})

/** One diagnostic task event. */
const EVENT_SCHEMA: SchemaNode = objectNode({
  seq: { type: 'number', required: true },
  at: { type: 'number', required: true },
  kind: { type: 'string', required: true, enum: ['info', 'probe', 'plan', 'started', 'retry', 'controller', 'paused', 'resumed', 'verify', 'completed', 'failed', 'cancelled'] },
  message: nullableNode({ type: 'string' }),
  chunk: nullableNode({ type: 'number' }),
  attempt: nullableNode({ type: 'number' }),
  delayMs: nullableNode({ type: 'number' }),
})

// ── Argument / value types ──────────────────────────────────────────────────

interface DownloadArgs {
  url: string
  dir?: string
  fileName?: string
  connections?: number
  headers?: unknown
  cookie?: string
  referer?: string
  userAgent?: string
  expectedSha256?: string
  speedLimitBps?: number
  resume?: boolean
  singleStream?: boolean
  proxy?: string
  insecure?: boolean
  waitSec?: number
}

interface DownloadValue {
  task: TaskView
  waited: boolean
  timedOut: boolean
  hint: string
}

interface ProbeArgs {
  url: string
  headers?: unknown
  cookie?: string
  referer?: string
  userAgent?: string
}

interface ProbeValue {
  meta: {
    finalUrl: string
    fileName: string
    totalBytes: number | null
    supportsRanges: boolean
    contentType: string | null
    etag: string | null
    lastModified: string | null
    httpVersion: string | null
  }
}

interface TasksArgs {
  taskId?: string
  status?: string
  limit?: number
  events?: number
}

interface TasksValue {
  kernel: KernelStatusView
  tasks: TaskView[]
  events: TaskEvent[]
}

interface WaitArgs {
  taskIds: string[]
  timeoutSec?: number
}

interface WaitValue {
  tasks: TaskView[]
  timedOut: boolean
}

interface ControlArgs {
  taskId: string
  action: ControlAction
  deletePart?: boolean
}

interface ControlValue {
  action: ControlAction
  task: TaskView | null
  removedId: string | null
  deletePart: boolean
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Clamp a finite number into an integer range (undefined -> fallback). */
function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/** Build the follow-up hint returned by `rdm_download`. */
function downloadHint(task: TaskView, waited: boolean, timedOut: boolean, waitSec: number): string {
  const taskId = task.id
  if (!waited) {
    return `Started in the resident RDM kernel. Follow it with rdm_tasks (taskId=${taskId}) or rdm_wait (taskIds=["${taskId}"]).`
  }
  if (timedOut) {
    return `Still ${task.status} after ${waitSec}s. Keep following with rdm_wait (taskIds=["${taskId}"]) or rdm_tasks.`
  }
  if (task.status === 'completed') {
    return task.sha256 === null
      ? 'Completed.'
      : 'Completed and SHA-256 verified.'
  }
  if (task.status === 'failed') {
    const failure = taskFailure(task)
    return `Failed${failure === '' ? '' : ` (${failure})`}. Inspect events with rdm_tasks taskId=${taskId}; retry with rdm_control action=retry.`
  }
  return `Settled as ${task.status}.`
}

// ── Tool definitions ────────────────────────────────────────────────────────

/**
 * Build the five model-facing tool definitions bound to one kernel service.
 * Exported separately from {@link registerRdmTools} so tests and docs can
 * inspect the surface without a host context.
 */
export function createRdmTools(kernel: KernelService): ToolDefinition<any, any>[] {
  return [
    defineTool<DownloadArgs, DownloadValue>({
      name: 'rdm_download',
      description:
        'Start an HTTP(S) file download in the resident RDM kernel and return its task view. ' +
        'By default it returns immediately with a task id (status queued/probing); pass waitSec>0 ' +
        '(max 300) to block until the download finishes. The download continues in the background ' +
        'and is resumable/pausable via rdm_control. ' +
        RDM_POLICY,
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL to download.' },
        dir: {
          type: 'string',
          description: 'Absolute destination directory (default: plugin defaultDir, then the DSH host cwd).',
        },
        fileName: { type: 'string', description: 'Optional output file-name override (sanitized by the kernel).' },
        connections: {
          type: 'number',
          description: 'Parallel connections 1..32 (default: plugin config, normally 8).',
        },
        headers: {
          type: 'json',
          description: 'Optional JSON object of extra request headers, e.g. {"Authorization":"Bearer ..."}.',
        },
        cookie: { type: 'string', description: 'Optional Cookie header value, e.g. "a=1; b=2".' },
        referer: { type: 'string', description: 'Optional Referer header value.' },
        userAgent: { type: 'string', description: 'Optional User-Agent override.' },
        expectedSha256: {
          type: 'string',
          description: 'Optional 64-hex SHA-256; the kernel verifies it before finalizing the file.',
        },
        speedLimitBps: {
          type: 'number',
          description: 'Optional per-task bandwidth cap in bytes/second (0 or omitted = unlimited).',
        },
        resume: { type: 'boolean', description: 'Resume from existing .part state (default true).' },
        singleStream: {
          type: 'boolean',
          description: 'Force one rangeless GET (no segmentation); useful for broken origins.',
        },
        proxy: { type: 'string', description: 'Optional HTTP proxy URL, e.g. http://127.0.0.1:7890.' },
        insecure: { type: 'boolean', description: 'Accept invalid TLS certificates (debug only).' },
        waitSec: {
          type: 'number',
          description: 'Wait up to this many seconds (0..300) for completion before returning; default 0 = return immediately.',
        },
      },
      output: {
        schema: objectNode({
          task: { ...TASK_SCHEMA, required: true, description: 'The created download task.' },
          waited: { type: 'boolean', required: true, description: 'Whether the call waited for completion.' },
          timedOut: { type: 'boolean', required: true, description: 'True when waitSec expired before the task settled.' },
          hint: { type: 'string', required: true, description: 'Follow-up suggestion.' },
        }),
        render: (_args, value) => {
          const lines = [taskSummary(value.task), taskTarget(value.task), value.hint]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const waitSec = clampInteger(args.waitSec, 0, 0, Math.floor(MAX_WAIT_MS / 1000))
          let task = await kernel.start(
            {
              url: args.url,
              ...(args.dir === undefined ? {} : { dir: args.dir }),
              ...(args.fileName === undefined ? {} : { fileName: args.fileName }),
              ...(args.connections === undefined ? {} : { connections: args.connections }),
              ...(args.headers === undefined ? {} : { headers: args.headers as Record<string, string> }),
              ...(args.cookie === undefined ? {} : { cookie: args.cookie }),
              ...(args.referer === undefined ? {} : { referer: args.referer }),
              ...(args.userAgent === undefined ? {} : { userAgent: args.userAgent }),
              ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
              ...(args.speedLimitBps === undefined ? {} : { speedLimitBps: args.speedLimitBps }),
              ...(args.resume === undefined ? {} : { resume: args.resume }),
              ...(args.singleStream === undefined ? {} : { singleStream: args.singleStream }),
              ...(args.proxy === undefined ? {} : { proxy: args.proxy }),
              ...(args.insecure === undefined ? {} : { insecure: args.insecure }),
            },
            exec.signal,
          )
          let waited = waitSec > 0
          let timedOut = false
          if (waited) {
            const result = await kernel.wait([task.id], waitSec * 1000, exec.signal)
            timedOut = result.timedOut
            const settled = result.tasks[0]
            if (settled !== undefined) task = settled
          }
          return { task, waited, timedOut, hint: downloadHint(task, waited, timedOut, waitSec) }
        }),
    }),

    defineTool<ProbeArgs, ProbeValue>({
      name: 'rdm_probe',
      description:
        'Inspect an HTTP(S) URL without downloading the body: final URL after redirects, derived file name, ' +
        'total size, content type and whether the server supports range requests (what multi-connection and ' +
        'resume need). Use it before rdm_download when the user asks how large a file is, whether a link is ' +
        'valid, or what it will be saved as; use it instead of "curl -I"/"wget --spider". ' +
        RDM_POLICY,
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL to inspect.' },
        headers: {
          type: 'json',
          description: 'Optional JSON object of extra request headers, e.g. {"Authorization":"Bearer ..."}.',
        },
        cookie: { type: 'string', description: 'Optional Cookie header value.' },
        referer: { type: 'string', description: 'Optional Referer header value.' },
        userAgent: { type: 'string', description: 'Optional User-Agent override.' },
      },
      output: {
        schema: objectNode({
          meta: {
            required: true,
            ...objectNode({
              finalUrl: { type: 'string', required: true },
              fileName: { type: 'string', required: true },
              totalBytes: nullableNode({ type: 'number' }, 'Content length; null when unknown.'),
              supportsRanges: { type: 'boolean', required: true, description: 'Range/multi-connection support.' },
              contentType: nullableNode({ type: 'string' }),
              etag: nullableNode({ type: 'string' }),
              lastModified: nullableNode({ type: 'string' }),
              httpVersion: nullableNode({ type: 'string' }),
            }),
            description: 'Probe metadata.',
          },
        }),
        render: (_args, value) => {
          const meta = value.meta
          const size = meta.totalBytes === null ? 'unknown size' : formatBytes(meta.totalBytes)
          const ranges = meta.supportsRanges ? 'ranges supported' : 'no range support (single stream only)'
          const lines = [
            `${meta.fileName !== '' ? meta.fileName : '(no file name)'} · ${size} · ${meta.contentType ?? 'unknown type'} · ${ranges}`,
            meta.finalUrl,
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const meta = await kernel.probe(
            args.url,
            {
              ...(args.headers === undefined ? {} : { headers: args.headers as Record<string, string> }),
              ...(args.cookie === undefined ? {} : { cookie: args.cookie }),
              ...(args.referer === undefined ? {} : { referer: args.referer }),
              ...(args.userAgent === undefined ? {} : { userAgent: args.userAgent }),
            },
            exec.signal,
          )
          return { meta }
        }),
    }),

    defineTool<TasksArgs, TasksValue>({
      name: 'rdm_tasks',
      description:
        'Read download state from the resident RDM kernel: kernel status (running, version, pid, error) ' +
        'plus tasks, or one task with its recent diagnostic events when taskId is given. ' +
        'Task state is authoritative; events are diagnostic only. Use it to check progress, find a task id, ' +
        'or explain a failure. ' +
        BOUNDED_NOTE +
        ' ' +
        RDM_POLICY,
      parameters: {
        taskId: {
          type: 'string',
          description: 'Task id to inspect (returns the task plus recent events). Omit to list tasks.',
        },
        status: {
          type: 'string',
          description: `Optional status filter: ${TASK_STATUSES.join('|')} (comma-separate for several).`,
        },
        limit: {
          type: 'number',
          description: `Max tasks to list (1..${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT}).`,
        },
        events: {
          type: 'number',
          description: 'With taskId: how many recent diagnostic events to return (0..20, default 5).',
        },
      },
      output: {
        schema: objectNode({
          kernel: { ...KERNEL_SCHEMA, required: true, description: 'Kernel process status.' },
          tasks: arrayNode({ ...TASK_SCHEMA }, 'Matching tasks (newest first).'),
          events: arrayNode({ ...EVENT_SCHEMA }, 'Recent events for taskId (empty otherwise).'),
        }),
        render: (_args, value) => {
          const lines: string[] = [kernelSummary(value.kernel)]
          const shown = value.tasks.slice(0, 10)
          for (const task of shown) {
            const failure = taskFailure(task)
            lines.push(failure === '' ? taskSummary(task) : `${taskSummary(task)} · ${failure}`)
          }
          if (value.tasks.length > shown.length) {
            lines.push(`…and ${value.tasks.length - shown.length} more task(s); pass taskId or a status filter.`)
          }
          if (value.events.length > 0) {
            lines.push('recent events:')
            for (const event of value.events.slice(0, 5)) lines.push(eventSummary(event))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          if (args.taskId !== undefined && args.taskId.trim() !== '') {
            const taskId = normalizeTaskId(args.taskId)
            const events = clampInteger(args.events, 5, 0, TOOL_MAX_EVENTS)
            const result = await kernel.get(taskId, events, exec.signal)
            // Report the status AFTER the call: the first request may have lazily
            // started the kernel, so the pre-call view would be stale.
            return { kernel: kernel.kernelStatus(), tasks: [result.task], events: result.events }
          }
          const status = normalizeStatusFilter(args.status)
          const limit = clampInteger(args.limit, 20, 1, 50)
          const tasks = await kernel.list(status, limit, exec.signal)
          return { kernel: kernel.kernelStatus(), tasks, events: [] }
        }),
    }),

    defineTool<WaitArgs, WaitValue>({
      name: 'rdm_wait',
      description:
        'Wait until every given download task is terminal (completed/failed/cancelled) or the timeout ' +
        'expires (max 300 s), then return the final task views and timedOut. Prefer this to polling ' +
        'rdm_tasks in a bash loop. ' +
        RDM_POLICY,
      parameters: {
        taskIds: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: `Task ids to wait for (1..${MAX_TASK_IDS}).`,
        },
        timeoutSec: {
          type: 'number',
          description: 'Timeout in seconds (1..300, default 60).',
        },
      },
      output: {
        schema: objectNode({
          tasks: arrayNode({ ...TASK_SCHEMA }, 'Final task views.'),
          timedOut: {
            type: 'boolean',
            required: true,
            description: 'True when the timeout expired before every task settled.',
          },
        }),
        render: (_args, value) => {
          const settled = value.tasks.filter((task) => task.status !== 'running' && task.status !== 'queued' && task.status !== 'probing').length
          const lines: string[] = [
            value.timedOut
              ? `Timed out: ${settled}/${value.tasks.length} task(s) settled.`
              : `All ${value.tasks.length} task(s) settled.`,
          ]
          for (const task of value.tasks.slice(0, 8)) lines.push(taskSummary(task))
          if (value.tasks.length > 8) lines.push(`…and ${value.tasks.length - 8} more.`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const timeoutSec = clampInteger(
            args.timeoutSec,
            Math.floor(DEFAULT_WAIT_MS / 1000),
            Math.ceil(MIN_WAIT_MS / 1000),
            Math.floor(MAX_WAIT_MS / 1000),
          )
          const result = await kernel.wait(args.taskIds, timeoutSec * 1000, exec.signal)
          return { tasks: result.tasks, timedOut: result.timedOut }
        }),
    }),

    defineTool<ControlArgs, ControlValue>({
      name: 'rdm_control',
      description:
        'Control an existing download task in the resident RDM kernel: pause (cooperative stop, resume ' +
        'state kept), resume (continue paused/interrupted/cancelled/failed tasks when .part state exists, ' +
        'otherwise restart), cancel (stop, keep .part), retry (discard .part and start over) or remove ' +
        '(delete the task record; deletePart also deletes .part resume data, never the finished file). ' +
        'Find the task id with rdm_tasks first. ' +
        RDM_POLICY,
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id, e.g. "t_9f3a1c2d5e6b7a80".' },
        action: {
          type: 'string',
          required: true,
          enum: ['pause', 'resume', 'cancel', 'retry', 'remove'],
          description: 'pause|resume|cancel|retry|remove.',
        },
        deletePart: {
          type: 'boolean',
          description: 'For action=remove only: also delete .part resume data (never the completed file).',
        },
      },
      output: {
        schema: objectNode({
          action: { type: 'string', required: true, enum: ['pause', 'resume', 'cancel', 'retry', 'remove'] },
          task: nullableNode({ ...TASK_SCHEMA }, 'Task after the control action; null for remove.'),
          removedId: nullableNode({ type: 'string' }, 'Removed task id (only for action=remove).'),
          deletePart: {
            type: 'boolean',
            required: true,
            description: 'Whether remove also deleted .part resume data.',
          },
        }),
        render: (_args, value) => {
          if (value.action === 'remove') {
            return [
              {
                type: 'text',
                text: `Removed task ${value.removedId ?? '?'}${value.deletePart ? ' and its .part resume data' : ' (task record only)'}.`,
              },
            ]
          }
          if (value.task === null) {
            return [{ type: 'text', text: `${value.action}: the kernel returned no task.` }]
          }
          return [
            {
              type: 'text',
              text: `${value.action} → ${taskSummary(value.task)}\n${taskTarget(value.task)}`,
            },
          ]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const deletePart = args.deletePart === true
          const task = await kernel.control(args.taskId, args.action, deletePart, exec.signal)
          return {
            action: args.action,
            task,
            removedId: args.action === 'remove' ? args.taskId : null,
            deletePart: args.action === 'remove' && deletePart,
          }
        }),
    }),
  ]
}

/**
 * Register the five `rdm_*` tools on the host tool registry.
 *
 * @param ctx - Host plugin context (must provide `ctx.tools`).
 * @param kernel - The shared kernel service.
 */
export function registerRdmTools(ctx: HostContext, kernel: KernelService): void {
  for (const tool of createRdmTools(kernel)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-rdm: tool ${tool.name}`)
  }
}
