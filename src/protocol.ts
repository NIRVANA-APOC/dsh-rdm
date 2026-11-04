/**
 * TypeScript mirrors of `dsh-rdm/PROTOCOL.md` — the NDJSON contract between
 * this plugin (parent) and the resident `rdm-kernel` child process.
 *
 * The kernel is authoritative for every value here; the plugin never invents
 * task state. Runtime constants shared by the client, tools and browser route
 * live in this module so the three callers cannot drift apart.
 *
 * @module dsh-rdm/protocol
 */

/** Protocol generation spoken by this plugin. */
export const PROTOCOL_VERSION = 1

/** Bytes in one kibibyte/mebibyte (binary units, matching the kernel). */
export const KIB = 1024
export const MIB = 1024 * KIB

// ── Task state ──────────────────────────────────────────────────────────────

/** Lifecycle status of one download task. */
export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Every status value the kernel can report (declaration order). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'probing',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]

/** Statuses after which a task no longer progresses on its own. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** Diagnostic event kinds emitted by the kernel's per-task ring. */
export type TaskEventKind =
  | 'info'
  | 'probe'
  | 'plan'
  | 'started'
  | 'retry'
  | 'controller'
  | 'paused'
  | 'resumed'
  | 'verify'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Every event kind the kernel can report. */
export const TASK_EVENT_KINDS: readonly TaskEventKind[] = [
  'info',
  'probe',
  'plan',
  'started',
  'retry',
  'controller',
  'paused',
  'resumed',
  'verify',
  'completed',
  'failed',
  'cancelled',
]

/** Structured task failure reported inside a {@link TaskView}. */
export interface TaskError {
  /** Kernel error code (see PROTOCOL.md "Error codes"). */
  code: string
  /** Human-readable detail. */
  message: string
}

/**
 * One task as reported by the kernel.
 *
 * The kernel serializes every field listed in PROTOCOL.md (unknown values are
 * `null`); {@link KernelService} additionally normalizes every task it exposes
 * so all fields are always present with the documented type.
 */
export interface TaskView {
  id: string
  url: string
  finalUrl: string | null
  fileName: string
  dir: string
  path: string | null
  status: TaskStatus
  /** Bytes written to the `.part` file. */
  downloaded: number
  /** Expected total bytes, `null` until known. */
  total: number | null
  /** EWMA transfer rate, 0 when idle. */
  speedBps: number
  etaSecs: number | null
  activeWorkers: number
  peakWorkers: number
  /** Planned connection cap. */
  connections: number
  /** Chunk size in bytes, `null` for single-stream transfers. */
  chunkSize: number | null
  resumedChunks: number
  rangeSupported: boolean | null
  expectedSha256: string | null
  sha256: string | null
  error: TaskError | null
  retries: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number
  resumable: boolean
}

/** One diagnostic task event from the kernel's bounded per-task ring. */
export interface TaskEvent {
  seq: number
  at: number
  kind: TaskEventKind
  message: string | null
  chunk: number | null
  attempt: number | null
  delayMs: number | null
}

// ── Probe metadata ──────────────────────────────────────────────────────────

/** Result of `probe` (no body bytes are downloaded). */
export interface Meta {
  finalUrl: string
  fileName: string
  totalBytes: number | null
  supportsRanges: boolean
  contentType: string | null
  etag: string | null
  lastModified: string | null
  httpVersion: string | null
}

// ── Start request ───────────────────────────────────────────────────────────

/** Input of `start` (the request `params` object). */
export interface RequestSpec {
  /** Absolute http/https URL, required. */
  url: string
  /** Absolute destination directory; kernel default when omitted. */
  dir?: string
  /** Optional file-name override (sanitized by the kernel). */
  fileName?: string
  /** 1..32; defaults to the initialized session value. */
  connections?: number
  /** 0 = auto, otherwise 262144..67108864. */
  chunkSizeBytes?: number
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Cookie header value. */
  cookie?: string
  referer?: string
  userAgent?: string
  /** Expected SHA-256 (64 hex chars), verified before the final rename. */
  expectedSha256?: string
  /** Per-task bandwidth cap in bytes/second (0/omitted = unlimited). */
  speedLimitBps?: number
  /** Resume from existing `.part` state; defaults to true. */
  resume?: boolean
  /** Force exactly one rangeless GET. */
  singleStream?: boolean
  /** Optional HTTP proxy URL. */
  proxy?: string
  /** Accept invalid TLS certificates (debug only). */
  insecure?: boolean
  /** Per-chunk retry budget; defaults to the initialized value. */
  maxAttempts?: number
}

// ── Control ─────────────────────────────────────────────────────────────────

/** Task control verbs accepted by `control`. */
export type ControlAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'

/** Every control verb, in declaration order. */
export const CONTROL_ACTIONS: readonly ControlAction[] = ['pause', 'resume', 'cancel', 'retry', 'remove']

// ── Limits shared by tools / route / client ─────────────────────────────────

export const MIN_CONNECTIONS = 1
export const MAX_CONNECTIONS = 32
export const DEFAULT_CONNECTIONS = 8
export const MIN_CHUNK_BYTES = 256 * KIB
export const MAX_CHUNK_BYTES = 64 * MIB
export const DEFAULT_MAX_ATTEMPTS = 6
export const MIN_WAIT_MS = 100
export const MAX_WAIT_MS = 300_000
export const DEFAULT_WAIT_MS = 60_000
export const MAX_TASK_IDS = 20
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200
export const MAX_EVENTS = 500
export const DEFAULT_EVENTS = 50
/** Model-facing cap: never return more than this many events per tool call. */
export const TOOL_MAX_EVENTS = 20
/** Browser-route cap for one `get` action. */
export const ROUTE_MAX_EVENTS = 200

