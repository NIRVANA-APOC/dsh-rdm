// Wire and service types for the dsh-rdm client half.
//
// 0.2.0 protocol v2 (docs/design/0.2.0-agent-native.md §2) plus the client
// services this plugin consumes: locale, slots, and the optional layout service
// the active-download popup uses. The standalone plugin is built without the
// Harness type packages, so every surface below is the subset used here,
// declared structurally.

/** Bound translate function returned by `ctx.locale.bind(ns)`. */
export type TFunction = (key: string, params?: Record<string, string | number>) => string

/** Client locale service subset used here. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): (() => void) | void
  bind(ns: string): TFunction
  subscribe?(listener: () => void): () => void
}

/** Client slot service subset used here. */
export interface SlotsService {
  inject(owner: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Client layout service subset (`ctx.layout`): panel selection and rightbar. */
/**
 * The shell's layout service as `ctx.get('layout')` returns it.
 *
 * `selectPanel` lives on the service itself (`layout.navigation` is the shell's
 * internal AbortController for pending navigations, not a navigation API) and
 * throws for a panel id the shell has not registered, so callers guard it.
 */
export interface LayoutService {
  selectPanel?(panelId: string | null): void
  hasMainPanel?(panelId: string): boolean
  openRightbar?(track: boolean, fullscreen: boolean): void
  closeRightbar?(): void
}

/** Client plugin context subset used here. */
export interface ClientContext {
  locale: LocaleService
  slots: SlotsService
  effect?(callback: () => unknown, label?: string): unknown
  /** Panel navigation exposed by the shell (`ctx.layout`). */
  layout?: LayoutService
  get?(name: string): unknown
}

/** Kernel error reported on a task. */
export interface TaskError {
  code: string
  message: string
}

/** Kernel generation status reported by `list`. */
export interface KernelInfo {
  running: boolean
  starting: boolean
  version: string | null
  pid: number | null
  dataDir: string | null
  protocol?: number | null
  error: string | null
}

/** Task status values from PROTOCOL.md. */
export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Resume safety reported by the kernel. */
export type ResumeSafety = 'strong' | 'weak' | 'none'

/** Multi-source policy reported on a task (0.3.0); unknown strings stay verbatim. */
export type SourcePolicy = 'single' | 'select' | 'failover' | 'hedge' | 'race'

/** Pool state of one candidate source (`active`/`standby`/`bad`). */
export type SourceState = 'active' | 'standby' | 'bad'

/** How one candidate source entered the pool (`primary`/`alternate`/`discovered`). */
export type SourceRole = 'primary' | 'alternate' | 'discovered'

/**
 * One redacted source row of a multi-source download (0.3.0). Older hosts omit
 * the whole array; the API layer normalizes it to an empty array.
 */
export interface SourceView {
  id: number
  /** Redacted URL; prefer `host` for display. */
  url: string
  host: string
  state: SourceState | string
  role: SourceRole | string
  bytes: number
  bps: number | null
  active: boolean
  lastError: string | null
}

/** One mirror discovered on a probe response (Metalink/HTTP, 0.3.0). */
export interface MirrorSource {
  /** Redacted URL. */
  url: string
  priority: number | null
  geo: string | null
  /** Discovery channel: `http-link`, `metalink` or `unknown`. */
  source: string
}

/** ETA confidence reported by the kernel. */
export type EtaConfidence = 'high' | 'medium' | 'low' | 'unknown'

/** Rate trend reported in TaskDetail.telemetry. */
export type RateTrend = 'rising' | 'steady' | 'falling' | 'stalled' | 'unknown'

/** Four trailing throughput windows (bytes/second, null when unsampled). */
export interface ThroughputWindows {
  w1: number | null
  w5: number | null
  w30: number | null
  w300: number | null
}

/**
 * `TaskView` — the flat list/notification record (protocol v2 §2.2).
 *
 * Every optional v2 field is null when the kernel does not know it; an old
 * (0.1.x) host simply omits them, which the API layer normalizes to null. The
 * UI reads "not known" from null, never from a missing property.
 */
export interface TaskView {
  id: string
  sessionId: string | null
  url: string
  host: string | null
  finalUrl: string | null
  fileName: string
  dir: string | null
  path: string | null
  status: TaskStatus | string
  downloaded: number
  total: number | null
  percent: number | null
  speedBps: number
  speed1sBps: number | null
  speed5sBps: number | null
  speed30sBps: number | null
  speed300sBps: number | null
  avgBps: number | null
  peakBps: number | null
  etaSecs: number | null
  etaConfidence: EtaConfidence | null
  stalledMs: number | null
  activeWorkers: number | null
  peakWorkers: number | null
  /** Connections requested when the task was created (0.2.2). */
  requestedConnections: number | null
  /** Connections planned at start (the controller's initial population). */
  connections: number | null
  /** Adaptive concurrency ceiling for this task (1..128). */
  maxConnections: number | null
  /** Controller's live worker target; 0 before the transfer is planned. */
  targetWorkers: number | null
  /** Bytes transferred in this run (excludes bytes adopted from `.part`). */
  transferredBytes: number | null
  chunkSize: number | null
  resumedChunks: number | null
  rangeSupported: boolean | null
  resumable: boolean | null
  resumeSafety: ResumeSafety | null
  expectedSha256: string | null
  sha256: string | null
  verified: boolean | null
  error: TaskError | null
  retries: number | null
  createdAt: number | null
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number | null
  signedUrlExpiresAt: number | null
  tlsNotAfter: number | null
  /** Effective multi-source policy; null on a pre-0.3.0 host. */
  sourcePolicy: string | null
  /** Pool index currently carrying the transfer, null before selection. */
  selectedSource: number | null
  /** Count of active-source changes during this run. */
  sourceSwitches: number | null
  /** Bounded per-source projection; empty for single-source/old hosts. */
  sources: SourceView[]
}

/** One diagnostic event from PROTOCOL.md TaskEvent. */
export interface TaskEvent {
  seq: number
  at: number
  kind: string
  message: string | null
  chunk: number | null
  attempt: number | null
  delayMs: number | null
}

/** `ServerFacts` range block. */
export interface ServerRangeFacts {
  supported: boolean | null
  acceptRanges: string | null
  ifRange: boolean | null
  probedBy: string | null
  probeStatus: number | null
  probeBytes: number | null
}

/** `ServerFacts` validators block. */
export interface ServerValidators {
  etag: string | null
  strongEtag: boolean | null
  lastModified: string | null
}

/** `ServerFacts` resume block. */
export interface ServerResumeFacts {
  possible: boolean | null
  safety: ResumeSafety | null
  reason: string | null
}

/** `ServerFacts` signed-URL block. */
export interface ServerSignedUrl {
  signed: boolean | null
  expiresAt: number | null
  expiresInSecs: number | null
  source: string | null
  state: string | null
}

/** `ServerFacts` TLS block. */
export interface ServerTlsFacts {
  https: boolean | null
  notAfter: number | null
  expiresInSecs: number | null
  issuer: string | null
  subject: string | null
  state: string | null
}

/** `ServerFacts` checksum block. */
export interface ServerChecksums {
  digest: string | null
  contentMd5: string | null
  sha256: string | null
}

/** `ServerFacts` rate-limit block. */
export interface ServerRateLimit {
  retryAfterSecs: number | null
  limit: number | null
  remaining: number | null
}

/** `ServerFacts` timing block. */
export interface ServerTiming {
  probeMs: number | null
  ttfbMs: number | null
  sampleBps: number | null
}

/** One redirect hop. */
export interface ServerRedirect {
  status: number | null
  url: string
}

/** `ServerFacts` learned origin ledger. */
export interface ServerOrigin {
  known: boolean | null
  attempts: number | null
  completed: number | null
  medianBps: number | null
  bestBps: number | null
  lastError: string | null
  lastAt: number | null
}

/** `ServerFacts.recommendation`. */
export interface ServerRecommendation {
  start: string | null
  connections: number | null
  chunkSizeBytes: number | null
  singleStream: boolean | null
  reason: string | null
  verify: string | null
}

/**
 * `ServerFacts` (protocol v2 §2.1) — what the server claimed, one-shot only.
 * All blocks are nullable: a 0.1.x kernel, a failed probe or a stripped host
 * mirror leaves them null and the drawer renders "not recorded".
 */
export interface ServerFacts {
  url: string | null
  finalUrl: string | null
  host: string | null
  httpVersion: string | null
  status: number | null
  fileName: string | null
  fileNameSource: string | null
  totalBytes: number | null
  contentType: string | null
  contentEncoding: string | null
  contentDisposition: string | null
  range: ServerRangeFacts | null
  validators: ServerValidators | null
  resume: ServerResumeFacts | null
  signedUrl: ServerSignedUrl | null
  tls: ServerTlsFacts | null
  redirects: ServerRedirect[]
  headers: Record<string, string | null> | null
  rateLimit: ServerRateLimit | null
  timing: ServerTiming | null
  checksum: ServerChecksums | null
  warnings: string[]
  recommendation: ServerRecommendation | null
  origin: ServerOrigin | null
  /** Metalink/HTTP mirrors discovered by the probe; empty when none/old host. */
  mirrors: MirrorSource[]
}

/** Telemetry block of `get` (protocol v2 §2.3). */
export interface TaskTelemetry {
  windows: ThroughputWindows
  peakBps: number | null
  avgBps: number | null
  stalledMs: number | null
  trend: RateTrend | null
  etaConfidence: EtaConfidence | null
  samples: number | null
  lastSampleAt: number | null
}

/** Target paths block of `get`. */
export interface TaskTarget {
  dir: string | null
  path: string | null
  part: string | null
  resumeState: string | null
}

/** Verification block of `get`. */
export interface TaskVerification {
  expectedSha256: string | null
  sha256: string | null
  verified: boolean | null
  serverChecksums: ServerChecksums
}

/** Resume-state block of `get`. */
export interface TaskResumeState {
  chunksDone: number | null
  bytesDone: number | null
  resumedChunks: number | null
  resumedBytes: number | null
  validatorsMatched: boolean | null
}

/** Timing decomposition of `get`. */
export interface TaskTiming {
  queuedMs: number | null
  probeMs: number | null
  transferMs: number | null
  finalizeMs: number | null
}

/** One machine-readable diagnosis entry. */
export interface TaskDiagnosis {
  code: string
  advice: string
  message: string
}

/** `TaskDetail` — the one-shot detail record (protocol v2 §2.3). */
export interface TaskDetail {
  telemetry: TaskTelemetry | null
  server: ServerFacts | null
  target: TaskTarget | null
  verification: TaskVerification | null
  resumeState: TaskResumeState | null
  timing: TaskTiming | null
  diagnosis: TaskDiagnosis[]
  /** Effective multi-source policy (0.3.0); null on an old host. */
  sourcePolicy: string | null
  selectedSource: number | null
  sourceSwitches: number | null
  /** Bounded per-source projection; empty for single-source/old hosts. */
  sources: SourceView[]
}

/** Aggregate line returned by `list` (protocol v2 §2.4). */
export interface Aggregate {
  total: number
  active: number
  paused: number
  failed: number
  completed: number
  bytesDownloaded: number
  nowBps: number
  w5Bps: number | null
  w30Bps: number | null
  w300Bps: number | null
  riskCount: number
}

/**
 * One owning session's display identity, resolved by the host from the session
 * log (`sessionTitle`) and the durable workspace registry. A host without those
 * services reports an empty catalog; the UI then falls back to the short id.
 */
export interface SessionMeta {
  id: string
  title: string | null
  live: boolean
  cwd: string | null
  workspaceId: string | null
  workspaceTitle: string | null
  workspacePath: string | null
}

/** One durable workspace (host workspace registry). */
export interface WorkspaceMeta {
  id: string
  title: string
  path: string
}

/** `list` action value after normalization (`{kernel, tasks, aggregate}`). */
export interface ListValue {
  kernel: KernelInfo
  tasks: TaskView[]
  aggregate: Aggregate
  sessions: Record<string, SessionMeta>
  workspaces: WorkspaceMeta[]
}

/** `get` action value after normalization (`{task, detail, events}`). */
export interface GetValue {
  task: TaskView
  detail: TaskDetail | null
  events: TaskEvent[]
}

/** `stats` action value (kernel-level counters; tolerant of an old host). */
export interface StatsValue {
  protocol: number | null
  kernel: KernelInfo
  counts: Aggregate | null
  throughput: ThroughputWindows | null
  origins: number | null
}

/** `get` request options. */
export interface GetOptions {
  events?: number
}

/** Control verbs accepted by the host route. */
export type ControlOp = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'

/** How the host opens a downloaded file. */
export type OpenTarget = 'file' | 'folder'

/** Per-id outcome of one control request (batch or single). */
export interface ControlOutcome {
  id: string
  ok: boolean
  task: TaskView | null
  error: { code: string; message: string } | null
}

/** `control` action value after normalization. */
export interface ControlResult {
  action: ControlOp
  results: ControlOutcome[]
}

/** `open` action value after normalization. */
export interface OpenResult {
  opened: boolean
  path: string | null
  error: { code: string; message: string } | null
}

/** `start` action value after normalization. */
export interface StartResult {
  task: TaskView
}
