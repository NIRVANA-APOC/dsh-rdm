/**
 * TypeScript mirrors of `dsh-rdm/PROTOCOL.md` — the NDJSON contract between
 * this plugin (parent) and the resident `rdm-kernel` child process.
 *
 * Protocol 2 (kernel 0.3.0) is the agent-native revision: tasks carry session
 * attribution and live telemetry windows, `probe`/`get` return a full
 * `ServerFacts` / `TaskDetail`, and the hot path (`list` / notifications) stays
 * a flat, cheap `TaskView`.
 *
 * 0.3.0 adds multi-source scheduling additively on the same generation:
 * optional `sources[]`/policy request fields, per-source rows and the effective
 * policy in task views/details, and discovered mirrors in `ServerFacts`.
 *
 * The kernel is authoritative for every value here; the plugin never invents
 * task state. Runtime constants shared by the client, tools and browser route
 * live in this module so the three callers cannot drift apart.
 *
 * @module dsh-rdm/protocol
 */

/** Protocol generation spoken by this plugin. */
export const PROTOCOL_VERSION = 2

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
  | 'source'
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
  'source',
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
 * Recoverable tool failure carried inside a canonical tool value (design
 * §3.5): expected operational failures return this instead of throwing.
 */
export interface ToolError {
  /** Stable machine-readable code (`network`, `not_found`, `conflict`, ...). */
  code: string
  /** Human-readable detail. */
  message: string
}

/** How safely a paused/interrupted task can resume from its `.part` file. */
export type ResumeSafety = 'strong' | 'weak' | 'none'

/** Confidence of the kernel's ETA estimate. */
export type EtaConfidence = 'high' | 'medium' | 'low' | 'unknown'

/** Direction of the short-window transfer rate. */
export type TaskTrend = 'rising' | 'steady' | 'falling' | 'stalled' | 'unknown'

/** Traceable origin of the inferred file name. */
export type FileNameSource = 'content-disposition' | 'url'

/** Raw `Accept-Ranges` header classification. */
export type AcceptRanges = 'bytes' | 'none' | 'unknown'

/** Request used to prove range support. */
export type ProbeMethod = 'head' | 'range-get'

/** Expiry vocabulary shared by signed URLs and TLS certificates. */
export type ExpiryState = 'valid' | 'expiring' | 'expired' | 'unknown'

/** How the kernel derived a signed-URL expiry. */
export type SignedUrlSource =
  | 'aws-sigv4'
  | 'aws-sigv2'
  | 'gcs-sigv4'
  | 'azure-sas'
  | 'generic-expires'
  | 'unknown'

/** Why resume is safe, weak or impossible. */
export type ResumeReason = 'strong-etag' | 'last-modified-only' | 'no-validators' | 'no-range-support'

/** What the kernel decided about existing `.part` state at plan time (0.3.0). */
export type ResumeDecision = 'accepted' | 'rejected' | 'not-attempted'

/**
 * Why the kernel accepted/rejected resume state (0.3.0).
 *
 * Accepted codes: `etag`, `last-modified`, `url`, `final-url`.
 * Rejected codes: `disabled`, `size-mismatch`, `validators-mismatch`,
 * `url-mismatch`, `file-name-mismatch`, `ranges-invalid`, `version-mismatch`,
 * `state-corrupt`, `part-missing`, `part-truncated`.
 *
 * Fresh/absent state is `resumeDecision: "not-attempted"` with a `null` reason;
 * `no-state` is not a reason code.
 */
export type ResumeDecisionReason =
  | 'etag'
  | 'last-modified'
  | 'url'
  | 'final-url'
  | 'disabled'
  | 'size-mismatch'
  | 'validators-mismatch'
  | 'url-mismatch'
  | 'file-name-mismatch'
  | 'ranges-invalid'
  | 'version-mismatch'
  | 'state-corrupt'
  | 'part-missing'
  | 'part-truncated'

/** Start recommendation derived from the server facts. */
export type StartAdvice = 'now' | 'later' | 'avoid'