// ── Kernel notifications ────────────────────────────────────────────────────

/** Identity of the running kernel process. */
export interface KernelInfo {
  version: string
  pid: number
  dataDir: string
  /** Present in `stats` results only. */
  uptimeMs?: number | null
}

/** Sent once after the kernel loads persisted state and is ready for requests. */
export interface KernelReadyNotification {
  event: 'ready'
  protocol: number
  kernel: KernelInfo
}

/** Sent on task transitions and, while running, at most twice per second. */
export interface TaskNotification {
  event: 'task'
  task: TaskView
}

/** Every message the kernel pushes without a request id. */
export type KernelNotification = KernelReadyNotification | TaskNotification

// ── Kernel request / response envelopes ─────────────────────────────────────

/** One request line written to the kernel's stdin. */
export interface KernelRequest<Params = Record<string, unknown>> {
  /** Opaque request id; the response echoes it. */
  id: string
  method: string
  params: Params
}

/** Failure detail carried by a failed response. */
export interface KernelErrorPayload {
  code: string
  message: string
}

/** Successful response line. */
export interface KernelSuccessResponse<Result = unknown> {
  id: string
  ok: true
  result: Result
}

/** Failed response line (`ok:false`). */
export interface KernelFailureResponse {
  id: string
  ok: false
  error: KernelErrorPayload
}

/** Any response line, discriminated by `ok`. */
export type KernelResponse<Result = unknown> =
  | KernelSuccessResponse<Result>
  | KernelFailureResponse

// ── Method params / results ─────────────────────────────────────────────────

/** Session defaults sent once with `initialize`. */
export interface InitializeParams {
  defaultDir?: string
  connections?: number
  chunkSizeBytes?: number
  speedLimitBps?: number
  maxAttempts?: number
  autoResume?: boolean
  logLevel?: string
}

/** Effective kernel defaults echoed by `initialize` (and by `stats`). */
export interface InitializeConfig {
  defaultDir: string
  connections: number
  chunkSizeBytes: number
  speedLimitBps: number
  maxAttempts: number
  autoResume: boolean
  logLevel: string
}

/** Result of `initialize`. */
export interface InitializeResult {
  protocol: number
  kernel: KernelInfo
  config: InitializeConfig
}

/** Params of `probe` (never downloads the body). */
export interface ProbeParams {
  url: string
  headers?: Record<string, string>
  cookie?: string
  referer?: string
  userAgent?: string
  proxy?: string
  insecure?: boolean
  timeoutMs?: number
}

/** Result of `probe`. */
export interface ProbeResult {
  meta: Meta
}

/** Result of `start`. */
export interface StartResult {
  task: TaskView
}

/** Params of `list` (newest first). */
export interface ListParams {
  status?: TaskStatus | TaskStatus[]
  limit?: number
}

/** Result of `list`. */
export interface ListResult {
  tasks: TaskView[]
}

/** Params of `get`. */
export interface GetParams {
  id: string
  events?: number
}

/** Result of `get`. */
export interface GetResult {
  task: TaskView
  events: TaskEvent[]
}

/** Params of `wait`. */
export interface WaitParams {
  ids: string[]
  timeoutMs?: number
}

/** Result of `wait`. */
export interface WaitResult {
  tasks: TaskView[]
  timedOut: boolean
}

/** Params of `control`. */
export interface ControlParams {
  id: string
  action: ControlAction
  deletePart?: boolean
}

/** Result of `control` (`task` is null for `remove`). */
export interface ControlResult {
  task: TaskView | null
}

/** Aggregate task counters in `stats`. */
export interface TaskCounts {
  total: number
  queued: number
  running: number
  paused: number
  completed: number
  failed: number
  cancelled: number
  interrupted: number
}

/** Lifetime download counters in `stats`. */
export interface StatsTotals {
  bytesDownloaded: number
  downloadsCompleted: number
  downloadsFailed: number
}

/** Result of `stats`. */
export interface StatsResult {
  protocol: number
  kernel: KernelInfo
  tasks: TaskCounts
  totals: StatsTotals
  config: InitializeConfig
}

// ── Browser route envelope ──────────────────────────────────────────────────

/** Success envelope of `POST /api/dsh-rdm/api`. */
export interface ApiSuccessEnvelope<Value> {
  ok: true
  value: Value
}

/** Failure envelope of `POST /api/dsh-rdm/api`. */
export interface ApiErrorEnvelope {
  ok: false
  error: { code: string; message: string }
}

/** Discriminated union used by every browser-route response. */
export type ApiEnvelope<Value> = ApiSuccessEnvelope<Value> | ApiErrorEnvelope

/** Browser-route actions accepted by the host. */
export type ApiAction = 'list' | 'get' | 'start' | 'control' | 'stats'

// ── Kernel status projection (tools + route) ────────────────────────────────

/** Process-level status the host can report without asking the kernel. */
export interface KernelStatusView {
  /** Child exists and has emitted `ready`. */
  running: boolean
  /** A spawn/handshake is in flight right now. */
  starting: boolean
  /** Kernel-reported version, when the current child is ready. */
  version: string | null
  /** OS process id of the current child, when it exists. */
  pid: number | null
  /** Data directory the kernel was started with. */
  dataDir: string
  /** Last spawn/exit/protocol failure message, or null. */
  error: string | null
}
