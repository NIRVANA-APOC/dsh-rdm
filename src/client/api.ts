// Client for the dsh-rdm browser route: POST /api/dsh-rdm/api.
//
// Protocol v2 (docs/design/0.2.0-agent-native.md §4.2) exposes four actions:
// `list` ({sessionId? status? limit?}) -> {kernel, tasks, aggregate},
// `get` ({id, events?}) -> {task, detail, events}, `stats` ({}) and
// `control` ({id, action, deletePart?}). `start` still exists on the host for
// tests, but the review UI never calls it — there is no composer.
//
// The kernel and host land separately from this client, so every response is
// normalized here: a 0.1.x host that omits `aggregate`, `detail`, sessionIds
// or the v2 telemetry fields still produces a valid review model, with unknown
// values as null. Nothing in the UI reads a missing property directly.

import type {
  Aggregate,
  ControlOp,
  GetOptions,
  GetValue,
  KernelInfo,
  ListValue,
  RateTrend,
  ServerChecksums,
  ServerFacts,
  ServerOrigin,
  ServerRangeFacts,
  ServerRateLimit,
  ServerRecommendation,
  ServerRedirect,
  ServerResumeFacts,
  ServerSignedUrl,
  ServerTlsFacts,
  ServerValidators,
  StatsValue,
  TFunction,
  TaskDetail,
  TaskDiagnosis,
  TaskEvent,
  TaskResumeState,
  TaskTarget,
  TaskTelemetry,
  TaskTiming,
  TaskVerification,
  TaskView,
  ThroughputWindows,
} from './types'

/** Route path registered by the host half through the connection service. */
export const ROUTE = '/api/dsh-rdm/api'

/** Default page size for the review ledger (kernel caps it at 100). */
export const LIST_LIMIT = 100

/** Default event count requested with `get`. */
export const GET_EVENTS = 30

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

/* ------------------------------------------------------------- transport */

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
 * Translate a failure for display: a known error code becomes localized text;
 * unknown codes fall back to the message, then to the generic unknown-error
 * string. Raw kernel messages are never appended to the localized label — the
 * drawer exposes them as their own code row (0.1.x critique issue 5).
 */
export function errorText(t: TFunction, error: unknown): string {
  const routeError = toRouteError(error)
  const key = `error.code.${routeError.code}`
  const localized = t(key)
  if (localized !== key) return localized
  return routeError.message || t('error.code.unknown')
}

/* ----------------------------------------------------------------- actions */

/** `list`: every task the route admits, normalized, with an aggregate line. */
export async function listTasks(options: { sessionId?: string; status?: string; limit?: number } = {}): Promise<ListValue> {
  const payload: Record<string, unknown> = { action: 'list', limit: options.limit ?? LIST_LIMIT }
  if (options.sessionId !== undefined && options.sessionId !== '') payload.sessionId = options.sessionId
  if (options.status !== undefined && options.status !== '') payload.status = options.status
  const value = await request<unknown>(payload, 12000)
  return normalizeList(value)
}

/** `get`: one task, its one-shot detail, and a bounded event tail. */
export async function getTask(id: string, options: GetOptions = {}): Promise<GetValue> {
  const value = await request<unknown>({ action: 'get', id, events: options.events ?? GET_EVENTS }, 15000)
  return normalizeGet(value)
}

/** `stats`: kernel-level counters. Optional for the UI (the ledger works without it). */
export async function getStats(): Promise<StatsValue> {
  const value = await request<unknown>({ action: 'stats' }, 10000)
  return normalizeStats(value)
}

/** Run one control verb against a task. */
export async function controlTask(id: string, control: ControlOp, deletePart = false): Promise<TaskView | null> {
  const value = await request<unknown>({ action: 'control', id, control, deletePart }, 20000)
  const record = asRecord(value)
  return record === null ? null : normalizeTask(record.task)
}

/* ------------------------------------------------------------ normalizers */

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return asRecord(value)
}