/** Whether the caller should verify the result. */
export type VerifyRecommendation = 'recommended' | 'required' | 'unavailable'

/** Stable server-fact warning codes (bounded set). */
export type ServerWarningCode =
  | 'no-range-support'
  | 'no-validators'
  | 'weak-validators'
  | 'unknown-size'
  | 'signed-url-expiring'
  | 'signed-url-expired'
  | 'tls-expiring'
  | 'tls-expired'
  | 'rate-limited'
  | 'head-failed'
  | 'redirected'
  | 'content-encoding'

/** Stable machine diagnosis codes emitted by the kernel. */
export type DiagnosisCode =
  | 'on-track'
  | 'stalled'
  | 'throttled'
  | 'origin-slow'
  | 'no-range'
  | 'weak-validators'
  | 'checksum-available'
  | 'signed-url-expiring'
  | 'disk-slow'
  | 'retrying'
  | 'almost-done'

// ── Multi-source scheduling (0.3.0) ─────────────────────────────────────────

/**
 * How the kernel may use a task's candidate sources.
 *
 * `single` uses only the primary URL; `select` probes every candidate and
 * commits to the best; `failover` additionally switches on fatal failure/stall;
 * `hedge` races the first bytes across the top two and commits to the winner;
 * `race` assigns chunks dynamically across the pool.
 */
export type SourcePolicy = 'single' | 'select' | 'failover' | 'hedge' | 'race'

/** Every source policy, in declaration order. */
export const SOURCE_POLICIES: readonly SourcePolicy[] = ['single', 'select', 'failover', 'hedge', 'race']

/** Pool health state of one candidate source. */
export type SourceState = 'active' | 'standby' | 'bad'

/** Every source state the kernel can report. */
export const SOURCE_STATES: readonly SourceState[] = ['active', 'standby', 'bad']

/** How one candidate source entered the task's pool. */
export type SourceRole = 'primary' | 'alternate' | 'discovered'

/** Every source role the kernel can report. */
export const SOURCE_ROLES: readonly SourceRole[] = ['primary', 'alternate', 'discovered']

/**
 * One candidate source supplied with `start` (the request `sources[]` entry).
 * Source-specific headers override the request-wide ones.
 */
export interface SourceInput {
  /** Absolute http(s) URL of the mirror. */
  url: string
  /** Extra headers for this source only. */
  headers?: Record<string, string>
  /** Cookie header value for this source only. */
  cookie?: string
  /** Ordering hint; measured throughput wins at selection time. */
  priority?: number
}

/**
 * One redacted source row in a {@link TaskView} / {@link TaskDetail}.
 *
 * `url` is redacted by the kernel (credential-bearing query values become
 * `<redacted>`); receipt and UI surfaces should prefer `host`.
 */
export interface SourceView {
  /** Index in the task's pool (0 is the requested URL). */
  id: number
  /** Redacted source URL. */
  url: string
  host: string
  state: SourceState
  role: SourceRole
  /** Bytes transferred from this source. */
  bytes: number
  /** This source's EWMA rate, `null` when never measured. */
  bps: number | null
  /** This source currently carries (or waits to carry) the transfer. */
  active: boolean
  /** Last bounded error text, `null` when healthy. */
  lastError: string | null
}

/**
 * One mirror discovered on a probe response (Metalink/HTTP
 * `Link: rel=duplicate` or a Metalink document); `url` is redacted.
 */
export interface MirrorSource {
  url: string
  priority: number | null
  /** Geographic/administrative hint (`geo` from a Metalink document). */
  geo: string | null
  /** Discovery channel: `http-link`, `metalink` or `unknown`. */
  source: string
}

// ── Server facts (probe result, retained on a task) ─────────────────────────

/** Range-request facts proven by the probe. */
export interface RangeFacts {
  supported: boolean
  acceptRanges: AcceptRanges
  /** A strong validator or Last-Modified exists, so `If-Range` is meaningful. */
  ifRange: boolean
  probedBy: ProbeMethod
  /** Status of the proving request (`null` for HEAD). */
  probeStatus: number | null
  /** Bytes read while proving ranges. */
  probeBytes: number
}

