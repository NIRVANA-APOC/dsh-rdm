/**
 * `KernelService` — the single owner of the resident `rdm-kernel` child process.
 *
 * One operation, two callers: the model-facing tools (`tools.ts`) and the
 * browser route (`host-api.ts`) both go through this class, so validation,
 * error mapping and task normalization cannot drift apart.
 *
 * Responsibilities:
 *  - lazy spawn of `bin/<platform>-<arch>/rdm-kernel[.exe]` on first use;
 *  - newline-delimited JSON request/response over stdio (ids, pending map,
 *    per-method timeouts, abort support);
 *  - notification handling (`ready`, `task`) into a bounded task mirror;
 *  - crash detection with rejection of pending requests and exponential
 *    backoff for the next spawn (bounded rapid-restart counter);
 *  - graceful shutdown from the plugin's `ctx.effect` disposer.
 *
 * @module dsh-rdm/kernel-client
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONTROL_ACTIONS,
  DEFAULT_CONNECTIONS,
  DEFAULT_EVENTS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WAIT_MS,
  MAX_CHUNK_BYTES,
  MAX_CONNECTIONS,
  MAX_EVENTS,
  MAX_LIST_LIMIT,
  MAX_TASK_IDS,
  MAX_WAIT_MS,
  MIB,
  MIN_CHUNK_BYTES,
  MIN_CONNECTIONS,
  MIN_WAIT_MS,
  PROTOCOL_VERSION,
  TASK_EVENT_KINDS,
  TASK_STATUSES,
  type ControlAction,
  type ControlParams,
  type ControlResult,
  type GetResult,
  type InitializeConfig,
  type InitializeParams,
  type InitializeResult,
  type KernelInfo,
  type KernelRequest,
  type KernelStatusView,
  type ListParams,
  type ListResult,
  type Meta,
  type ProbeParams,
  type ProbeResult,
  type RequestSpec,
  type StartResult,
  type StatsResult,
  type TaskCounts,
  type TaskEvent,
  type TaskEventKind,
  type TaskStatus,
  type TaskView,
  type WaitParams,
  type WaitResult,
} from './protocol'
import type { ResolvedRdmConfig } from './config'

// ── Tuning constants ────────────────────────────────────────────────────────

/** Hard cap for one NDJSON line on the kernel's stdout. */
const MAX_LINE_LENGTH = 8 * 1024 * 1024
/** Cap on the buffered partial stderr line. */
const MAX_STDERR_BUFFER = 64 * 1024
/** Bounded stderr ring used for crash diagnostics. */
const STDERR_RING_LINES = 50
/** Bounded in-memory task mirror fed by `task` notifications. */
const MAX_TASK_MIRROR = 500
/** A kernel that stayed ready this long resets the rapid-crash counter. */
const STABLE_UPTIME_MS = 10_000

/** Timings; tests may override every entry through {@link KernelServiceOptions}. */
export interface KernelTimings {
  /** How long to wait for the `ready` notification after spawn. */
  readyTimeoutMs: number
  /** Per-method request timeouts. */
  requestTimeouts: Record<string, number>
  /** Extra allowance on top of a `wait` request's own timeout. */
  waitGraceMs: number
  /** Grace after `shutdown`/stdin EOF before SIGKILL. */
  stopGraceMs: number
  /** A rapid-crash block lifts after this long without a restart attempt. */
  restartCooldownMs: number
  /** Consecutive rapid crashes tolerated before backing off hard. */
  maxRapidRestarts: number
}

/** Default request timings (probe is generous: a slow origin may need it). */
const DEFAULT_TIMINGS: KernelTimings = {
  readyTimeoutMs: 30_000,
  requestTimeouts: {
    initialize: 30_000,
    probe: 120_000,
    start: 30_000,
    list: 30_000,
    get: 30_000,
    control: 30_000,
    stats: 30_000,
    shutdown: 5_000,
  },
  waitGraceMs: 15_000,
  stopGraceMs: 3_000,
  restartCooldownMs: 30_000,
  maxRapidRestarts: 3,
}

/** One log sink; every entry is optional at the call site. */
export interface KernelLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Options accepted by {@link KernelService}. */
export interface KernelServiceOptions {
  /** Resolved plugin config (see `config.ts`). */
  config: ResolvedRdmConfig
  /**
   * Package root that owns `bin/` and `package.json`. Defaults to the parent
   * directory of the compiled `lib/index.js`, which also equals the package
   * root when the sources are executed directly.
   */
  packageRoot?: string
  /** Logger adapter; a DSH context logger or `console`-style object/function. */
  logger?: unknown
  /** Environment used for `$DSH_HOME` resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Timing overrides (tests use short values; production keeps defaults). */
  timings?: Partial<KernelTimings>
}

/** Options shared by `probe`. */
export interface ProbeOptions {
  headers?: Record<string, string>
  cookie?: string
  referer?: string
  userAgent?: string
  proxy?: string
  insecure?: boolean
  timeoutMs?: number
}

/** Error raised for every kernel/protocol/validation failure. */
export class KernelError extends Error {
  /** Stable machine-readable code (`not_found`, `timeout`, `kernel_missing`, ...). */
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KernelError'
    this.code = code
  }
}

// ── Small utilities ─────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

/** Create a deferred whose unobserved rejection never crashes the host. */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // A kernel exit/timeout race can leave the loser unobserved; keep it quiet.
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** `setTimeout` handle as returned by the current runtime. */
type TimerHandle = ReturnType<typeof setTimeout>

/** Resolve after `ms`. The timer is deliberately ref'd: a restart backoff must
 * keep the process alive, otherwise an idle host would exit mid-backoff. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Race a promise against a timeout that rejects with a {@link KernelError}. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(onTimeout())
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Wait (bounded) for a child to exit; returns whether it did. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: TimerHandle | undefined
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

/** Narrow an unknown value to a plain JSON object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Coerce to a finite number, else fall back. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Coerce to a non-negative integer, else fall back. */
function uint(value: unknown, fallback: number): number {
  const raw = num(value, fallback)
  return raw >= 0 ? Math.round(raw) : fallback
}

