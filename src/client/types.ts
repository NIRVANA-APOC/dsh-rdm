// Wire and service types for the dsh-rdm client half.
//
// 0.2.0 protocol v2 (docs/design/0.2.0-agent-native.md §2) plus the client
// services this plugin consumes: locale, slots, and — when the host profile
// provides them — the native right Sidebar tab registry (`ctx.sidebarRightTabs`)
// and navigation controller (`ctx.sidebarRight`). The standalone plugin is
// built without the Harness type packages, so every surface below is the
// subset used here, declared structurally.

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

/** Values of a `ctx.inject([...])` dependency bag (cordis-style). */
export interface InjectBag {
  get(name: string): unknown
}

/** Disposer returned by `ctx.inject`; `dispose` may be absent on some runtimes. */
export interface InjectSeat {
  dispose?: () => void
}

/** Native right Sidebar navigation controller subset (`ctx.sidebarRight`). */
export interface SidebarRightService {
  openResource?(address: string, options?: Record<string, unknown>): void
  openTab?(kind: string, options?: Record<string, unknown>): void
}

/** Per-tab actions injected by the native Sidebar (`tab.actions`). */
export interface SidebarTabActions {
  openResource?(address: string, options?: Record<string, unknown>): void
  openTab?(kind: string, options?: Record<string, unknown>): void
  close?(): void
}

/** One native Sidebar tab record (`useTabInfo().tab`). */
export interface NativeTabRecord {
  id: string
  kind?: string
  title?: string
  contentId?: string
  visible?: boolean
  navigation?: { params?: Record<string, unknown>; revision?: number }
  actions?: SidebarTabActions
}

/** `useTabInfo()` result subset. */
export interface NativeTabInfo {
  tab: NativeTabRecord
}

/** Framework props every `sidebar.right.pane.tab` body/title receives. */
export interface NativeTabFrameworkProps {
  useTabInfo?: () => NativeTabInfo
  sessionId?: string
}

/** One guide entry a tab type contributes. */
export interface SidebarGuideEntry {
  id: string
  order: number
  title: () => string
  description?: () => string
  icon?: (props: { size?: number }) => unknown
}

/** A native tab-type declaration (`ctx.sidebarRightTabs.register`). */
export interface SidebarTabTypeDefinition {
  id: string
  kind: string
  multiple?: boolean
  keepMounted?: boolean
  patterns?: readonly string[]
  priority?: 'extension' | 'builtin' | 'fallback'
  canOpen?: (address: string) => boolean
  title: (address: string) => string
  guide?: readonly SidebarGuideEntry[]
}

/** Native tab-type registry subset (`ctx.sidebarRightTabs`). */
export interface SidebarTabRegistry {
  register(definition: SidebarTabTypeDefinition): () => void
}

/** Client plugin context subset used here. */
export interface ClientContext {
  locale: LocaleService
  slots: SlotsService
  effect?(callback: () => unknown, label?: string): unknown
  inject?(deps: string[], callback: (injected: InjectBag) => unknown): InjectSeat | undefined
  /** Present only when `@deepseek-ai/dsh-client-ui-sidebar-right` is injected. */
  sidebarRight?: SidebarRightService
  /** Present only when `@deepseek-ai/dsh-client-ui-sidebar-right` is injected. */
  sidebarRightTabs?: SidebarTabRegistry
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
  connections: number | null
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

/** `list` action value after normalization (`{kernel, tasks, aggregate}`). */
export interface ListValue {
  kernel: KernelInfo
  tasks: TaskView[]
  aggregate: Aggregate
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