/** Cache validators the origin exposes. */
export interface ValidatorFacts {
  etag: string | null
  strongEtag: boolean
  lastModified: string | null
}

/** Resume verdict for this origin/file. */
export interface ResumeFacts {
  possible: boolean
  safety: ResumeSafety
  reason: ResumeReason
}

/** Signed-URL expiry facts. */
export interface SignedUrlFacts {
  signed: boolean
  /** Milliseconds since epoch; `null` when not derivable. */
  expiresAt: number | null
  /** Seconds until expiry; negative when already expired. */
  expiresInSecs: number | null
  source: SignedUrlSource
  state: ExpiryState
}

/** TLS leaf-certificate facts (`null` for plain HTTP or unreadable certs). */
export interface TlsFacts {
  https: boolean
  /** Milliseconds since epoch. */
  notAfter: number | null
  expiresInSecs: number | null
  issuer: string | null
  subject: string | null
  state: ExpiryState
}

/** One redirect hop in the probe's manual chain. */
export interface RedirectHop {
  status: number
  url: string
}

/** Selected response headers retained as facts. */
export interface HeaderFacts {
  server: string | null
  date: string | null
  cacheControl: string | null
  expires: string | null
  vary: string | null
}

/** Rate-limit headers, when the origin sends them. */
export interface RateLimitFacts {
  retryAfterSecs: number | null
  limit: number | null
  remaining: number | null
}

/** Probe wall-clock timing. */
export interface ProbeTimingFacts {
  probeMs: number
  ttfbMs: number | null
  /** Fill only when a ranged probe actually read bytes. */
  sampleBps: number | null
}

/** Headers that would let the server prove integrity. */
export interface ChecksumFacts {
  /** RFC 9530 `Content-Digest`. */
  contentDigest: string | null
  /** `Content-MD5` (weak, legacy). */
  contentMd5: string | null
  /** `x-amz-checksum-sha256` only (whole object when stored with it). */
  sha256: string | null
  /** `x-amz-checksum-crc32c` / `x-goog-hash crc32c`. */
  crc32c: string | null
}

/** Recommendation derived from the server facts (advisory, never enforced). */
export interface Recommendation {
  start: StartAdvice
  connections: number
  /** `null` = let the kernel pick the automatic chunk size. */
  chunkSizeBytes: number | null
  singleStream: boolean
  reason: string
  verify: VerifyRecommendation
}

/** Learned per-host history from the kernel's origin ledger. */
export interface OriginFacts {
  known: boolean
  attempts: number
  completed: number
  medianBps: number | null
  bestBps: number | null
  lastError: string | null
  /** Milliseconds since epoch. */
  lastAt: number | null
}

/**
 * Result of `probe`, and the server-fact snapshot retained on a task.
 * Every optional field is `null`, never omitted, never `""`.
 */
export interface ServerFacts {
  /** Requested URL. */
  url: string
  /** URL after redirects. */
  finalUrl: string
  host: string
  httpVersion: string | null
  status: number
  fileName: string
  fileNameSource: FileNameSource
  totalBytes: number | null
  contentType: string | null
  contentEncoding: string | null
  contentDisposition: string | null
  range: RangeFacts
  validators: ValidatorFacts
  resume: ResumeFacts
  signedUrl: SignedUrlFacts
  tls: TlsFacts | null
  redirects: RedirectHop[]
  headers: HeaderFacts
  rateLimit: RateLimitFacts
  timing: ProbeTimingFacts
  checksum: ChecksumFacts
  warnings: ServerWarningCode[]
  recommendation: Recommendation
  origin: OriginFacts | null
  /** Mirrors discovered on this response (Metalink/HTTP `Link`), redacted. */
  mirrors: MirrorSource[]
}

// ── Task view (list / notification hot path) ────────────────────────────────