/** Coerce to a finite number or null. */
function maybeNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Coerce to a string, else fall back. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerce to a string or null. */
function maybeStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Coerce to a boolean, else fall back. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce to a boolean or null. */
function maybeBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Clamp a finite number into an integer range. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Render one error safely for a log line. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── Logging adapter ─────────────────────────────────────────────────────────

const CONSOLE_LOGGER: KernelLogger = {
  debug: (message) => console.debug(`[dsh-rdm] ${message}`),
  info: (message) => console.info(`[dsh-rdm] ${message}`),
  warn: (message) => console.warn(`[dsh-rdm] ${message}`),
  error: (message) => console.error(`[dsh-rdm] ${message}`),
}

/** Wrap a DSH/cordis logger (or `console`) into a {@link KernelLogger}. */
export function toKernelLogger(value: unknown): KernelLogger {
  const fromObject = (candidate: unknown): KernelLogger | null => {
    const record = asRecord(candidate)
    if (record === null) return null
    const hasMethod = ['debug', 'info', 'warn', 'error'].some(
      (name) => typeof record[name] === 'function',
    )
    if (!hasMethod) return null
    const pick = (name: keyof KernelLogger): ((message: string) => void) => {
      const method = record[name]
      if (typeof method !== 'function') return CONSOLE_LOGGER[name]
      return (message: string) => {
        try {
          ;(method as (this: unknown, message: string) => void).call(candidate, message)
        } catch {
          CONSOLE_LOGGER[name](message)
        }
      }
    }
    return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') }
  }
  const direct = fromObject(value)
  if (direct !== null) return direct
  if (typeof value === 'function') {
    try {
      const scoped = fromObject((value as (name: string) => unknown)('dsh-rdm'))
      if (scoped !== null) return scoped
    } catch {
      // Fall through to the console adapter.
    }
  }
  return CONSOLE_LOGGER
}

// ── Path resolution ─────────────────────────────────────────────────────────

/** Resolve the kernel binary for the current platform/architecture. */
export function resolveKernelPath(config: ResolvedRdmConfig, packageRoot: string): string {
  const explicit = config.kernelPath.trim()
  if (explicit !== '') return path.resolve(explicit)
  const executable = process.platform === 'win32' ? '.exe' : ''
  return path.join(packageRoot, 'bin', `${process.platform}-${process.arch}`, `rdm-kernel${executable}`)
}

/** Resolve the kernel data directory (`$DSH_HOME/dsh-rdm` by default). */
export function resolveDataDir(
  config: ResolvedRdmConfig,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = config.dataDir.trim()
  if (configured !== '') return path.resolve(configured)
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : ''
  const root = dshHome !== '' ? path.resolve(dshHome) : path.join(os.homedir(), '.dsh')
  return path.join(root, 'dsh-rdm')
}

// ── Validation helpers shared by tools and the browser route ────────────────

/** Validate a URL for `start`/`probe`: non-empty http(s) only. */
export function assertHttpUrl(value: unknown, label = 'url'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('invalid_request', `${label} must be a non-empty http:// or https:// URL`)
  }
  const raw = value.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new KernelError('invalid_request', `${label} is not a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new KernelError(
      'invalid_request',
      `${label} must use http:// or https:// (got ${parsed.protocol}); other schemes are not supported`,
    )
  }
  return raw
}

/** Validate one task id (`t_...`). */
export function normalizeTaskId(value: unknown, label = 'taskId'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError('invalid_request', `${label} must be a non-empty task id such as "t_9f3a1c2d5e6b7a80"`)
  }
  const id = value.trim()
  if (id.length > 128) throw new KernelError('invalid_request', `${label} is too long to be a task id`)
  return id
}

/** Validate a control verb. */
export function normalizeControlAction(value: unknown): ControlAction {
  if (typeof value === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(value)) {
    return value as ControlAction
  }
  throw new KernelError(
    'invalid_request',
    `action must be one of ${CONTROL_ACTIONS.join(', ')} (got ${JSON.stringify(value)})`,
  )
}

/** Validate an extra-headers object. */
export function normalizeHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === null) {
    throw new KernelError('invalid_request', 'headers must be a JSON object mapping header names to string values')
  }
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(record)) {
    if (name.trim() === '') throw new KernelError('invalid_request', 'header names must be non-empty strings')
    if (typeof headerValue !== 'string') {
      throw new KernelError('invalid_request', `headers.${name} must be a string`)
    }
    headers[name] = headerValue
  }
  return headers
}