/** Status strings the kernel is allowed to emit; anything else stays verbatim. */
const STATUSES = new Set(['queued', 'probing', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'])

function asStatus(value: unknown): string {
  const status = asString(value)
  if (status !== null && STATUSES.has(status)) return status
  return status ?? 'queued'
}

/** Coerce a window rate: absent stays null; 0 is a real "known idle" value. */
function asRate(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null
}

function normalizeError(value: unknown): TaskView['error'] {
  const record = asRecord(value)
  if (record === null) return null
  const code = asString(record.code) ?? 'internal'
  return { code, message: asString(record.message) ?? '' }
}

/** Normalize one task record; every unknown field becomes null, never absent. */
export function normalizeTask(value: unknown): TaskView {
  const record = asRecord(value) ?? {}
  const downloaded = asNumber(record.downloaded) ?? 0
  const total = asNumber(record.total)
  // `percent` is kernel-computed in v2; old records may omit it, so derive it
  // from bytes only when a positive total is known (unknown stays null).
  let percent = asNumber(record.percent)
  if (percent === null && total !== null && total > 0) percent = Math.min(100, Math.floor((downloaded / total) * 100))
  return {
    id: asString(record.id) ?? asString(record.taskId) ?? '',
    sessionId: asString(record.sessionId),
    url: asString(record.url) ?? '',
    host: asString(record.host),
    finalUrl: asString(record.finalUrl),
    fileName: asString(record.fileName) ?? '',
    dir: asString(record.dir),
    path: asString(record.path),
    status: asStatus(record.status),
    downloaded,
    total,
    percent,
    speedBps: asRate(record.speedBps) ?? 0,
    speed1sBps: asRate(record.speed1sBps),
    speed5sBps: asRate(record.speed5sBps),
    speed30sBps: asRate(record.speed30sBps),
    speed300sBps: asRate(record.speed300sBps),
    avgBps: asRate(record.avgBps),
    peakBps: asRate(record.peakBps),
    etaSecs: asNumber(record.etaSecs),
    etaConfidence: asConfidence(record.etaConfidence),
    stalledMs: asNumber(record.stalledMs),
    activeWorkers: asNumber(record.activeWorkers),
    peakWorkers: asNumber(record.peakWorkers),
    connections: asNumber(record.connections),
    chunkSize: asNumber(record.chunkSize),
    resumedChunks: asNumber(record.resumedChunks),
    rangeSupported: asBoolean(record.rangeSupported),
    resumable: asBoolean(record.resumable),
    resumeSafety: asResumeSafety(record.resumeSafety),
    expectedSha256: asString(record.expectedSha256),
    sha256: asString(record.sha256),
    verified: asBoolean(record.verified),
    error: normalizeError(record.error),
    retries: asNumber(record.retries),
    createdAt: asNumber(record.createdAt),
    startedAt: asNumber(record.startedAt),
    finishedAt: asNumber(record.finishedAt),
    elapsedMs: asNumber(record.elapsedMs),
    signedUrlExpiresAt: asNumber(record.signedUrlExpiresAt),
    tlsNotAfter: asNumber(record.tlsNotAfter),
  }
}

function asConfidence(value: unknown): TaskView['etaConfidence'] {
  const text = asString(value)
  return text === 'high' || text === 'medium' || text === 'low' || text === 'unknown' ? text : null
}

function asResumeSafety(value: unknown): TaskView['resumeSafety'] {
  const text = asString(value)
  return text === 'strong' || text === 'weak' || text === 'none' ? text : null
}

function asTrend(value: unknown): RateTrend | null {
  const text = asString(value)
  return text === 'rising' || text === 'steady' || text === 'falling' || text === 'stalled' || text === 'unknown' ? text : null
}

function asWindows(value: unknown): ThroughputWindows | null {
  const record = asRecordOrNull(value)
  if (record === null) return null
  return {
    w1: asRate(record['1s'] ?? record.w1 ?? record.speed1sBps),
    w5: asRate(record['5s'] ?? record.w5 ?? record.speed5sBps),
    w30: asRate(record['30s'] ?? record.w30 ?? record.speed30sBps),
    w300: asRate(record['300s'] ?? record.w300 ?? record.speed300sBps),
  }
}

function normalizeKernel(value: unknown): KernelInfo {
  const record = asRecord(value)
  if (record === null) {
    return { running: false, starting: false, version: null, pid: null, dataDir: null, protocol: null, error: null }
  }
  return {
    running: record.running === true,
    starting: record.starting === true,
    version: asString(record.version),
    pid: asNumber(record.pid),
    dataDir: asString(record.dataDir),
    protocol: asNumber(record.protocol),
    error: asString(record.error),
  }
}

/** Compute the aggregate line from task records (old-host fallback). */
export function aggregateOf(tasks: TaskView[]): Aggregate {
  let active = 0
  let paused = 0
  let failed = 0
  let completed = 0
  let bytes = 0
  let now = 0
  let risk = 0
  for (const task of tasks) {
    bytes += task.downloaded
    if (task.status === 'running' || task.status === 'probing' || task.status === 'queued') active += 1
    if (task.status === 'paused' || task.status === 'interrupted') paused += 1
    if (task.status === 'failed') failed += 1
    if (task.status === 'completed') completed += 1
    if (isLive(task)) {
      now += task.speedBps
      if (taskIsRisky(task)) risk += 1
    }
  }
  return {
    total: tasks.length,
    active,
    paused,
    failed,
    completed,
    bytesDownloaded: bytes,
    nowBps: now,
    w5Bps: null,
    w30Bps: null,
    w300Bps: null,
    riskCount: risk,
  }
}

/** Whether a task is still being worked on (queued/probing/running). */
export function isLive(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'probing' || task.status === 'queued'
}

/** Whether a task is not terminal. */
export function isUnfinished(task: TaskView): boolean {
  return task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled'
}

/** Whether a live task carries a risk the human should see (signed URL/TLS/no range). */
export function taskIsRisky(task: TaskView): boolean {
  if (!isUnfinished(task)) return false
  const now = Date.now()
  if (task.signedUrlExpiresAt !== null && task.signedUrlExpiresAt - now < 10 * 60 * 1000) return true
  if (task.tlsNotAfter !== null && task.tlsNotAfter - now < 24 * 60 * 60 * 1000) return true
  if (task.status === 'running' && task.rangeSupported === false) return true
  return false
}

function normalizeAggregate(value: unknown, tasks: TaskView[]): Aggregate {
  const record = asRecord(value)
  if (record === null) return aggregateOf(tasks)
  const fallback = aggregateOf(tasks)
  return {
    total: asNumber(record.total) ?? fallback.total,
    active: asNumber(record.active) ?? fallback.active,
    paused: asNumber(record.paused) ?? fallback.paused,
    failed: asNumber(record.failed) ?? fallback.failed,
    completed: asNumber(record.completed) ?? fallback.completed,
    bytesDownloaded: asNumber(record.bytesDownloaded) ?? fallback.bytesDownloaded,
    nowBps: asRate(record.nowBps) ?? fallback.nowBps,
    w5Bps: asRate(record.w5Bps),
    w30Bps: asRate(record.w30Bps),
    w300Bps: asRate(record.w300Bps),
    riskCount: asNumber(record.riskCount) ?? fallback.riskCount,
  }
}

/** Normalize the `list` action value; tolerates a pre-v2 `{kernel, tasks}`. */
export function normalizeList(value: unknown): ListValue {
  // A double envelope (`{value: {...}}`) has been seen from a proxy-style host
  // during the 0.1.x line; accept it rather than fail the poll loop.
  let record = asRecord(value)
  if (record !== null && asRecord(record.value) !== null && record.kernel === undefined && record.tasks === undefined) {
    record = asRecord(record.value)
  }
  const source = record ?? {}
  const tasks = asArray(source.tasks).map(normalizeTask).filter((task) => task.id !== '')
  const kernel = normalizeKernel(source.kernel ?? source.status)
  return { kernel, tasks, aggregate: normalizeAggregate(source.aggregate, tasks) }
}

/** Normalize one diagnostic event. */
export function normalizeEvent(value: unknown): TaskEvent {
  const record = asRecord(value) ?? {}
  return {
    seq: asNumber(record.seq) ?? 0,
    at: asNumber(record.at) ?? 0,
    kind: asString(record.kind) ?? 'event',
    message: asString(record.message),
    chunk: asNumber(record.chunk),
    attempt: asNumber(record.attempt),
    delayMs: asNumber(record.delayMs),
  }
}

function normalizeServer(value: unknown): ServerFacts | null {
  const record = asRecord(value)
  if (record === null) return null
  const rangeRecord = asRecordOrNull(record.range)
  const range: ServerRangeFacts | null =
    rangeRecord === null
      ? null
      : {
          supported: asBoolean(rangeRecord.supported),
          acceptRanges: asString(rangeRecord.acceptRanges),
          ifRange: asBoolean(rangeRecord.ifRange),
          probedBy: asString(rangeRecord.probedBy),
          probeStatus: asNumber(rangeRecord.probeStatus),
          probeBytes: asNumber(rangeRecord.probeBytes),
        }
  const validatorsRecord = asRecordOrNull(record.validators)
  const validators: ServerValidators | null =
    validatorsRecord === null
      ? null
      : {
          etag: asString(validatorsRecord.etag),
          strongEtag: asBoolean(validatorsRecord.strongEtag),
          lastModified: asString(validatorsRecord.lastModified),
        }
  const resumeRecord = asRecordOrNull(record.resume)
  const resume: ServerResumeFacts | null =
    resumeRecord === null
      ? null
      : {
          possible: asBoolean(resumeRecord.possible),
          safety: asResumeSafety(resumeRecord.safety),
          reason: asString(resumeRecord.reason),
        }
  const signedRecord = asRecordOrNull(record.signedUrl)
  const signedUrl: ServerSignedUrl | null =
    signedRecord === null
      ? null
      : {
          signed: asBoolean(signedRecord.signed),
          expiresAt: asNumber(signedRecord.expiresAt),
          expiresInSecs: asNumber(signedRecord.expiresInSecs),
          source: asString(signedRecord.source),
          state: asString(signedRecord.state),
        }
  const tlsRecord = asRecordOrNull(record.tls)
  const tls: ServerTlsFacts | null =
    tlsRecord === null
      ? null
      : {
          https: asBoolean(tlsRecord.https),
          notAfter: asNumber(tlsRecord.notAfter),
          expiresInSecs: asNumber(tlsRecord.expiresInSecs),
          issuer: asString(tlsRecord.issuer),
          subject: asString(tlsRecord.subject),
          state: asString(tlsRecord.state),
        }
  const redirects: ServerRedirect[] = asArray(record.redirects).map((hop) => {
    const hopRecord = asRecord(hop) ?? {}
    return { status: asNumber(hopRecord.status), url: asString(hopRecord.url) ?? '' }
  })
  const headersRecord = asRecordOrNull(record.headers)
  const headers = headersRecord === null ? null : (headersRecord as Record<string, string | null>)
  const rateRecord = asRecordOrNull(record.rateLimit)
  const rateLimit: ServerRateLimit | null =
    rateRecord === null
      ? null
      : {
          retryAfterSecs: asNumber(rateRecord.retryAfterSecs),
          limit: asNumber(rateRecord.limit),
          remaining: asNumber(rateRecord.remaining),
        }
  const timingRecord = asRecordOrNull(record.timing)
  const timing: ServerFacts['timing'] =
    timingRecord === null
      ? null
      : {
          probeMs: asNumber(timingRecord.probeMs),
          ttfbMs: asNumber(timingRecord.ttfbMs),
          sampleBps: asRate(timingRecord.sampleBps),
        }
  const checksumRecord = asRecordOrNull(record.checksum)
  const checksum: ServerChecksums | null =
    checksumRecord === null
      ? null
      : {
          digest: asString(checksumRecord.digest),
          contentMd5: asString(checksumRecord.contentMd5),
          sha256: asString(checksumRecord.sha256),
        }
  const recommendationRecord = asRecordOrNull(record.recommendation)
  const recommendation: ServerRecommendation | null =
    recommendationRecord === null
      ? null
      : {
          start: asString(recommendationRecord.start),
          connections: asNumber(recommendationRecord.connections),
          chunkSizeBytes: asNumber(recommendationRecord.chunkSizeBytes),
          singleStream: asBoolean(recommendationRecord.singleStream),
          reason: asString(recommendationRecord.reason),
          verify: asString(recommendationRecord.verify),
        }
  const originRecord = asRecordOrNull(record.origin)
  const origin: ServerOrigin | null =
    originRecord === null
      ? null
      : {
          known: asBoolean(originRecord.known),
          attempts: asNumber(originRecord.attempts),
          completed: asNumber(originRecord.completed),
          medianBps: asRate(originRecord.medianBps),
          bestBps: asRate(originRecord.bestBps),
          lastError: asString(originRecord.lastError),
          lastAt: asNumber(originRecord.lastAt),
        }
  return {
    url: asString(record.url),
    finalUrl: asString(record.finalUrl),
    host: asString(record.host),
    httpVersion: asString(record.httpVersion),
    status: asNumber(record.status),
    fileName: asString(record.fileName),
    fileNameSource: asString(record.fileNameSource),
    totalBytes: asNumber(record.totalBytes),
    contentType: asString(record.contentType),
    contentEncoding: asString(record.contentEncoding),
    contentDisposition: asString(record.contentDisposition),
    range,
    validators,
    resume,
    signedUrl,
    tls,
    redirects,
    headers,
    rateLimit,
    timing,
    checksum,
    warnings: asArray(record.warnings).filter((warning): warning is string => typeof warning === 'string'),
    recommendation,
    origin,
  }
}

function normalizeTelemetry(value: unknown): TaskTelemetry | null {
  const record = asRecord(value)
  if (record === null) return null
  return {
    windows: asWindows(record.windows) ?? { w1: null, w5: null, w30: null, w300: null },
    peakBps: asRate(record.peakBps),
    avgBps: asRate(record.avgBps),
    stalledMs: asNumber(record.stalledMs),
    trend: asTrend(record.trend),
    etaConfidence: asConfidence(record.etaConfidence),
    samples: asNumber(record.samples),
    lastSampleAt: asNumber(record.lastSampleAt),
  }
}

function normalizeDetail(value: unknown): TaskDetail | null {
  const record = asRecord(value)
  if (record === null) return null
  const targetRecord = asRecordOrNull(record.target)
  const target: TaskTarget | null =
    targetRecord === null
      ? null
      : {
          dir: asString(targetRecord.dir),
          path: asString(targetRecord.path),
          part: asString(targetRecord.part),
          resumeState: asString(targetRecord.resumeState),
        }
  const verificationRecord = asRecordOrNull(record.verification)
  const verification: TaskVerification | null =
    verificationRecord === null
      ? null
      : {
          expectedSha256: asString(verificationRecord.expectedSha256),
          sha256: asString(verificationRecord.sha256),
          verified: asBoolean(verificationRecord.verified),
          serverChecksums: normalizeChecksums(verificationRecord.serverChecksums),
        }
  const resumeRecord = asRecordOrNull(record.resumeState)
  const resumeState: TaskResumeState | null =
    resumeRecord === null
      ? null
      : {
          chunksDone: asNumber(resumeRecord.chunksDone),
          bytesDone: asNumber(resumeRecord.bytesDone),
          resumedChunks: asNumber(resumeRecord.resumedChunks),
          resumedBytes: asNumber(resumeRecord.resumedBytes),
          validatorsMatched: asBoolean(resumeRecord.validatorsMatched),
        }
  const timingRecord = asRecordOrNull(record.timing)
  const timing: TaskTiming | null =
    timingRecord === null
      ? null
      : {
          queuedMs: asNumber(timingRecord.queuedMs),
          probeMs: asNumber(timingRecord.probeMs),
          transferMs: asNumber(timingRecord.transferMs),
          finalizeMs: asNumber(timingRecord.finalizeMs),
        }
  const diagnosis: TaskDiagnosis[] = asArray(record.diagnosis).map((entry) => {
    const entryRecord = asRecord(entry) ?? {}
    return {
      code: asString(entryRecord.code) ?? 'unknown',
      advice: asString(entryRecord.advice) ?? '',
      message: asString(entryRecord.message) ?? '',
    }
  })
  return {
    telemetry: normalizeTelemetry(record.telemetry),
    server: normalizeServer(record.server),
    target,
    verification,
    resumeState,
    timing,
    diagnosis,
  }
}

function normalizeChecksums(value: unknown): ServerChecksums {
  const record = asRecord(value) ?? {}
  return {
    digest: asString(record.digest),
    contentMd5: asString(record.contentMd5),
    sha256: asString(record.sha256),
  }
}

/** Normalize the `get` action value; a 0.1.x host returns no `detail`. */
export function normalizeGet(value: unknown): GetValue {
  const record = asRecord(value) ?? {}
  const task = normalizeTask(record.task)
  return {
    task,
    detail: normalizeDetail(record.detail),
    events: asArray(record.events).map(normalizeEvent),
  }
}

/** Normalize the `stats` action value. */
export function normalizeStats(value: unknown): StatsValue {
  const record = asRecord(value) ?? {}
  const countsRecord = asRecordOrNull(record.tasks)
  const totalsRecord = asRecordOrNull(record.totals)
  let counts: Aggregate | null = null
  if (countsRecord !== null && hasTaskCounts(countsRecord)) {
    const record = countsRecord
    const completed = asNumber(record.completed) ?? 0
    const failed = asNumber(record.failed) ?? 0
    const active =
      asNumber(record.active) ??
      (asNumber(record.running) ?? 0) + (asNumber(record.queued) ?? 0) + (asNumber(record.probing) ?? 0)
    const total = asNumber(record.total) ?? active + completed + failed
    counts = {
      total,
      active,
      paused: asNumber(record.paused) ?? 0,
      failed,
      completed,
      bytesDownloaded: asNumber(totalsRecord?.bytesDownloaded) ?? 0,
      nowBps: asRate(totalsRecord?.nowBps) ?? 0,
      w5Bps: asRate(totalsRecord?.w5Bps),
      w30Bps: asRate(totalsRecord?.w30Bps),
      w300Bps: asRate(totalsRecord?.w300Bps),
      riskCount: asNumber(record.riskCount) ?? 0,
    }
  }
  const throughput = asWindows(record.throughput ?? totalsRecord)
  return {
    protocol: asNumber(record.protocol),
    kernel: normalizeKernel(record.kernel),
    counts,
    throughput,
    origins: asNumber(record.origins),
  }
}

function hasTaskCounts(value: Record<string, unknown> | null): boolean {
  if (value === null) return false
  return ['total', 'active', 'completed', 'failed'].some((key) => typeof value[key] === 'number')
}