/**
 * One task as reported by the kernel: flat and cheap.
 *
 * The kernel serializes every field listed in PROTOCOL.md (unknown values are
 * `null`); {@link KernelService} additionally normalizes every task it exposes
 * so all fields are always present with the documented type.
 */
export interface TaskView {
  id: string
  /** Owning agent session; `null` for tasks started outside a session. */
  sessionId: string | null
  url: string
  host: string
  finalUrl: string | null
  fileName: string
  dir: string
  path: string | null
  status: TaskStatus
  /** Bytes written to the `.part` file. */
  downloaded: number
  /** Bytes transferred in this run (excludes bytes adopted from `.part`, 0.2.2). */
  transferredBytes: number
  /** Expected total bytes, `null` until known. */
  total: number | null
  /** Integer 0..100 (kernel floor); `null` when `total` is unknown. */
  percent: number | null
  /** EWMA transfer rate, 0 when known-idle. */
  speedBps: number
  speed1sBps: number | null
  speed5sBps: number | null
  speed30sBps: number | null
  speed300sBps: number | null
  /** Downloaded bytes / active elapsed. */
  avgBps: number | null
  peakBps: number | null
  etaSecs: number | null
  etaConfidence: EtaConfidence
  /** Milliseconds since the last byte landed. */
  stalledMs: number
  activeWorkers: number
  peakWorkers: number
  /** Planned connection cap. */
  connections: number
  /** Connections requested for this task (`Spec.connections`, 0.2.2). */
  requestedConnections: number
  /** Adaptive concurrency ceiling for this task (1..128, 0.3.0). */
  maxConnections: number
  /** Controller's current target worker count (`0` before the plan, 0.3.0). */
  targetWorkers: number
  /** Chunk size in bytes, `null` for single-stream/auto transfers. */
  chunkSize: number | null
  resumedChunks: number
  /** Bytes adopted from `.part` at plan time (0.3.0). */
  resumedBytes: number
  rangeSupported: boolean | null
  /** Ranges plus usable validators. */
  resumable: boolean
  resumeSafety: ResumeSafety | null
  expectedSha256: string | null
  sha256: string | null
  /** `true`/`false` only once a hash was compared; `null` otherwise. */
  verified: boolean | null
  error: TaskError | null
  retries: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number
  signedUrlExpiresAt: number | null
  tlsNotAfter: number | null
  /** Effective multi-source policy (0.3.0). */
  sourcePolicy: SourcePolicy
  /** Pool index currently carrying the transfer, `null` before selection. */
  selectedSource: number | null
  /** Count of active-source changes during this run. */
  sourceSwitches: number
  /** Bounded per-source projection (kernel max {@link MAX_SOURCES}). */
  sources: SourceView[]
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

// ── Task history (persisted JSONL recording, 0.3.0) ─────────────────────────

/** One telemetry sample recorded by the kernel's per-task JSONL writer. */
export interface TaskHistorySample {
  /** Milliseconds since epoch. */
  t: number
  /** Bytes downloaded at the sample. */
  bytes: number
  /** Instantaneous EWMA transfer rate in bytes/second. */
  bps: number
  /** Trailing 1 s rate. */
  w1Bps: number
  /** Trailing 5 s rate. */
  w5Bps: number
  /** Trailing 30 s rate. */
  w30Bps: number
  /** Trailing 300 s rate. */
  w300Bps: number
  /** Active workers at the sample. */
  workers: number
  peakWorkers: number
  /** Milliseconds since the last byte landed. */
  stalledMs: number
}

/** One recorded task event (same events the `get` path returns). */
export interface TaskHistoryEvent {
  /** Milliseconds since epoch. */
  t: number
  seq: number
  kind: TaskEventKind
  message: string | null
  chunk: number | null
  attempt: number | null
  delayMs: number | null
}

/**
 * One history meta record: written once per run at plan time (0.2.2), before
 * the first sample, so a sample series can be attributed to a kernel build.
 */
export interface HistoryMeta {
  /** Record discriminator; only meta records have it. */
  kind: 'meta'
  /** Milliseconds since epoch. */
  t: number
  /** Kernel build that wrote this record (e.g. `0.2.2`). */
  kernelVersion: string
  /** Kernel process id of that build. */
  pid: number
  taskId: string
  /** 1-based run number within the task (resume/retry increments it). */
  run: number
  /** Recording phase that opened the run (e.g. `plan`). */
  phase: string
  /** Redacted request URL. */
  url: string
  fileName: string
  /** Expected total bytes, `null` when unknown. */
  totalBytes: number | null
  /** Planned chunk size in bytes, `null` for single-stream/auto transfers. */
  chunkSize: number | null
  /** Chunk count of the plan. */
  chunks: number
  requestedConnections: number
  initialWorkers: number
  maxConnections: number
  resumedBytes: number
  resumeDecision: ResumeDecision
  resumeReason: ResumeDecisionReason | null
}

/**
 * Persisted per-task recording returned by the kernel `history` method: one
 * bounded page of samples/events, the JSONL paths, the per-run meta records and
 * the full recorded totals (meta records are not counted as samples).
 *
 * Every field is always present after host normalization (`samplesPath` /
 * `eventsPath` are `null` when the task was never recorded, `meta` is empty).
 */
export interface HistoryResult {
  taskId: string
  /** Absolute JSONL path, `null` when never recorded. */
  samplesPath: string | null
  /** Absolute JSONL path, `null` when never recorded. */
  eventsPath: string | null
  samples: TaskHistorySample[]
  events: TaskHistoryEvent[]
  /** Per-run plan meta records, bounded to the last {@link MAX_HISTORY_META}. */
  meta: HistoryMeta[]
  /** Total samples recorded on disk (not just the returned page). */
  totalSamples: number
  /** Total events recorded on disk (not just the returned page). */
  totalEvents: number
  /** The recording hit the kernel's `MAX_RECORDED_SAMPLES` cap. */
  truncated: boolean
}

/**
 * Host-normalized persisted recording: {@link HistoryResult} plus the compact
 * build tags derived from `meta` (deduped `"<kernelVersion>@<pid>"`).
 */
export interface TaskHistory extends HistoryResult {
  /** Deduped `"<kernelVersion>@<pid>"` build tags, in recording order (0.2.2). */
  builds: string[]
}

// ── Task detail (one-shot `get` path) ───────────────────────────────────────

/** The four trailing throughput windows (`null` = not enough data). */
export interface TelemetryWindows {
  '1s': number | null
  '5s': number | null
  '30s': number | null
  '300s': number | null
}

/** Rich live telemetry, only in `TaskDetail`. */
export interface TelemetryDetail {
  windows: TelemetryWindows
  peakBps: number | null
  avgBps: number | null
  stalledMs: number
  trend: TaskTrend
  etaConfidence: EtaConfidence
  samples: number
  lastSampleAt: number | null
}

/** Where a task reads/writes on disk. */
export interface TaskTargetDetail {
  dir: string
  path: string | null
  part: string | null
  resumeState: string | null
}

/** Verification state, including checksums the origin advertised. */
export interface VerificationDetail {
  expectedSha256: string | null
  sha256: string | null
  verified: boolean | null
  serverChecksums: ChecksumFacts
}

/** Resume bookkeeping for a paused/interrupted task. */
export interface ResumeStateDetail {
  chunksDone: number
  bytesDone: number
  resumedChunks: number
  resumedBytes: number
  validatorsMatched: boolean | null
  /** What the kernel decided about existing `.part` state at plan time (0.3.0). */
  resumeDecision: ResumeDecision
  /** Why it decided that; a documented code, `null` when not-attempted (0.3.0). */
  resumeReason: ResumeDecisionReason | null
}

/** Per-task timing decomposition. */
export interface DetailTiming {
  queuedMs: number | null
  probeMs: number | null
  transferMs: number | null
  finalizeMs: number | null
}

/** One machine-actionable diagnosis. */
export interface Diagnosis {
  code: DiagnosisCode
  /** Machine advice token (e.g. `wait`, `retry-later`, `do-not-pause`). */
  advice: string
  message: string
}

/** The heavy one-shot detail returned by `get` (never in list/notifications). */
export interface TaskDetail {
  telemetry: TelemetryDetail
  /** `null` before the probe phase completes. */
  server: ServerFacts | null
  target: TaskTargetDetail
  verification: VerificationDetail
  resumeState: ResumeStateDetail
  timing: DetailTiming
  /** Bounded list (kernel max 4). */
  diagnosis: Diagnosis[]
  /**
   * Effective multi-source policy. Kernel detail frames omit it; the host
   * carries the same task's {@link TaskView.sourcePolicy} into the detail.
   */
  sourcePolicy: SourcePolicy
  /** Pool index currently carrying the transfer, `null` before selection. */
  selectedSource: number | null
  /** Count of active-source changes during this run. */
  sourceSwitches: number
  /** Bounded per-source projection (kernel max {@link MAX_SOURCES}). */
  sources: SourceView[]
}

// ── Aggregates ──────────────────────────────────────────────────────────────

/** Aggregate task counters and throughput included in `list`. */
export interface Aggregate {
  total: number
  active: number
  paused: number
  failed: number
  completed: number
  bytesDownloaded: number
  nowBps: number
  w5Bps: number
  w30Bps: number
  w300Bps: number | null
  /** Live tasks with expiring signed URL/TLS or no usable resume support. */
  riskCount: number
}

/** Kernel-level throughput windows in `stats`. */
export interface StatsThroughput {
  nowBps: number
  w5Bps: number
  w30Bps: number
  w300Bps: number | null
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
  /** 1..128; defaults to the initialized session value. */
  connections?: number
  /** Adaptive concurrency ceiling 1..128; defaults to the initialized value (0.3.0). */
  maxConnections?: number
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
  /** Owning agent session (≤160 chars of `[A-Za-z0-9._:-]`). */
  sessionId?: string
  /** Additional candidate sources (mirrors); the primary `url` is source 0 (0.3.0). */
  sources?: SourceInput[]
  /** Multi-source policy; kernel default: `select` when `sources` is non-empty, else `single`. */
  sourcePolicy?: SourcePolicy
  /** Hedge window in bytes (0.3.0; kernel clamps to 64 KiB..64 MiB). */
  sourceRaceBytes?: number
  /** Parse Metalink/HTTP `Link: rel=duplicate` mirrors from probe responses (default true). */
  discoverSources?: boolean
  /** Select a file by name when `url` is a `.meta4`/`.metalink` document. */
  metalinkFile?: string
  /**
   * Host-side helper only: max ms to wait for the preflight `ServerFacts`
   * before returning. Never sent to the kernel.
   */
  waitProbeMs?: number
}

// ── Control ─────────────────────────────────────────────────────────────────

/** Task control verbs accepted by `control`. */
export type ControlAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'

/** Every control verb, in declaration order. */
export const CONTROL_ACTIONS: readonly ControlAction[] = ['pause', 'resume', 'cancel', 'retry', 'remove']

// ── Limits shared by tools / route / client ─────────────────────────────────

export const MIN_CONNECTIONS = 1
export const MAX_CONNECTIONS = 128
export const DEFAULT_CONNECTIONS = 8
export const DEFAULT_MAX_CONNECTIONS = 128
export const MIN_CHUNK_BYTES = 256 * KIB
export const MAX_CHUNK_BYTES = 64 * MIB
/** Hard cap on candidate sources per task (kernel `MAX_SOURCES`). */
export const MAX_SOURCES = 8
/** Additional candidates accepted over the required primary `url`. */
export const MAX_ADDITIONAL_SOURCES = MAX_SOURCES - 1
/** Hedge window bounds (kernel `MIN/MAX/DEFAULT_SOURCE_RACE_BYTES`). */
export const MIN_SOURCE_RACE_BYTES = 64 * KIB
export const MAX_SOURCE_RACE_BYTES = 64 * MIB
export const DEFAULT_SOURCE_RACE_BYTES = 1 * MIB
export const DEFAULT_MAX_ATTEMPTS = 6
export const MIN_WAIT_MS = 100
export const MAX_WAIT_MS = 300_000
export const DEFAULT_WAIT_MS = 60_000
export const MAX_TASK_IDS = 20

/** Kernel `list` default/max (browser route and programmatic callers). */
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200

/** Model-facing `rdm_tasks` list bounds (bounded receipt). */
export const TOOL_LIST_DEFAULT = 20
export const TOOL_LIST_MAX = 100

export const MAX_EVENTS = 500
export const DEFAULT_EVENTS = 50
/** Model-facing cap: never return more than this many events per tool call. */
export const TOOL_MAX_EVENTS = 30
/** Browser-route cap for one `get` action. */
export const ROUTE_MAX_EVENTS = 200

/** `history` tool page cap for samples (0.3.0). */
export const MAX_HISTORY_SAMPLES = 2000
/** `rdm_history` default sample page size (0.3.0). */
export const DEFAULT_HISTORY_SAMPLES = 300
/** `rdm_history` default recorded-event page size (0.3.0). */
export const DEFAULT_HISTORY_EVENTS = 200
/** Kernel `history` keeps at most this many run-meta records, newest last (0.2.2). */
export const MAX_HISTORY_META = 20

/** `rdm_download` preflight server-facts wait. */
export const DEFAULT_WAIT_PROBE_MS = 2_000
export const MAX_WAIT_PROBE_MS = 5_000

/** Session ids the kernel accepts on `start`. */
export const MAX_SESSION_ID_LENGTH = 160
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

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
  /** Adaptive concurrency ceiling 1..128 (0.3.0). */
  maxConnections?: number
  chunkSizeBytes?: number
  speedLimitBps?: number
  maxAttempts?: number
  autoResume?: boolean
  logLevel?: string
  fsyncOnComplete?: boolean
  /** Accepted for symmetry; the kernel ignores it. */
  sessionId?: string
}