/** Optional non-empty string field from an unknown record. */
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new KernelError('invalid_request', `${label} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : value
}

/** Optional boolean field from an unknown record. */
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new KernelError('invalid_request', `${label} must be a boolean`)
  return value
}

/** Optional finite number field from an unknown record. */
function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KernelError('invalid_request', `${label} must be a finite number`)
  }
  return value
}

/** Validate and normalize a `start` request spec. */
export function normalizeRequestSpec(input: unknown): RequestSpec {
  const raw = asRecord(input)
  if (raw === null) throw new KernelError('invalid_request', 'start requires a request spec object')
  const spec: RequestSpec = { url: assertHttpUrl(raw.url) }
  const dir = optionalString(raw.dir, 'dir')
  if (dir !== undefined) spec.dir = dir
  const fileName = optionalString(raw.fileName, 'fileName')
  if (fileName !== undefined) spec.fileName = fileName
  const connections = optionalNumber(raw.connections, 'connections')
  if (connections !== undefined) {
    spec.connections = clampInt(connections, MIN_CONNECTIONS, MAX_CONNECTIONS)
  }
  const chunkSizeBytes = optionalNumber(raw.chunkSizeBytes, 'chunkSizeBytes')
  if (chunkSizeBytes !== undefined) {
    spec.chunkSizeBytes =
      chunkSizeBytes === 0 ? 0 : clampInt(chunkSizeBytes, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
  }
  if (raw.headers !== undefined) spec.headers = normalizeHeaders(raw.headers)
  const cookie = optionalString(raw.cookie, 'cookie')
  if (cookie !== undefined) spec.cookie = cookie
  const referer = optionalString(raw.referer, 'referer')
  if (referer !== undefined) spec.referer = referer
  const userAgent = optionalString(raw.userAgent, 'userAgent')
  if (userAgent !== undefined) spec.userAgent = userAgent
  if (raw.expectedSha256 !== undefined) {
    const hash = optionalString(raw.expectedSha256, 'expectedSha256')
    if (hash !== undefined) {
      if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
        throw new KernelError('invalid_request', 'expectedSha256 must be 64 hexadecimal characters')
      }
      spec.expectedSha256 = hash.toLowerCase()
    }
  }
  const speedLimitBps = optionalNumber(raw.speedLimitBps, 'speedLimitBps')
  if (speedLimitBps !== undefined) spec.speedLimitBps = Math.max(0, Math.round(speedLimitBps))
  const resume = optionalBoolean(raw.resume, 'resume')
  if (resume !== undefined) spec.resume = resume
  const singleStream = optionalBoolean(raw.singleStream, 'singleStream')
  if (singleStream !== undefined) spec.singleStream = singleStream
  const proxy = optionalString(raw.proxy, 'proxy')
  if (proxy !== undefined) spec.proxy = proxy
  const insecure = optionalBoolean(raw.insecure, 'insecure')
  if (insecure !== undefined) spec.insecure = insecure
  const maxAttempts = optionalNumber(raw.maxAttempts, 'maxAttempts')
  if (maxAttempts !== undefined) spec.maxAttempts = clampInt(maxAttempts, 1, 100)
  return spec
}

/** Validate a `wait` id list (1..20 unique ids). */
export function normalizeTaskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new KernelError('invalid_request', 'taskIds must be a non-empty array of task ids')
  }
  if (value.length > MAX_TASK_IDS) {
    throw new KernelError('invalid_request', `taskIds accepts at most ${MAX_TASK_IDS} ids per call`)
  }
  const ids: string[] = []
  for (const entry of value) {
    const id = normalizeTaskId(entry, 'taskIds[]')
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Validate/clamp a wait timeout in milliseconds. */
export function normalizeWaitTimeout(value: unknown, fallback = DEFAULT_WAIT_MS): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return clampInt(raw, MIN_WAIT_MS, MAX_WAIT_MS)
}

/**
 * Normalize an optional task-status filter.
 *
 * Accepts a single status (`"running"`), a comma-separated list
 * (`"paused,failed"`), or an array of statuses; returns `undefined` when the
 * filter is absent/empty.
 */
export function normalizeStatusFilter(value: unknown): TaskStatus | TaskStatus[] | undefined {
  if (value === undefined || value === null) return undefined
  const parts: string[] = []
  const take = (entry: unknown): void => {
    if (typeof entry !== 'string') {
      throw new KernelError('invalid_request', `status must be one of ${TASK_STATUSES.join(', ')}`)
    }
    const trimmed = entry.trim()
    if (trimmed !== '') parts.push(trimmed)
  }
  if (typeof value === 'string') {
    for (const entry of value.split(',')) take(entry)
  } else if (Array.isArray(value)) {
    for (const entry of value) take(entry)
  } else {
    throw new KernelError('invalid_request', `status must be one of ${TASK_STATUSES.join(', ')}`)
  }
  if (parts.length === 0) return undefined
  for (const part of parts) {
    if (!TASK_STATUSES.includes(part as TaskStatus)) {
      throw new KernelError(
        'invalid_request',
        `status must be one of ${TASK_STATUSES.join(', ')} (got "${part}")`,
      )
    }
  }
  return parts.length === 1 ? (parts[0] as TaskStatus) : (parts as TaskStatus[])
}

// ── Normalizers (kernel JSON -> stable host shapes) ─────────────────────────

/** Normalize one task view so every PROTOCOL.md field is present. */
export function normalizeTaskView(raw: unknown): TaskView | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = str(record.id)
  if (id === '') return null
  const status = TASK_STATUSES.includes(record.status as TaskStatus)
    ? (record.status as TaskStatus)
    : 'queued'
  const rawError = asRecord(record.error)
  const total = maybeNum(record.total)
  let downloaded = uint(record.downloaded, 0)
  // A completed task transferred every byte by definition. The current kernel
  // build reports `downloaded: 0` after finalizing a task (kernel-dev
  // notified); normalizing here keeps progress percentages and the panel's
  // size column correct whichever way the kernel reports it.
  if (status === 'completed' && total !== null && total > 0 && downloaded < total) {
    downloaded = total
  }
  return {
    id,
    url: str(record.url),
    finalUrl: maybeStr(record.finalUrl),
    fileName: str(record.fileName),
    dir: str(record.dir),
    path: maybeStr(record.path),
    status,
    downloaded,
    total,
    speedBps: num(record.speedBps, 0),
    etaSecs: maybeNum(record.etaSecs),
    activeWorkers: uint(record.activeWorkers, 0),
    peakWorkers: uint(record.peakWorkers, 0),
    connections: uint(record.connections, 0),
    chunkSize: maybeNum(record.chunkSize),
    resumedChunks: uint(record.resumedChunks, 0),
    rangeSupported: maybeBool(record.rangeSupported),
    expectedSha256: maybeStr(record.expectedSha256),
    sha256: maybeStr(record.sha256),
    error:
      rawError === null
        ? null
        : {
            code: str(rawError.code, 'internal'),
            message: str(rawError.message),
          },
    retries: uint(record.retries, 0),
    createdAt: uint(record.createdAt, 0),
    startedAt: maybeNum(record.startedAt),
    finishedAt: maybeNum(record.finishedAt),
    elapsedMs: uint(record.elapsedMs, 0),
    resumable: bool(record.resumable, false),
  }
}

/** Normalize one task event. */
export function normalizeTaskEvent(raw: unknown): TaskEvent | null {
  const record = asRecord(raw)
  if (record === null) return null
  const kind = TASK_EVENT_KINDS.includes(record.kind as TaskEventKind)
    ? (record.kind as TaskEventKind)
    : 'info'
  return {
    seq: uint(record.seq, 0),
    at: uint(record.at, 0),
    kind,
    message: maybeStr(record.message),
    chunk: maybeNum(record.chunk),
    attempt: maybeNum(record.attempt),
    delayMs: maybeNum(record.delayMs),
  }
}

/** Normalize probe metadata. */
export function normalizeMeta(raw: unknown): Meta {
  const record = asRecord(raw) ?? {}
  return {
    finalUrl: str(record.finalUrl),
    fileName: str(record.fileName),
    totalBytes: maybeNum(record.totalBytes),
    supportsRanges: bool(record.supportsRanges, false),
    contentType: maybeStr(record.contentType),
    etag: maybeStr(record.etag),
    lastModified: maybeStr(record.lastModified),
    httpVersion: maybeStr(record.httpVersion),
  }
}

/** Normalize kernel identity. */
function normalizeKernelInfo(raw: unknown): KernelInfo {
  const record = asRecord(raw) ?? {}
  return {
    version: str(record.version, 'unknown'),
    pid: uint(record.pid, 0),
    dataDir: str(record.dataDir),
    uptimeMs: maybeNum(record.uptimeMs),
  }
}

/** Normalize the effective kernel config echoed by `initialize`/`stats`. */
function normalizeInitializeConfig(raw: unknown): InitializeConfig {
  const record = asRecord(raw) ?? {}
  return {
    defaultDir: str(record.defaultDir),
    connections: uint(record.connections, DEFAULT_CONNECTIONS),
    chunkSizeBytes: uint(record.chunkSizeBytes, 0),
    speedLimitBps: uint(record.speedLimitBps, 0),
    maxAttempts: uint(record.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    autoResume: bool(record.autoResume, true),
    logLevel: str(record.logLevel, 'warn'),
    fsyncOnComplete: bool(record.fsyncOnComplete, false),
  }
}

/** Normalize `stats` task counters. */
function normalizeTaskCounts(raw: unknown): TaskCounts {
  const record = asRecord(raw) ?? {}
  return {
    total: uint(record.total, 0),
    queued: uint(record.queued, 0),
    running: uint(record.running, 0),
    paused: uint(record.paused, 0),
    completed: uint(record.completed, 0),
    failed: uint(record.failed, 0),
    cancelled: uint(record.cancelled, 0),
    interrupted: uint(record.interrupted, 0),
  }
}

// ── Pending request bookkeeping ─────────────────────────────────────────────

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

// ── KernelService ───────────────────────────────────────────────────────────

/**
 * Owns the resident kernel process and speaks protocol v1 with it.
 *
 * The service is lazy: the child is spawned on the first tool/route call. It
 * is safe for concurrent use — spawns are serialized and every in-flight
 * request resolves or rejects exactly once (on response, timeout, abort, or
 * child exit).
 */
export class KernelService {
  /** Resolved plugin config. */
  readonly config: ResolvedRdmConfig
  /** Absolute path of the kernel binary (or JavaScript entrypoint in dev). */
  readonly binaryPath: string
  /** Absolute kernel data directory. */
  private readonly packageRoot: string
  private activeDataDir: string
  private dataDirFallbackTried = false

  private readonly timings: KernelTimings
  private readonly logger: KernelLogger

  /** Absolute kernel data directory (after any sandbox fallback). */
  get dataDir(): string {
    return this.activeDataDir
  }

  private child: ChildProcess | null = null
  private ready = false
  private initialized = false
  private readyAt = 0
  private kernelInfo: KernelInfo | null = null
  private initializedResult: InitializeResult | null = null
  private lastError: string | null = null
  private stopping = false

  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private readyDeferred: Deferred<null> | null = null

  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly stderrLines: string[] = []
  private readonly taskMirror = new Map<string, TaskView>()
  private readonly pending = new Map<string, PendingRequest>()
  private requestSeq = 0

  private rapidRestarts = 0
  private lastExitAt = 0

  constructor(options: KernelServiceOptions) {
    this.config = options.config
    const packageRoot = options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url))
    this.binaryPath = resolveKernelPath(options.config, packageRoot)
    this.packageRoot = packageRoot
    this.activeDataDir = resolveDataDir(options.config, options.env ?? process.env)
    this.timings = {
      readyTimeoutMs: options.timings?.readyTimeoutMs ?? DEFAULT_TIMINGS.readyTimeoutMs,
      requestTimeouts: {
        ...DEFAULT_TIMINGS.requestTimeouts,
        ...(options.timings?.requestTimeouts ?? {}),
      },
      waitGraceMs: options.timings?.waitGraceMs ?? DEFAULT_TIMINGS.waitGraceMs,
      stopGraceMs: options.timings?.stopGraceMs ?? DEFAULT_TIMINGS.stopGraceMs,
      restartCooldownMs: options.timings?.restartCooldownMs ?? DEFAULT_TIMINGS.restartCooldownMs,
      maxRapidRestarts: options.timings?.maxRapidRestarts ?? DEFAULT_TIMINGS.maxRapidRestarts,
    }
    this.logger = toKernelLogger(options.logger)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the kernel if needed and complete the `initialize` handshake.
   * Serialized: concurrent callers share one spawn/initialize attempt.
   */
  async ensureStarted(): Promise<void> {
    if (this.stopping) throw new KernelError('kernel_stopped', 'The RDM kernel client is shutting down.')
    if (this.ready && this.child !== null && this.initialized) return
    if (this.startPromise !== null) return this.startPromise
    const attempt = this.boot()
    this.startPromise = attempt
    try {
      await attempt
    } finally {
      if (this.startPromise === attempt) this.startPromise = null
    }
  }

  /**
   * Start the kernel eagerly (used when the `startOnDemand` config is off).
   * Equivalent to {@link ensureStarted}; the name avoids colliding with the
   * download `start` operation below.
   */
  async prewarm(): Promise<void> {
    return this.ensureStarted()
  }

  /**
   * Gracefully stop the kernel: ask it to `shutdown`, close its stdin, and
   * SIGKILL after the grace period. Idempotent; the service is unusable
   * afterwards (a fresh plugin instance creates a new service).
   */
  async stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    const attempt = this.stopInternal()
    this.stopPromise = attempt
    return attempt
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (child !== null && this.ready) {
      try {
        await this.dispatch('shutdown', {}, this.timings.requestTimeouts.shutdown ?? 5_000)
      } catch {
        // The kernel may already be exiting; EOF below is the real shutdown.
      }
    }
    this.rejectAllPending(new KernelError('kernel_stopped', 'The RDM kernel is shutting down.'))
    if (child === null) {
      this.ready = false
      this.initialized = false
      return
    }
    try {
      child.stdin.end()
    } catch {
      // Already closed.
    }
    const exited = await waitForExit(child, this.timings.stopGraceMs)
    if (!exited) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best effort on Windows.
      }
      await waitForExit(child, 1_000)
    }
    if (this.child === child) {
      this.child = null
      this.ready = false
      this.initialized = false
    }
    this.logger.debug('RDM kernel stopped')
  }

  /** Process-level status without asking the kernel. */
  kernelStatus(): KernelStatusView {
    const child = this.child
    const running = child !== null && this.ready && child.exitCode === null
    return {
      running,
      starting: this.startPromise !== null,
      version: running && this.kernelInfo !== null ? this.kernelInfo.version : null,
      pid: child !== null && child.pid !== undefined ? child.pid : null,
      dataDir: this.kernelInfo?.dataDir ?? this.dataDir,
      error: this.lastError,
    }
  }

  /** Last task view from the notification mirror, if the kernel reported it. */
  mirroredTask(id: string): TaskView | undefined {
    return this.taskMirror.get(id)
  }

  /** Snapshot of the notification mirror (newest last). */
  mirroredTasks(): TaskView[] {
    return [...this.taskMirror.values()]
  }

  // ── Boot / spawn ─────────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    try {
      if (!this.ready || this.child === null) await this.spawnAndWaitReady()
      if (!this.initialized) await this.sendInitialize()
    } catch (error) {
      if (error instanceof Error) this.lastError = error.message
      throw error
    }
  }

  private async spawnAndWaitReady(): Promise<void> {
    const now = Date.now()
    if (this.lastExitAt > 0 && now - this.lastExitAt >= this.timings.restartCooldownMs) {
      this.rapidRestarts = 0
    }
    if (
      this.rapidRestarts >= this.timings.maxRapidRestarts &&
      this.lastExitAt > 0 &&
      now - this.lastExitAt < this.timings.restartCooldownMs
    ) {
      const waitMs = Math.max(0, this.timings.restartCooldownMs - (now - this.lastExitAt))
      throw new KernelError(
        'kernel_crashed',
        `The RDM kernel crashed ${this.rapidRestarts} times in a row${this.lastErrorSuffix()}. ` +
          `Retrying is blocked for about ${Math.ceil(waitMs / 1000)} s; fix the kernel build/config or set "kernelPath".`,
      )
    }
    const backoffMs = this.rapidRestarts > 0 ? Math.min(2_000, 200 * 2 ** (this.rapidRestarts - 1)) : 0
    if (backoffMs > 0) await delay(backoffMs)
    if (this.stopping) throw new KernelError('kernel_stopped', 'The RDM kernel client is shutting down.')

    this.assertBinaryAvailable()
    await mkdir(this.activeDataDir, { recursive: true })

    // Reap a half-dead previous child (e.g. a spawn error that never emitted exit).
    const previous = this.child
    if (previous !== null) {
      if (previous.exitCode === null && previous.pid !== undefined) {
        try {
          previous.kill()
        } catch {
          // Ignore.
        }
        await waitForExit(previous, 1_000)
      }
      if (this.child === previous) this.child = null
    }
    this.ready = false
    this.initialized = false
    this.stdoutBuffer = ''
    const readyDeferred = createDeferred<null>()
    this.readyDeferred = readyDeferred

    const { command, args } = this.spawnCommand()
    this.logger.debug(`spawning RDM kernel: ${command} ${args.join(' ')}`)
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      const message = `Failed to spawn the RDM kernel (${command}): ${errorText(error)}`
      this.lastError = message
      throw new KernelError('kernel_spawn', message, { cause: error })
    }
    this.child = child
    this.attachChild(child)
    try {
      await withTimeout(
        readyDeferred.promise,
        this.timings.readyTimeoutMs,
        () =>
          new KernelError(
            'timeout',
            `The RDM kernel did not report ready within ${this.timings.readyTimeoutMs} ms; ` +
              `run "${this.binaryPath}" manually to inspect its startup.`,
          ),
      )
    } catch (error) {
      this.killChild('startup failure')
      await waitForExit(child, 1_000)
      // Some DSH hosts confine child-process filesystem writes to the session
      // workspace. The kernel writes its task store under `--data-dir`, so a
      // blocked default directory would make the whole plugin unusable. When no
      // explicit `dataDir` was configured, retry once next to the installed
      // plugin (which is inside the permitted tree for a linked/local install).
      if (this.canFallbackDataDir(error)) {
        const fallback = path.join(this.packageRoot, '.rdm-data')
        if (fallback !== this.activeDataDir) {
          this.logger.warn(
            `RDM kernel cannot use data dir "${this.activeDataDir}" (${errorText(error)}); ` +
              `falling back to "${fallback}". Set the plugin config "dataDir" to override.`,
          )
          this.dataDirFallbackTried = true
          this.activeDataDir = fallback
          return this.spawnAndWaitReady()
        }
      }
      throw error
    }
    this.logger.debug(`RDM kernel ready (pid ${this.child?.pid ?? '?'})`)
  }

  private async sendInitialize(): Promise<void> {
    const result = await this.dispatch<InitializeResult>(
      'initialize',
      this.initializeParams() as unknown as Record<string, unknown>,
      this.timings.requestTimeouts.initialize ?? 30_000,
    )
    const normalized: InitializeResult = {
      protocol: uint(asRecord(result)?.protocol, PROTOCOL_VERSION),
      kernel: normalizeKernelInfo(asRecord(result)?.kernel),
      config: normalizeInitializeConfig(asRecord(result)?.config),
    }
    this.kernelInfo = normalized.kernel.version === 'unknown' ? this.kernelInfo : normalized.kernel
    this.initializedResult = normalized
    this.initialized = true
  }

  private initializeParams(overrides?: Partial<InitializeParams>): InitializeParams {
    const chunkSizeBytes =
      this.config.chunkSizeMiB > 0
        ? clampInt(Math.round(this.config.chunkSizeMiB * MIB), MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
        : 0
    const params: InitializeParams = {
      defaultDir:
        this.config.defaultDir !== "" ? this.config.defaultDir : path.join(this.activeDataDir, "downloads"),
      connections: clampInt(this.config.connections, MIN_CONNECTIONS, MAX_CONNECTIONS),
      chunkSizeBytes,
      speedLimitBps: this.config.speedLimitBps,
      maxAttempts: this.config.maxAttempts,
      autoResume: this.config.autoResume,
      logLevel: this.config.logLevel,
      fsyncOnComplete: this.config.fsyncOnComplete,
    }
    if (overrides !== undefined) {
      for (const key of Object.keys(overrides) as (keyof InitializeParams)[]) {
        const value = overrides[key]
        if (value !== undefined) (params as Record<string, unknown>)[key] = value
      }
    }
    return params
  }

  /** Whether a startup failure looks like a blocked/denied data directory. */
  private canFallbackDataDir(error: unknown): boolean {
    if (this.dataDirFallbackTried) return false
    if (this.config.dataDir.trim() !== '') return false
    const message = error instanceof Error ? error.message : String(error)
    return /data dir|data-dir|任务目录|\.dsh-rdm|os error 5|access is denied|拒绝访问/i.test(message)
  }

  /** A JavaScript entrypoint runs through the current node executable (dev/test). */
  private spawnCommand(): { command: string; args: string[] } {
    const args = ['--data-dir', this.dataDir, '--log-level', this.config.logLevel]
    if (/\.(?:c|m)?js$/i.test(this.binaryPath)) {
      return { command: process.execPath, args: [this.binaryPath, ...args] }
    }
    return { command: this.binaryPath, args }
  }

  private assertBinaryAvailable(): void {
    const binary = this.binaryPath
    let present = false
    try {
      present = existsSync(binary) && statSync(binary).isFile()
    } catch {
      present = false
    }
    if (!present) {
      throw new KernelError(
        'kernel_missing',
        `The RDM kernel binary was not found at "${binary}". ` +
          'Build it with "node scripts/build-kernel.mjs" (kernel/) or set the plugin config "kernelPath".',
      )
    }
  }

  private killChild(reason: string): void {
    const child = this.child
    if (child === null) return
    this.logger.debug(`killing RDM kernel: ${reason}`)
    try {
      child.kill()
    } catch {
      // Best effort.
    }
  }

  private lastErrorSuffix(): string {
    return this.lastError === null ? '' : ` (last error: ${this.lastError.slice(0, 300)})`
  }

  // ── Child pipe plumbing ──────────────────────────────────────────────────

  private attachChild(child: ChildProcess): void {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk))
    child.stdin.on('error', (error: Error) => {
      this.logger.debug(`RDM kernel stdin error: ${error.message}`)
    })
    child.on('error', (error: Error) => {
      if (child !== this.child) return
      const message = `Failed to start the RDM kernel (${this.binaryPath}): ${error.message}`
      this.lastError = message
      this.logger.error(message)
      const deferred = this.readyDeferred
      this.readyDeferred = null
      deferred?.reject(new KernelError('kernel_spawn', message))
      this.rejectAllPending(new KernelError('kernel_spawn', message))
    })
    child.on('exit', (code: number | null, signal: string | null) => this.handleExit(child, code, signal))
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.trim() !== '') this.onLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
    if (this.stdoutBuffer.length > MAX_LINE_LENGTH) {
      this.stdoutBuffer = ''
      this.lastError = 'The RDM kernel sent an oversized protocol line (>8 MiB); stdout was reset.'
      this.logger.error(this.lastError)
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk
    let index = this.stderrBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stderrBuffer.slice(0, index).replace(/\r$/, '')
      this.stderrBuffer = this.stderrBuffer.slice(index + 1)
      if (line.trim() !== '') this.recordStderr(line)
      index = this.stderrBuffer.indexOf('\n')
    }
    if (this.stderrBuffer.length > MAX_STDERR_BUFFER) {
      this.recordStderr(this.stderrBuffer.slice(-MAX_STDERR_BUFFER))
      this.stderrBuffer = ''
    }
  }

  private recordStderr(line: string): void {
    this.stderrLines.push(line)
    if (this.stderrLines.length > STDERR_RING_LINES) this.stderrLines.shift()
    this.logger.debug(`[rdm-kernel] ${line}`)
  }

  private lastStderrLine(): string {
    const last = this.stderrLines.at(-1)
    return last === undefined ? '' : last.slice(0, 300)
  }

  // ── Protocol message handling ────────────────────────────────────────────

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.logger.debug(`RDM kernel stdout non-JSON line ignored: ${line.slice(0, 200)}`)
      return
    }
    const record = asRecord(message)
    if (record === null) return
    if (typeof record.event === 'string') {
      this.onNotification(record)
      return
    }
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.id === 'number'
          ? String(record.id)
          : null
    if (id !== null) this.onResponse(id, record)
  }

  private onNotification(record: Record<string, unknown>): void {
    if (record.event === 'ready') {
      const kernel = normalizeKernelInfo(record.kernel)
      this.kernelInfo = kernel
      this.ready = true
      this.readyAt = Date.now()
      this.lastError = null
      const deferred = this.readyDeferred
      this.readyDeferred = null
      deferred?.resolve(null)
      this.logger.debug(
        `RDM kernel ready: version ${kernel.version}, pid ${kernel.pid}, dataDir ${kernel.dataDir}`,
      )
      return
    }
    if (record.event === 'task') {
      const task = normalizeTaskView(record.task)
      if (task !== null) this.rememberTask(task)
      return
    }
    this.logger.debug(`RDM kernel notification ignored: event ${String(record.event)}`)
  }

  private onResponse(id: string, record: Record<string, unknown>): void {
    if (!this.pending.has(id)) {
      this.logger.debug(`RDM kernel response for unknown request id ${id} ignored`)
      return
    }
    if (record.ok === true) {
      this.settlePending(id, undefined, record.result)
      return
    }
    const error = asRecord(record.error)
    this.settlePending(
      id,
      new KernelError(
        typeof error?.code === 'string' ? error.code : 'internal',
        typeof error?.message === 'string' ? error.message : 'The RDM kernel request failed.',
      ),
    )
  }

  private handleExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (child !== this.child) return
    const wasReady = this.ready
    this.child = null
    this.ready = false
    this.initialized = false
    this.initializedResult = null
    this.stdoutBuffer = ''
    const detail = `The RDM kernel exited unexpectedly (code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`})`
    const stderrTail = this.lastStderrLine()
    const message = stderrTail === '' ? detail : `${detail}: ${stderrTail}`
    this.lastError = message
    const deferred = this.readyDeferred
    this.readyDeferred = null
    deferred?.reject(new KernelError('kernel_exited', message))
    this.rejectAllPending(new KernelError('kernel_exited', `${message}; the pending request failed.`))
    if (this.stopping) return
    const now = Date.now()
    if (wasReady && this.readyAt > 0 && now - this.readyAt > STABLE_UPTIME_MS) {
      this.rapidRestarts = 0
    }
    this.rapidRestarts += 1
    this.lastExitAt = now
    this.logger.warn(message)
  }

  private rememberTask(task: TaskView): void {
    // Re-insert so the map's insertion order keeps the most recently updated last.
    if (this.taskMirror.has(task.id)) this.taskMirror.delete(task.id)
    this.taskMirror.set(task.id, task)
    while (this.taskMirror.size > MAX_TASK_MIRROR) {
      const oldest = this.taskMirror.keys().next()
      if (oldest.done) break
      this.taskMirror.delete(oldest.value)
    }
  }

  // ── Request dispatch ─────────────────────────────────────────────────────

  private requestTimeout(method: string, params: Record<string, unknown>): number {
    if (method === 'wait') {
      return normalizeWaitTimeout(params.timeoutMs) + this.timings.waitGraceMs
    }
    return this.timings.requestTimeouts[method] ?? 30_000
  }

  private async request<Result>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result> {
    await this.ensureStarted()
    return this.dispatch<Result>(method, params, this.requestTimeout(method, params), signal)
  }

  /** Send one request against the current child; callers own the ready check. */
  private dispatch<Result>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result> {
    const child = this.child
    if (child === null || !this.ready) {
      return Promise.reject(new KernelError('kernel_not_running', 'The RDM kernel is not running.'))
    }
    const id = `r${++this.requestSeq}`
    return new Promise<Result>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new KernelError('cancelled', `The "${method}" request was cancelled before it was sent.`))
        return
      }
      const timer = setTimeout(() => {
        this.settlePending(
          id,
          new KernelError(
            'timeout',
            `The RDM kernel did not answer "${method}" within ${timeoutMs} ms. ` +
              'The operation may still be running in the kernel; check with rdm_tasks.',
          ),
        )
      }, timeoutMs)
      const onAbort = (): void => {
        this.settlePending(id, new KernelError('cancelled', `The "${method}" request was cancelled.`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort)
      this.pending.set(id, {
        method,
        resolve: (value: unknown) => {
          cleanup()
          resolve(value as Result)
        },
        reject: (error: Error) => {
          cleanup()
          reject(error)
        },
        cleanup,
      })
      const request: KernelRequest = { id, method, params }
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error?: Error | null) => {
          if (error !== null && error !== undefined) {
            this.settlePending(
              id,
              new KernelError('io', `Failed to write to the RDM kernel stdin: ${error.message}`),
            )
          }
        })
      } catch (error) {
        this.settlePending(
          id,
          new KernelError('io', `Failed to write to the RDM kernel stdin: ${errorText(error)}`),
        )
      }
    })
  }

  /** Resolve or reject one pending request exactly once. */
  private settlePending(id: string, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value)
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  // ── Public operations ────────────────────────────────────────────────────

  /** Send (or resend) `initialize` with the configured session defaults. */
  async initialize(
    overrides?: Partial<InitializeParams>,
    signal?: AbortSignal,
  ): Promise<InitializeResult> {
    await this.ensureStarted()
    if ((overrides === undefined || Object.keys(overrides).length === 0) && this.initializedResult !== null) {
      return this.initializedResult
    }
    const result = await this.dispatch<InitializeResult>(
      'initialize',
      this.initializeParams(overrides) as unknown as Record<string, unknown>,
      this.timings.requestTimeouts.initialize ?? 30_000,
      signal,
    )
    const normalized: InitializeResult = {
      protocol: uint(asRecord(result)?.protocol, PROTOCOL_VERSION),
      kernel: normalizeKernelInfo(asRecord(result)?.kernel),
      config: normalizeInitializeConfig(asRecord(result)?.config),
    }
    this.initializedResult = normalized
    this.initialized = true
    return normalized
  }

  /** Probe a URL for redirects, file name, size and range support (no body). */
  async probe(url: string, options: ProbeOptions = {}, signal?: AbortSignal): Promise<Meta> {
    const params: ProbeParams = { url: assertHttpUrl(url) }
    if (options.headers !== undefined) params.headers = normalizeHeaders(options.headers)
    if (options.cookie !== undefined) params.cookie = options.cookie
    if (options.referer !== undefined) params.referer = options.referer
    if (options.userAgent !== undefined) params.userAgent = options.userAgent
    if (options.proxy !== undefined) params.proxy = options.proxy
    if (options.insecure !== undefined) params.insecure = options.insecure
    if (options.timeoutMs !== undefined) params.timeoutMs = options.timeoutMs
    const result = await this.request<ProbeResult>(
      'probe',
      params as unknown as Record<string, unknown>,
      signal,
    )
    return normalizeMeta((result as ProbeResult | null)?.meta)
  }

  /** Start one download; the kernel returns immediately with the task view. */
  async start(spec: RequestSpec, signal?: AbortSignal): Promise<TaskView> {
    const normalized = normalizeRequestSpec(spec)
    const result = await this.request<StartResult>(
      'start',
      normalized as unknown as Record<string, unknown>,
      signal,
    )
    const task = normalizeTaskView((result as StartResult | null)?.task)
    if (task === null) {
      throw new KernelError('internal', 'The RDM kernel returned an invalid "start" result (no task).')
    }
    this.rememberTask(task)
    return task
  }

  /** List tasks, newest first. */
  async list(
    status?: TaskStatus | TaskStatus[],
    limit?: number,
    signal?: AbortSignal,
  ): Promise<TaskView[]> {
    const params: ListParams = { limit: clampInt(limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT) }
    if (status !== undefined) params.status = status
    const result = await this.request<ListResult>(
      'list',
      params as unknown as Record<string, unknown>,
      signal,
    )
    const raw = (result as ListResult | null)?.tasks
    const tasks = Array.isArray(raw)
      ? raw.map((entry) => normalizeTaskView(entry)).filter((entry): entry is TaskView => entry !== null)
      : []
    for (const task of tasks) this.rememberTask(task)
    return tasks
  }

  /** Read one task plus up to `events` recent diagnostic events. */
  async get(
    id: string,
    events?: number,
    signal?: AbortSignal,
  ): Promise<{ task: TaskView; events: TaskEvent[] }> {
    const taskId = normalizeTaskId(id)
    const params = {
      id: taskId,
      events: clampInt(events ?? DEFAULT_EVENTS, 0, MAX_EVENTS),
    }
    const result = await this.request<GetResult>('get', params, signal)
    const task = normalizeTaskView((result as GetResult | null)?.task)
    if (task === null) {
      throw new KernelError('not_found', `No RDM task with id "${taskId}" exists.`)
    }
    this.rememberTask(task)
    const rawEvents = (result as GetResult | null)?.events
    const normalizedEvents = Array.isArray(rawEvents)
      ? rawEvents
          .map((entry) => normalizeTaskEvent(entry))
          .filter((entry): entry is TaskEvent => entry !== null)
      : []
    return { task, events: normalizedEvents }
  }

  /** Wait until every id is terminal or the timeout expires. */
  async wait(
    ids: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ tasks: TaskView[]; timedOut: boolean }> {
    const params: WaitParams = {
      ids: normalizeTaskIds(ids),
      timeoutMs: normalizeWaitTimeout(timeoutMs),
    }
    const result = await this.request<WaitResult>(
      'wait',
      params as unknown as Record<string, unknown>,
      signal,
    )
    const raw = (result as WaitResult | null)?.tasks
    const tasks = Array.isArray(raw)
      ? raw.map((entry) => normalizeTaskView(entry)).filter((entry): entry is TaskView => entry !== null)
      : []
    for (const task of tasks) this.rememberTask(task)
    return { tasks, timedOut: (result as WaitResult | null)?.timedOut === true }
  }

  /** Apply one control verb; returns null for `remove`. */
  async control(
    id: string,
    action: ControlAction,
    deletePart?: boolean,
    signal?: AbortSignal,
  ): Promise<TaskView | null> {
    const taskId = normalizeTaskId(id)
    const verb = normalizeControlAction(action)
    const params: ControlParams = { id: taskId, action: verb }
    if (verb === 'remove' && deletePart === true) params.deletePart = true
    const result = await this.request<ControlResult>(
      'control',
      params as unknown as Record<string, unknown>,
      signal,
    )
    const task = normalizeTaskView((result as ControlResult | null)?.task)
    if (task !== null) {
      this.rememberTask(task)
      return task
    }
    if (verb === 'remove') {
      this.taskMirror.delete(taskId)
      return null
    }
    throw new KernelError('internal', `The RDM kernel returned no task for "${verb}".`)
  }

  /** Kernel/session aggregate statistics. */
  async stats(signal?: AbortSignal): Promise<StatsResult> {
    const result = await this.request<StatsResult>('stats', {}, signal)
    const record = asRecord(result)
    if (record === null) {
      throw new KernelError('internal', 'The RDM kernel returned an invalid "stats" result.')
    }
    return {
      protocol: uint(record.protocol, PROTOCOL_VERSION),
      kernel: normalizeKernelInfo(record.kernel),
      tasks: normalizeTaskCounts(record.tasks),
      totals: {
        bytesDownloaded: uint(asRecord(record.totals)?.bytesDownloaded, 0),
        downloadsCompleted: uint(asRecord(record.totals)?.downloadsCompleted, 0),
        downloadsFailed: uint(asRecord(record.totals)?.downloadsFailed, 0),
      },
      config: normalizeInitializeConfig(record.config),
    }
  }
}