/** Effective kernel defaults echoed by `initialize` (and by `stats`). */
export interface InitializeConfig {
  defaultDir: string
  connections: number
  /** Adaptive concurrency ceiling for new tasks (1..128, 0.3.0). */
  maxConnections: number
  chunkSizeBytes: number
  speedLimitBps: number
  maxAttempts: number
  autoResume: boolean
  logLevel: string
  fsyncOnComplete: boolean
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
  server: ServerFacts
}

/** Result of `start`. */
export interface StartResult {
  task: TaskView
}

/** Params of `list` (newest first). */
export interface ListParams {
  status?: TaskStatus | TaskStatus[]
  /** Only tasks owned by this agent session. */
  sessionId?: string
  limit?: number
}

/** Result of `list`. */
export interface ListResult {
  tasks: TaskView[]
  aggregate: Aggregate
}

/** Params of `get`. */
export interface GetParams {
  id: string
  events?: number
}

/** Result of `get`. */
export interface GetResult {
  task: TaskView
  detail: TaskDetail
  events: TaskEvent[]
}

/** Params of `history` (0.3.0 recording reader). */
export interface HistoryParams {
  /** Task id (`t_...`). */
  id: string
  /** Sample offset, >= 0; defaults to 0. Only the raw series honors it literally. */
  offset?: number
  /** Sample page size 1..5000 (kernel clamp); defaults to 500. */
  limit?: number
  /** Include recorded events; defaults to true. */
  includeEvents?: boolean
  /** Event page size 1..2000 (kernel clamp); defaults to 200. */
  eventsLimit?: number
  /**
   * Return the literal recorded series instead of the kernel's default
   * evenly-downsampled review series; `offset`/`limit` page it literally.
   */
  raw?: boolean
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
  throughput: StatsThroughput
  /** Number of hosts known to the origin ledger. */
  origins: number
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

