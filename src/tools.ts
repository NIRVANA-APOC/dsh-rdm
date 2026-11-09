/**
 * Model-facing tool surface of `dsh-rdm`.
 *
 * Six tools drive the resident RDM kernel through {@link KernelService}:
 * `rdm_download`, `rdm_probe`, `rdm_tasks`, `rdm_wait`, `rdm_control`,
 * `rdm_history`.
 *
 * Conventions:
 *  - parameters are schema-validated before `execute` runs;
 *  - `execute` returns one canonical JSON value (bounded), and `render` is a
 *    pure line-oriented receipt of that value — the model reads the receipt;
 *  - `exec.signal` is checked before any work and forwarded to long requests;
 *  - the owning agent session is read from the execution context
 *    (`exec.agent.session.id`), never from a model-supplied parameter.
 *
 * Receipt format (design §3.4): one record per line, stable field order,
 * `key=value` fields separated by single spaces, `-` for `null`, compact binary
 * byte units and single-unit durations. No prose, no JSON wrapper.
 *
 * @module dsh-rdm/tools
 */

import { defineTool } from './tool-def'
import type { ToolDefinition, ToolRunContext } from './tool-def'

import {
  KernelError,
  normalizeSessionId,
  normalizeStatusFilter,
  normalizeTaskId,
} from './kernel-client'
import type { KernelService } from './kernel-client'
import {
  DEFAULT_HISTORY_EVENTS,
  DEFAULT_HISTORY_SAMPLES,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_WAIT_MS,
  DEFAULT_WAIT_PROBE_MS,
  MAX_CONNECTIONS,
  MAX_HISTORY_SAMPLES,
  MAX_TASK_IDS,
  MAX_WAIT_MS,
  MAX_WAIT_PROBE_MS,
  MIN_WAIT_MS,
  TASK_EVENT_KINDS,
  TASK_STATUSES,
  TOOL_LIST_DEFAULT,
  TOOL_LIST_MAX,
  TOOL_MAX_EVENTS,
  type Aggregate,
  type ControlAction,
  type Diagnosis,
  type KernelStatusView,
  type ServerFacts,
  type TaskDetail,
  type TaskEvent,
  type TaskHistory,
  type TaskHistoryEvent,
  type TaskHistorySample,
  type TaskView,
  type TelemetryDetail,
  type ToolError,
} from './protocol'

// ── Receipt formatting (pure; exported for tests) ───────────────────────────

/** Rendered value for `null`. */
const DASH = '-'

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/** Collapse whitespace and bound free text so one value stays on one line. */
function collapse(value: string, max = 160): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** Format a byte count compactly (`48.1MiB`, `1.5MiB`, `512B`); `-` when unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return DASH
  if (bytes < 1024) return `${Math.round(bytes)}B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  const trimmed = rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded
  return `${trimmed}${BYTE_UNITS[unit]}`
}

/** Bytes per rendered unit, used to print a progress pair in one unit. */
const UNIT_BYTES: Record<string, number> = { B: 1 }
for (let index = 0; index < BYTE_UNITS.length; index += 1) {
  UNIT_BYTES[BYTE_UNITS[index]] = 1024 ** (index + 1)
}

/**
 * Progress pair in one shared unit (`20.2/48.1MiB`), or the downloaded size
 * alone when the total is unknown.
 */
export function formatProgressPair(downloaded: number, total: number | null): string {
  if (total === null || !Number.isFinite(total) || total <= 0) return formatBytes(downloaded)
  const totalText = formatBytes(total)
  const match = /^([\d.]+)([A-Za-z]+)$/.exec(totalText)
  if (match === null) return formatBytes(downloaded)
  const unit = match[2]
  const divisor = UNIT_BYTES[unit] ?? 1
  const value = downloaded / divisor
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  const trimmed = rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded
  return `${trimmed}/${totalText}`
}

/** Format a transfer rate (`1.4MiB/s`, `0B/s`); `-` when unknown. */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return DASH
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return DASH
  if (bytesPerSecond === 0) return '0B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Format milliseconds as a single compact duration (`84ms`, `12s`, `3m04s`). */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return DASH
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatDurationSecs(ms / 1000)
}

/** Format seconds as a compact duration (`12s`, `3m04s`, `19m40s`, `40d`). */
export function formatDurationSecs(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return DASH
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
  if (total < 86_400) {
    return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`
  }
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  return hours === 0 ? `${days}d` : `${days}d${String(hours).padStart(2, '0')}h`
}

/** Format a whole percentage (`42%`); `-` when unknown. */
export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return DASH
  return `${Math.min(100, Math.max(0, Math.round(percent)))}%`
}

/** Format a nullable boolean (`true`/`false`); `-` when unknown. */
function formatFlag(value: boolean | null | undefined): string {
  return value === true ? 'true' : value === false ? 'false' : DASH
}

/** Format an epoch millisecond timestamp as `HH:MM:SS` UTC. */
export function formatClock(at: number | null | undefined): string {
  if (at === null || at === undefined || !Number.isFinite(at) || at <= 0) return DASH
  return new Date(at).toISOString().slice(11, 19)
}

/** `state(ttl)` for an expiry fact (`valid(19m40s)`), or just the state. */
function expiryToken(
  state: string | null | undefined,
  expiresInSecs: number | null | undefined,
): string {
  if (state === null || state === undefined || state === '' || state === 'unknown') return DASH
  if (state === 'expired' || expiresInSecs === null || expiresInSecs === undefined) return state
  return `${state}(${formatDurationSecs(expiresInSecs)})`
}

/** Resume-safety render token: the protocol vocabulary, unchanged. */
function resumeToken(safety: string | null | undefined): string {
  if (safety === null || safety === undefined) return DASH
  return safety
}

/** Range-support token for a task view (`bytes`/`none`/`-`). */
function taskRangeToken(rangeSupported: boolean | null): string {
  return rangeSupported === true ? 'bytes' : rangeSupported === false ? 'none' : DASH
}

/** Integrity-source token: the best server checksum, or `none`. */
function checksumToken(checksum: {
  contentDigest: string | null
  contentMd5: string | null
  sha256: string | null
  crc32c: string | null
}): string {
  if (checksum.sha256 !== null) return 'sha256'
  if (checksum.contentMd5 !== null) return 'md5'
  if (checksum.contentDigest !== null) return 'digest'
  if (checksum.crc32c !== null) return 'crc32c'
  return 'none'
}

/** Plan `verify` token: the kernel's recommendation value, rendered faithfully. */
function verifyRecommendationToken(server: ServerFacts | null): string {
  return server === null ? DASH : server.recommendation.verify
}

/** First 8 hex characters of a hash, or `-`. */
function shortHash(hash: string | null): string {
  return hash === null || hash === '' ? DASH : hash.slice(0, 8)
}

/**
 * Verify line: the verdict plus the 8-char hash token the caller should quote.
 * `sha=expected:<prefix>` before verification, `sha=verified:<prefix>` after.
 */
function renderVerifyLine(
  expectedSha256: string | null,
  sha256: string | null,
  verified: boolean | null,
  checksums?: {
    contentDigest: string | null
    contentMd5: string | null
    sha256: string | null
    crc32c: string | null
  },
): string {
  const parts = [`verify state=${verifyStateToken(verified)}`]
  if (verified === true && sha256 !== null) parts.push(`sha=verified:${shortHash(sha256)}`)
  else if (expectedSha256 !== null) parts.push(`sha=expected:${shortHash(expectedSha256)}`)
  else if (sha256 !== null) parts.push(`sha=actual:${shortHash(sha256)}`)
  if (checksums !== undefined) {
    const available = [
      checksums.sha256 === null ? '' : 'sha256',
      checksums.contentMd5 === null ? '' : 'md5',
      checksums.contentDigest === null ? '' : 'digest',
      checksums.crc32c === null ? '' : 'crc32c',
    ].filter((entry) => entry !== '')
    parts.push(`checksums=${available.length > 0 ? available.join(',') : DASH}`)
  }
  return parts.join(' ')
}

/** `verified` verdict token (`verified`/`mismatch`/`not-compared`). */
function verifyStateToken(verified: boolean | null | undefined): string {
  return verified === true ? 'verified' : verified === false ? 'mismatch' : 'not-compared'
}

/** The line every task summary shows: percent and byte progress. */
function progressLine(task: TaskView): string {
  return `${formatPercent(task.percent)} ${formatProgressPair(task.downloaded, task.total)}`
}

/** One compact task record line (`t_... running 42% 20.2/48.1MiB ...`). */
export function renderTaskRecord(task: TaskView, includeSession = false): string {
  const parts: string[] = [
    task.id,
    task.status,
    progressLine(task),
    formatRate(task.speedBps),
  ]
  if (task.speed5sBps !== null) parts.push(`w5=${formatRate(task.speed5sBps)}`)
  if (task.etaSecs !== null) parts.push(`eta=${formatDurationSecs(task.etaSecs)}(${task.etaConfidence})`)
  parts.push(`workers=${task.activeWorkers}/${task.peakWorkers}`)
  parts.push(`range=${taskRangeToken(task.rangeSupported)}`)
  parts.push(`resume=${resumeToken(task.resumeSafety)}`)
  parts.push(`name=${task.fileName !== '' ? task.fileName : DASH}`)
  if (task.error !== null) parts.push(`error=${task.error.code}`)
  if (includeSession) parts.push(`session=${task.sessionId ?? DASH}`)
  return parts.join(' ')
}

/** Kernel process line. */
function renderKernelLine(kernel: KernelStatusView): string {
  const state = kernel.running ? 'running' : kernel.starting ? 'starting' : 'stopped'
  const parts = [`state=${state}`, `version=${kernel.version ?? DASH}`, `pid=${kernel.pid ?? DASH}`]
  if (kernel.error !== null) parts.push(`error="${collapse(kernel.error)}"`)
  return `kernel ${parts.join(' ')}`
}

/** Aggregate line used by the task list. */
function renderAggregateLine(aggregate: Aggregate): string {
  return [
    `aggregate total=${aggregate.total}`,
    `active=${aggregate.active}`,
    `paused=${aggregate.paused}`,
    `failed=${aggregate.failed}`,
    `completed=${aggregate.completed}`,
    `bytes=${formatBytes(aggregate.bytesDownloaded)}`,
    `now=${formatRate(aggregate.nowBps)}`,
    `w5=${formatRate(aggregate.w5Bps)}`,
    `w30=${formatRate(aggregate.w30Bps)}`,
    `w300=${formatRate(aggregate.w300Bps)}`,
    `risk=${aggregate.riskCount}`,
  ].join(' ')
}

/** Server-fact block shared by the probe, download and detail receipts. */
function renderServerLines(server: ServerFacts): string[] {
  const signed = server.signedUrl.signed
    ? expiryToken(server.signedUrl.state, server.signedUrl.expiresInSecs)
    : DASH
  const tls = server.tls === null ? DASH : expiryToken(server.tls.state, server.tls.expiresInSecs)
  return [
    `server host=${server.host !== '' ? server.host : DASH} status=${server.status} size=${formatBytes(server.totalBytes)} http=${server.httpVersion ?? DASH}`,
    `range=${server.range.acceptRanges} resume=${resumeToken(server.resume.safety)} signed=${signed} tls=${tls} checksum=${checksumToken(server.checksum)}`,
    `plan connections=${server.recommendation.connections} chunk=${server.recommendation.chunkSizeBytes === null ? 'auto' : formatBytes(server.recommendation.chunkSizeBytes)} verify=${verifyRecommendationToken(server)} reason=${server.recommendation.reason !== '' ? server.recommendation.reason : DASH}`,
  ]
}

/** Follow-up commands for a task (the receipt's `next` line). */
function nextLine(task: TaskView): string {
  return `next rdm_tasks taskId=${task.id} | rdm_wait taskIds=["${task.id}"] timeoutSec=60`
}

/** Download receipt: task header, target, preflight outcome, server facts, plan, next. */
export function renderDownloadReceipt(value: DownloadValue): string[] {
  const task = value.task
  const preflight = value.server !== null ? 'ok' : value.preflightTimedOut ? 'timeout' : 'skipped'
  const lines: string[] = [
    `task ${task.id} state=${task.status} session=${task.sessionId ?? DASH} preflight=${preflight}`,
    `url ${task.url}`,
  ]
  if (task.path !== null && task.path !== '') lines.push(`file ${task.path}`)
  if (task.error !== null) lines.push(renderErrorLine(task.error))
  if (value.server !== null) lines.push(...renderServerLines(value.server))
  if (task.expectedSha256 !== null || task.sha256 !== null || task.verified !== null) {
    lines.push(renderVerifyLine(task.expectedSha256, task.sha256, task.verified))
  }
  lines.push(nextLine(task))
  return lines
}

/** Probe receipt: the server-fact record and the recommended next call. */
export function renderProbeReceipt(value: ProbeValue): string[] {
  const server = value.server
  if (server === null) {
    const lines: string[] = []
    if (value.error != null) lines.push(renderErrorLine(value.error))
    lines.push(renderNextLine(value.hint))
    return lines
  }
  const lines: string[] = [
    `probe host=${server.host !== '' ? server.host : DASH} status=${server.status} http=${server.httpVersion ?? DASH}`,
    `url ${server.finalUrl !== '' ? server.finalUrl : server.url}`,
  ]
  for (const hop of server.redirects.slice(0, 8)) {
    lines.push(`hop status=${hop.status} url=${hop.url}`)
  }
  lines.push(
    `file name=${server.fileName !== '' ? server.fileName : DASH} source=${server.fileNameSource} size=${formatBytes(server.totalBytes)} type=${server.contentType ?? DASH} encoding=${server.contentEncoding ?? DASH}`,
  )
  // Only the range line of the shared server block; the probe gets the richer
  // plan line below (with start/singleStream).
  lines.push(renderServerLines(server)[1])
  lines.push(
    `plan start=${server.recommendation.start} connections=${server.recommendation.connections} chunk=${server.recommendation.chunkSizeBytes === null ? 'auto' : formatBytes(server.recommendation.chunkSizeBytes)} singleStream=${formatFlag(server.recommendation.singleStream)} verify=${verifyRecommendationToken(server)} reason=${server.recommendation.reason !== '' ? server.recommendation.reason : DASH}`,
  )
  lines.push(
    `headers server=${server.headers.server ?? DASH} cache=${server.headers.cacheControl ?? DASH} vary=${server.headers.vary ?? DASH}`,
  )
  if (
    server.rateLimit.retryAfterSecs !== null ||
    server.rateLimit.limit !== null ||
    server.rateLimit.remaining !== null
  ) {
    lines.push(
      `ratelimit retryAfter=${server.rateLimit.retryAfterSecs === null ? DASH : `${server.rateLimit.retryAfterSecs}s`} limit=${server.rateLimit.limit ?? DASH} remaining=${server.rateLimit.remaining ?? DASH}`,
    )
  }
  lines.push(
    `warnings=${server.warnings.length > 0 ? server.warnings.join(',') : DASH} redirects=${server.redirects.length}`,
  )
  const origin =
    server.origin === null
      ? DASH
      : [
          'known',
          `attempts=${server.origin.attempts}`,
          `completed=${server.origin.completed}`,
          `median=${formatRate(server.origin.medianBps)}`,
          `best=${formatRate(server.origin.bestBps)}`,
          `lastError=${server.origin.lastError ?? DASH}`,
        ].join(' ')
  lines.push(
    `timing probe=${formatDurationMs(server.timing.probeMs)} ttfb=${formatDurationMs(server.timing.ttfbMs)} sample=${formatRate(server.timing.sampleBps)} origin=${origin}`,
  )
  lines.push(`next rdm_download url=${server.finalUrl !== '' ? server.finalUrl : server.url}`)
  return lines
}

/** List receipt: kernel, scope, aggregate, then one line per task. */
export function renderTasksListReceipt(value: TasksListValue): string[] {
  const lines: string[] = [renderKernelLine(value.kernel)]
  lines.push(`scope=${value.scope} count=${value.tasks.length}`)
  lines.push(renderAggregateLine(value.aggregate))
  for (const task of value.tasks) lines.push(renderTaskRecord(task, value.scope === 'all'))
  if (value.error != null) {
    lines.push(renderErrorLine(value.error))
    lines.push(renderNextLine(value.hint))
  }
  return lines
}

/** Telemetry lines of a task detail. */
function renderTelemetryLines(telemetry: TelemetryDetail): string[] {
  const windows = telemetry.windows
  return [
    `telemetry trend=${telemetry.trend} samples=${telemetry.samples} peak=${formatRate(telemetry.peakBps)} avg=${formatRate(telemetry.avgBps)} stalled=${formatDurationMs(telemetry.stalledMs)} w1=${formatRate(windows['1s'])} w5=${formatRate(windows['5s'])} w30=${formatRate(windows['30s'])} w300=${formatRate(windows['300s'])}`,
  ]
}

/** One diagnosis record line. */
function renderDiagnosisLine(diagnosis: Diagnosis): string {
  const parts = [`code=${diagnosis.code}`, `advice=${diagnosis.advice !== '' ? diagnosis.advice : DASH}`]
  if (diagnosis.message !== '') parts.push(`msg="${collapse(diagnosis.message)}"`)
  return `diagnosis ${parts.join(' ')}`
}

/** One diagnostic event record line. */
export function renderTaskEventLine(event: TaskEvent): string {
  const parts = [`seq=${event.seq}`, `at=${formatClock(event.at)}`, `kind=${event.kind}`]
  if (event.chunk !== null) parts.push(`chunk=${event.chunk}`)
  if (event.attempt !== null) parts.push(`attempt=${event.attempt}`)
  if (event.delayMs !== null) parts.push(`delay=${formatDurationMs(event.delayMs)}`)
  if (event.message !== null && event.message !== '') parts.push(`msg="${collapse(event.message)}"`)
  return `event ${parts.join(' ')}`
}

/** One-task receipt: header, telemetry, resume decision, server, target, verify, timing, diagnosis, events. */
export function renderTaskDetailReceipt(value: TaskDetailValue): string[] {
  if (value.task === null || value.detail === null) {
    const lines: string[] = [renderKernelLine(value.kernel)]
    if (value.error != null) lines.push(renderErrorLine(value.error))
    lines.push(renderNextLine(value.hint))
    return lines
  }
  const task = value.task
  const detail = value.detail
  const lines: string[] = [
    renderKernelLine(value.kernel),
    `task ${task.id} state=${task.status} session=${task.sessionId ?? DASH}`,
    `url ${task.url}`,
    `file name=${task.fileName !== '' ? task.fileName : DASH} path=${task.path ?? DASH} dir=${task.dir !== '' ? task.dir : DASH}`,
    `progress ${progressLine(task)} workers=${task.activeWorkers}/${task.peakWorkers} range=${taskRangeToken(task.rangeSupported)} resume=${resumeToken(task.resumeSafety)}`,
    ...renderTelemetryLines(detail.telemetry),
  ]
  // 0.3.0 headline evidence: whether (and why) the plan adopted the `.part`
  // bytes that already existed. `not-attempted` adds no line.
  const resumeState = detail.resumeState
  if (resumeState.resumeDecision !== 'not-attempted') {
    lines.push(
      `resume decision=${resumeState.resumeDecision} reason=${resumeState.resumeReason ?? DASH}`,
    )
  }
  if (detail.server === null) {
    lines.push(`server=${DASH}`)
  } else {
    lines.push(...renderServerLines(detail.server))
  }
  lines.push(
    `target part=${detail.target.part ?? DASH} resume=${detail.target.resumeState ?? DASH}`,
  )
  const verification = detail.verification
  lines.push(
    renderVerifyLine(
      verification.expectedSha256,
      verification.sha256,
      verification.verified,
      verification.serverChecksums,
    ),
  )
  lines.push(
    `timing queued=${formatDurationMs(detail.timing.queuedMs)} probe=${formatDurationMs(detail.timing.probeMs)} transfer=${formatDurationMs(detail.timing.transferMs)} finalize=${formatDurationMs(detail.timing.finalizeMs)}`,
  )
  for (const diagnosis of detail.diagnosis) lines.push(renderDiagnosisLine(diagnosis))
  for (const event of value.events) lines.push(renderTaskEventLine(event))
  return lines
}

/** Wait receipt. */
export function renderWaitReceipt(value: WaitValue): string[] {
  const lines = [`wait timedOut=${value.timedOut} count=${value.tasks.length}`]
  for (const task of value.tasks) lines.push(renderTaskRecord(task))
  if (value.error != null) {
    lines.push(renderErrorLine(value.error))
    lines.push(renderNextLine(value.hint))
  }
  return lines
}

/** Control receipt. */
export function renderControlReceipt(value: ControlValue): string[] {
  if (value.error != null) {
    return [
      `control action=${value.action} task=${DASH}`,
      renderErrorLine(value.error),
      renderNextLine(value.hint),
    ]
  }
  if (value.action === 'remove') {
    return [`control action=remove removedId=${value.removedId ?? DASH} deletePart=${formatFlag(value.deletePart)}`]
  }
  const lines = [`control action=${value.action} task=${value.task === null ? DASH : value.task.id}`]
  if (value.task !== null) lines.push(renderTaskRecord(value.task))
  return lines
}

/**
 * History receipt (0.3.0/0.2.2): one summary line, the two JSONL paths, the
 * returned sample range, one `build=` line when the recording spans kernel
 * builds, and (on failure) the canonical error + follow-up.
 *
 * The summary uses the returned page for peak/avg rates and the recorded total
 * for the sample count, so it stays stable while paging.
 */
export function renderHistoryReceipt(value: HistoryValue, offset = 0): string[] {
  const samples = value.samples
  let peak: number | null = null
  let sum = 0
  for (const sample of samples) {
    sum += sample.bps
    if (peak === null || sample.bps > peak) peak = sample.bps
  }
  const avg = samples.length > 0 ? sum / samples.length : null
  const lines: string[] = [
    `history task=${value.taskId} samples=${value.totalSamples} peak=${formatRate(peak)} avg=${formatRate(avg)}`,
    `samples ${value.samplesPath ?? DASH}`,
    `events ${value.eventsPath ?? DASH}`,
    `range ${offset}..${offset + samples.length} of ${value.totalSamples}`,
  ]
  // 0.2.2: one bounded build-tag line when the recording spans kernel builds.
  const builds = Array.isArray(value.builds) ? value.builds : []
  if (builds.length > 0) lines.push(`build=${builds.join(',')}`)
  if (value.error != null) {
    lines.push(renderErrorLine(value.error))
    lines.push(renderNextLine(value.hint))
  }
  return lines
}

// ── Error mapping ───────────────────────────────────────────────────────────

/** Actionable follow-up per kernel error code. */
const ERROR_HINTS: Record<string, string> = {
  kernel_missing:
    'Build the kernel with "bash scripts/dev-build.sh kernel" (or "node scripts/build-kernel.mjs") or set the plugin config "kernelPath", then retry.',
  kernel_spawn: 'The kernel process could not start; check the binary path/permissions for this platform.',
  kernel_exited:
    'The kernel child exited; the plugin restarts it on the next call. Interrupted tasks keep their resume state, so re-check with rdm_tasks before starting over.',
  kernel_crashed:
    'The kernel is crashing repeatedly. Inspect its stderr log or rebuild it; do not keep retrying blindly.',
  kernel_stopped: 'The plugin is unloading/reloading; retry after it registers rdm_* again.',
  kernel_not_running: 'The kernel child is not ready yet; retry in a moment.',
  protocol_mismatch:
    'This plugin needs a protocol-2 (kernel 0.2.2) build. Rebuild the kernel for this plugin or point the plugin config "kernelPath" at a matching binary; protocol 1 binaries cannot be used.',
  timeout:
    'The kernel is still busy. Check progress with rdm_tasks (taskId=...) and rdm_wait instead of resubmitting the same download.',
  cancelled: 'The call was cancelled; nothing else was changed.',
  invalid_request: 'Fix the arguments and retry; no task was created.',
  not_found: 'Use rdm_tasks without taskId to list the existing task ids.',
  conflict: 'That action is not valid for the current status; re-check the task with rdm_tasks.',
  http_status: 'The origin rejected the request; verify the URL and any cookie/headers/auth values.',
  network: 'Network/DNS/TLS failure after retries; check connectivity, the URL, or the proxy setting.',
  remote_changed:
    'The remote file changed during resume. Use rdm_control action=retry (restarts from zero), then download again.',
  checksum_mismatch:
    'The downloaded bytes did not match expectedSha256, so the file was not finalized. Verify the hash value or retry the download.',
  io: 'Local filesystem error; check that the destination directory exists and is writable.',
  unsupported: 'The kernel cannot honor this request; simplify the parameters (for example drop singleStream/insecure).',
  unsupported_method:
    'The running kernel binary does not implement this method (it predates this plugin). Rebuild or upgrade the kernel binary to 0.2.2 (dsh-rdm 0.2.2+) and retry.',
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

// ── Recoverable failures (canonical values, design §3.5) ────────────────────

/**
 * Kernel codes that are expected operational failures rather than invalid
 * usage or plugin/kernel wiring faults. These must come back as canonical
 * `{error, hint}` values (DSH would otherwise flatten a thrown call to
 * `Error: <message>` and drop the structured detail).
 */
const RECOVERABLE_KERNEL_CODES = new Set([
  'network',
  'http_status',
  'not_found',
  'conflict',
  'remote_changed',
  'checksum_mismatch',
  'io',
  'unsupported',
  // 0.2.2 §1.7: an old kernel that lacks a method answers with a stable error;
  // the tool returns it as a normal recoverable value (with an upgrade hint).
  'unsupported_method',
])

/** Map a thrown error to a canonical `{code,message}`, or `null` when it must throw. */
function recoverableError(error: unknown): ToolError | null {
  if (error instanceof KernelError && RECOVERABLE_KERNEL_CODES.has(error.code)) {
    return { code: error.code, message: error.message }
  }
  return null
}

/** One `error code=... message=...` receipt line (design §3.5 example). */
function renderErrorLine(error: ToolError): string {
  return `error code=${error.code} message=${collapse(error.message)}`
}

/** One `next ...` receipt line (bounded follow-up command/advice). */
function renderNextLine(hint: string): string {
  return `next ${collapse(hint, 220)}`
}

/** Canonical hint for a recoverable `rdm_probe` failure. */
function probeErrorHint(url: string, error: ToolError): string {
  if (error.code === 'http_status') {
    return `rdm_probe url=${url} again after verifying the URL and auth headers.`
  }
  return `retry rdm_probe url=${url} once | verify the URL, network and any auth headers.`
}

/** Canonical hint for a recoverable `rdm_tasks` failure. */
function tasksErrorHint(error: ToolError): string {
  if (error.code === 'not_found') return 'rdm_tasks without taskId lists the existing ids.'
  return 'retry rdm_tasks; if it persists, report the kernel error to the user.'
}

/** Canonical hint for a recoverable `rdm_control` failure. */
function controlErrorHint(action: ControlAction, taskId: string, error: ToolError): string {
  if (error.code === 'not_found') return 'rdm_tasks without taskId lists the existing ids.'
  if (error.code === 'conflict') {
    return `rdm_tasks taskId=${taskId} then retry rdm_control action=${action} once the status permits.`
  }
  return `rdm_tasks taskId=${taskId} then retry rdm_control taskId=${taskId} action=${action}.`
}

/** Canonical hint for a recoverable `rdm_wait` failure. */
function waitErrorHint(error: ToolError): string {
  if (error.code === 'not_found') {
    return 'rdm_tasks without taskId lists the existing ids; re-check the taskIds and retry rdm_wait.'
  }
  return 'retry rdm_wait; if it persists, inspect the tasks with rdm_tasks.'
}

/** Canonical hint for a recoverable `rdm_history` failure. */
function historyErrorHint(taskId: string, error: ToolError): string {
  if (error.code === 'not_found') return 'rdm_tasks without taskId lists the existing ids.'
  if (error.code === 'unsupported_method') {
    return 'upgrade the kernel binary to 0.2.2 (dsh-rdm 0.2.2+); the running build does not implement rdm_history.'
  }
  return `retry rdm_history taskId=${taskId}; if it persists, report the kernel error to the user.`
}

/** Follow-up hint after a successful `rdm_history` read. */
function historyHint(history: TaskHistory, includeEvents: boolean): string {
  if (history.totalSamples === 0) {
    return `No recording yet; rdm_tasks taskId=${history.taskId} shows live telemetry, and samples are persisted while a transfer runs.`
  }
  const events = includeEvents ? ` and ${history.events.length} recorded events` : ''
  return `Replay ${history.samples.length} samples${events}; rdm_tasks taskId=${history.taskId} shows the live state.`
}

// ── Session attribution ─────────────────────────────────────────────────────

/**
 * Read the calling agent's session id from the execution context.
 *
 * `exec.agent.session.id` is the harness contract; every level is optional at
 * runtime (a tool may run outside a session), so a missing/odd shape simply
 * yields `null` instead of failing the download.
 */
export function sessionIdFromExec(exec: ToolRunContext): string | null {
  const agent: unknown = exec.agent
  if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) return null
  const session = (agent as Record<string, unknown>).session
  if (session === null || typeof session !== 'object' || Array.isArray(session)) return null
  const id = (session as Record<string, unknown>).id
  if (typeof id !== 'string') return null
  try {
    return normalizeSessionId(id)
  } catch {
    // A malformed live session id must not break the tool call.
    return null
  }
}

// ── Schema helpers (the defineTool output DSL) ──────────────────────────────

type SchemaNode = Record<string, any>

/** Object node: the DSL requires an explicit `additionalProperties`. */
function objectNode(properties: Record<string, SchemaNode>, additionalProperties = false): SchemaNode {
  return { type: 'object', additionalProperties, properties }
}

/** Nullable scalar/object/array node. */
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

/** Mark a property schema required (the parent object collects the flag). */
function req(node: SchemaNode): SchemaNode {
  return { ...node, required: true }
}

/** Required string field. */
function str(description?: string): SchemaNode {
  const node: SchemaNode = { type: 'string', required: true }
  if (description !== undefined) node.description = description
  return node
}

/** Required number field. */
function num(description?: string): SchemaNode {
  const node: SchemaNode = { type: 'number', required: true }
  if (description !== undefined) node.description = description
  return node
}

/** Required enum field. */
function enumOf(values: readonly string[], description?: string): SchemaNode {
  const node: SchemaNode = { type: 'string', required: true, enum: [...values] }
  if (description !== undefined) node.description = description
  return node
}

// ── Canonical value schemas (protocol v2 mirrors) ───────────────────────────

const ETA_CONFIDENCES = ['high', 'medium', 'low', 'unknown'] as const
const TASK_TRENDS = ['rising', 'steady', 'falling', 'stalled', 'unknown'] as const
const RESUME_SAFETIES = ['strong', 'weak', 'none'] as const
const RESUME_DECISIONS = ['accepted', 'rejected', 'not-attempted'] as const
const RESUME_DECISION_REASONS = [
  'etag',
  'last-modified',
  'url',
  'final-url',
  'disabled',
  'size-mismatch',
  'validators-mismatch',
  'url-mismatch',
  'file-name-mismatch',
  'ranges-invalid',
  'version-mismatch',
  'state-corrupt',
  'part-missing',
  'part-truncated',
] as const
const EXPIRY_STATES = ['valid', 'expiring', 'expired', 'unknown'] as const
const DIAGNOSIS_CODES = [
  'on-track',
  'stalled',
  'throttled',
  'origin-slow',
  'no-range',
  'weak-validators',
  'checksum-available',
  'signed-url-expiring',
  'disk-slow',
  'retrying',
  'almost-done',
] as const
const SERVER_WARNING_CODES = [
  'no-range-support',
  'no-validators',
  'weak-validators',
  'unknown-size',
  'signed-url-expiring',
  'signed-url-expired',
  'tls-expiring',
  'tls-expired',
  'rate-limited',
  'head-failed',
  'redirected',
  'content-encoding',
] as const
const SIGNED_URL_SOURCES = ['aws-sigv4', 'aws-sigv2', 'gcs-sigv4', 'azure-sas', 'generic-expires', 'unknown'] as const

/** Integrity-header schema, shared by ServerFacts and TaskDetail.verification. */
const CHECKSUM_SCHEMA: SchemaNode = objectNode({
  contentDigest: nullableNode({ type: 'string' }),
  contentMd5: nullableNode({ type: 'string' }),
  sha256: nullableNode({ type: 'string' }),
  crc32c: nullableNode({ type: 'string' }),
})

/** Recoverable tool failure schema (design §3.5). */
const TOOL_ERROR_SCHEMA: SchemaNode = objectNode({
  code: str(),
  message: str(),
})

/** `ServerFacts` output schema. */
const SERVER_FACTS_SCHEMA: SchemaNode = objectNode({
  url: str(),
  finalUrl: str(),
  host: str(),
  httpVersion: nullableNode({ type: 'string' }),
  status: num(),
  fileName: str(),
  fileNameSource: enumOf(['content-disposition', 'url']),
  totalBytes: nullableNode({ type: 'number' }),
  contentType: nullableNode({ type: 'string' }),
  contentEncoding: nullableNode({ type: 'string' }),
  contentDisposition: nullableNode({ type: 'string' }),
  range: objectNode({
    supported: { type: 'boolean', required: true },
    acceptRanges: enumOf(['bytes', 'none', 'unknown']),
    ifRange: { type: 'boolean', required: true },
    probedBy: enumOf(['head', 'range-get']),
    probeStatus: nullableNode({ type: 'number' }),
    probeBytes: num(),
  }),
  validators: objectNode({
    etag: nullableNode({ type: 'string' }),
    strongEtag: { type: 'boolean', required: true },
    lastModified: nullableNode({ type: 'string' }),
  }),
  resume: objectNode({
    possible: { type: 'boolean', required: true },
    safety: enumOf(RESUME_SAFETIES),
    reason: enumOf(['strong-etag', 'last-modified-only', 'no-validators', 'no-range-support']),
  }),
  signedUrl: objectNode({
    signed: { type: 'boolean', required: true },
    expiresAt: nullableNode({ type: 'number' }),
    expiresInSecs: nullableNode({ type: 'number' }),
    source: enumOf(SIGNED_URL_SOURCES),
    state: enumOf(EXPIRY_STATES),
  }),
  tls: nullableNode(
    objectNode({
      https: { type: 'boolean', required: true },
      notAfter: nullableNode({ type: 'number' }),
      expiresInSecs: nullableNode({ type: 'number' }),
      issuer: nullableNode({ type: 'string' }),
      subject: nullableNode({ type: 'string' }),
      state: enumOf(EXPIRY_STATES),
    }),
  ),
  redirects: arrayNode(objectNode({ status: num(), url: str() })),
  headers: objectNode({
    server: nullableNode({ type: 'string' }),
    date: nullableNode({ type: 'string' }),
    cacheControl: nullableNode({ type: 'string' }),
    expires: nullableNode({ type: 'string' }),
    vary: nullableNode({ type: 'string' }),
  }),
  rateLimit: objectNode({
    retryAfterSecs: nullableNode({ type: 'number' }),
    limit: nullableNode({ type: 'number' }),
    remaining: nullableNode({ type: 'number' }),
  }),
  timing: objectNode({
    probeMs: num(),
    ttfbMs: nullableNode({ type: 'number' }),
    sampleBps: nullableNode({ type: 'number' }),
  }),
  checksum: CHECKSUM_SCHEMA,
  warnings: arrayNode({ type: 'string', enum: [...SERVER_WARNING_CODES] }),
  recommendation: objectNode({
    start: enumOf(['now', 'later', 'avoid']),
    connections: num(),
    chunkSizeBytes: nullableNode({ type: 'number' }),
    singleStream: { type: 'boolean', required: true },
    reason: str(),
    verify: enumOf(['recommended', 'required', 'unavailable']),
  }),
  origin: nullableNode(
    objectNode({
      known: { type: 'boolean', required: true },
      attempts: num(),
      completed: num(),
      medianBps: nullableNode({ type: 'number' }),
      bestBps: nullableNode({ type: 'number' }),
      lastError: nullableNode({ type: 'string' }),
      lastAt: nullableNode({ type: 'number' }),
    }),
  ),
})

/** `TaskView` output schema. */
const TASK_VIEW_SCHEMA: SchemaNode = objectNode({
  id: str(),
  sessionId: nullableNode({ type: 'string' }),
  url: str(),
  host: str(),
  finalUrl: nullableNode({ type: 'string' }),
  fileName: str(),
  dir: str(),
  path: nullableNode({ type: 'string' }),
  status: enumOf(TASK_STATUSES),
  downloaded: num(),
  transferredBytes: num(),
  total: nullableNode({ type: 'number' }),
  percent: nullableNode({ type: 'number' }),
  speedBps: num(),
  speed1sBps: nullableNode({ type: 'number' }),
  speed5sBps: nullableNode({ type: 'number' }),
  speed30sBps: nullableNode({ type: 'number' }),
  speed300sBps: nullableNode({ type: 'number' }),
  avgBps: nullableNode({ type: 'number' }),
  peakBps: nullableNode({ type: 'number' }),
  etaSecs: nullableNode({ type: 'number' }),
  etaConfidence: enumOf(ETA_CONFIDENCES),
  stalledMs: num(),
  activeWorkers: num(),
  peakWorkers: num(),
  connections: num(),
  requestedConnections: num(),
  maxConnections: num(),
  targetWorkers: num(),
  chunkSize: nullableNode({ type: 'number' }),
  resumedChunks: num(),
  resumedBytes: num(),
  rangeSupported: nullableNode({ type: 'boolean' }),
  resumable: { type: 'boolean', required: true },
  resumeSafety: nullableNode({ type: 'string', enum: [...RESUME_SAFETIES] }),
  expectedSha256: nullableNode({ type: 'string' }),
  sha256: nullableNode({ type: 'string' }),
  verified: nullableNode({ type: 'boolean' }),
  error: nullableNode(
    objectNode({
      code: str(),
      message: str(),
    }),
  ),
  retries: num(),
  createdAt: num(),
  startedAt: nullableNode({ type: 'number' }),
  finishedAt: nullableNode({ type: 'number' }),
  elapsedMs: num(),
  signedUrlExpiresAt: nullableNode({ type: 'number' }),
  tlsNotAfter: nullableNode({ type: 'number' }),
})

/** `TaskDetail` output schema. */
const TASK_DETAIL_SCHEMA: SchemaNode = objectNode({
  telemetry: objectNode({
    windows: objectNode({
      '1s': nullableNode({ type: 'number' }),
      '5s': nullableNode({ type: 'number' }),
      '30s': nullableNode({ type: 'number' }),
      '300s': nullableNode({ type: 'number' }),
    }),
    peakBps: nullableNode({ type: 'number' }),
    avgBps: nullableNode({ type: 'number' }),
    stalledMs: num(),
    trend: enumOf(TASK_TRENDS),
    etaConfidence: enumOf(ETA_CONFIDENCES),
    samples: num(),
    lastSampleAt: nullableNode({ type: 'number' }),
  }),
  server: nullableNode(SERVER_FACTS_SCHEMA),
  target: objectNode({
    dir: str(),
    path: nullableNode({ type: 'string' }),
    part: nullableNode({ type: 'string' }),
    resumeState: nullableNode({ type: 'string' }),
  }),
  verification: objectNode({
    expectedSha256: nullableNode({ type: 'string' }),
    sha256: nullableNode({ type: 'string' }),
    verified: nullableNode({ type: 'boolean' }),
    serverChecksums: CHECKSUM_SCHEMA,
  }),
  resumeState: objectNode({
    chunksDone: num(),
    bytesDone: num(),
    resumedChunks: num(),
    resumedBytes: num(),
    validatorsMatched: nullableNode({ type: 'boolean' }),
    resumeDecision: enumOf(RESUME_DECISIONS),
    resumeReason: nullableNode({ type: 'string', enum: [...RESUME_DECISION_REASONS] }),
  }),
  timing: objectNode({
    queuedMs: nullableNode({ type: 'number' }),
    probeMs: nullableNode({ type: 'number' }),
    transferMs: nullableNode({ type: 'number' }),
    finalizeMs: nullableNode({ type: 'number' }),
  }),
  diagnosis: arrayNode(
    objectNode({
      code: enumOf(DIAGNOSIS_CODES),
      advice: str(),
      message: str(),
    }),
  ),
})

/** `Aggregate` output schema. */
const AGGREGATE_SCHEMA: SchemaNode = objectNode({
  total: num(),
  active: num(),
  paused: num(),
  failed: num(),
  completed: num(),
  bytesDownloaded: num(),
  nowBps: num(),
  w5Bps: num(),
  w30Bps: num(),
  w300Bps: nullableNode({ type: 'number' }),
  riskCount: num(),
})

/** Convenience list counts (a projection of `Aggregate`). */
const COUNTS_SCHEMA: SchemaNode = objectNode({
  total: num(),
  active: num(),
  paused: num(),
  failed: num(),
  completed: num(),
})

/** Kernel process status included by `rdm_tasks`. */
const KERNEL_SCHEMA: SchemaNode = objectNode({
  running: { type: 'boolean', required: true },
  starting: { type: 'boolean', required: true },
  version: nullableNode({ type: 'string' }),
  pid: nullableNode({ type: 'number' }),
  dataDir: str(),
  error: nullableNode({ type: 'string' }),
})

/** One diagnostic task event. */
const EVENT_SCHEMA: SchemaNode = objectNode({
  seq: num(),
  at: num(),
  kind: enumOf(TASK_EVENT_KINDS),
  message: nullableNode({ type: 'string' }),
  chunk: nullableNode({ type: 'number' }),
  attempt: nullableNode({ type: 'number' }),
  delayMs: nullableNode({ type: 'number' }),
})

/** One recorded telemetry sample from the persisted JSONL history (0.3.0). */
const HISTORY_SAMPLE_SCHEMA: SchemaNode = objectNode({
  t: num(),
  bytes: num(),
  bps: num(),
  w1Bps: num(),
  w5Bps: num(),
  w30Bps: num(),
  w300Bps: num(),
  workers: num(),
  peakWorkers: num(),
  stalledMs: num(),
})

/** One recorded task event from the persisted JSONL history (0.3.0). */
const HISTORY_EVENT_SCHEMA: SchemaNode = objectNode({
  t: num(),
  seq: num(),
  kind: enumOf(TASK_EVENT_KINDS),
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
  maxConnections?: number
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
  waitProbeMs?: number
  waitSec?: number
}

interface DownloadValue {
  task: TaskView
  server: ServerFacts | null
  /** The preflight server-facts wait expired without facts. */
  preflightTimedOut: boolean
  /** `waitSec` was requested and every waited task is terminal. */
  terminal: boolean
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
  server: ServerFacts | null
  error: ToolError | null
  hint: string
}

interface TasksArgs {
  taskId?: string
  scope?: 'session' | 'all'
  status?: string
  limit?: number
  events?: number
}

interface TasksListValue {
  kernel: KernelStatusView
  tasks: TaskView[]
  aggregate: Aggregate
  counts: { total: number; active: number; paused: number; failed: number; completed: number }
  scope: 'session' | 'all'
  error: ToolError | null
  hint: string
}

interface TaskDetailValue {
  kernel: KernelStatusView
  task: TaskView | null
  detail: TaskDetail | null
  events: TaskEvent[]
  error: ToolError | null
  hint: string
}

type TasksValue = TasksListValue | TaskDetailValue

interface WaitArgs {
  taskIds: string[]
  timeoutSec?: number
}

interface WaitValue {
  tasks: TaskView[]
  timedOut: boolean
  error: ToolError | null
  hint: string
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
  error: ToolError | null
  hint: string
}

interface HistoryArgs {
  taskId: string
  limit?: number
  offset?: number
  includeEvents?: boolean
}

interface HistoryValue {
  kernel: KernelStatusView
  taskId: string
  samplesPath: string | null
  eventsPath: string | null
  samples: TaskHistorySample[]
  events: TaskHistoryEvent[]
  /** Deduped `<kernelVersion>@<pid>` build tags (0.2.2). */
  builds: string[]
  totalSamples: number
  totalEvents: number
  truncated: boolean
  error: ToolError | null
  hint: string
}

// ── Execution helpers ───────────────────────────────────────────────────────

/** Aggregate value used when a list call failed before producing one. */
const EMPTY_AGGREGATE: Aggregate = {
  total: 0,
  active: 0,
  paused: 0,
  failed: 0,
  completed: 0,
  bytesDownloaded: 0,
  nowBps: 0,
  w5Bps: 0,
  w30Bps: 0,
  w300Bps: null,
  riskCount: 0,
}

/** Clamp a finite number into an integer range (undefined -> fallback). */
function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/** Build the follow-up hint returned by `rdm_download`. */
function downloadHint(
  task: TaskView,
  preflightTimedOut: boolean,
  waitProbeMs: number,
  terminal: boolean,
): string {
  if (task.status === 'completed') {
    const location = task.path === null ? '' : `; saved to ${task.path}`
    const verification =
      task.verified === true
        ? '; SHA-256 verified'
        : task.verified === false
          ? '; SHA-256 MISMATCH'
          : ''
    return `Completed${location}${verification}.`
  }
  if (task.status === 'failed') {
    return `Failed (${task.error === null ? 'error' : task.error.code}); inspect events with rdm_tasks taskId=${task.id}, then retry with rdm_control action=retry.`
  }
  if (preflightTimedOut) {
    return `Preflight server facts were not ready within ${waitProbeMs} ms; the task continues. Follow it with rdm_tasks taskId=${task.id} or rdm_wait taskIds=["${task.id}"].`
  }
  if (terminal) {
    return `Settled as ${task.status}. Inspect with rdm_tasks taskId=${task.id}.`
  }
  return `Follow with rdm_tasks taskId=${task.id} or rdm_wait taskIds=["${task.id}"]; pass waitSec to block until it settles.`
}

/** Build the follow-up hint returned by `rdm_probe`. */
function probeHint(server: ServerFacts): string {
  const recommendation = server.recommendation
  if (recommendation.start === 'avoid') {
    return `Do not start cleanly: warnings=[${server.warnings.join(',')}]. Re-probe or fix the source first.`
  }
  if (recommendation.start === 'later') {
    return `Start later (${recommendation.reason !== '' ? recommendation.reason : 'server constraints'}); an immediate start may fail or expire.`
  }
  return `Start it with rdm_download url=${server.finalUrl !== '' ? server.finalUrl : server.url}.`
}

/** Split a task-status filter (kernel accepts one status or a list). */
function parseStatusFilter(value: unknown): ReturnType<typeof normalizeStatusFilter> {
  return normalizeStatusFilter(value)
}

/** List-mode hint. */
function tasksListHint(scope: 'session' | 'all', tasks: TaskView[]): string {
  const parts: string[] = []
  const first = tasks[0]
  if (first !== undefined) parts.push(`Pass taskId=${first.id} for telemetry, server facts and diagnosis.`)
  if (scope === 'session') parts.push('Pass scope="all" to include tasks from every session.')
  return parts.length > 0 ? parts.join(' ') : 'No tasks matched this filter.'
}

/** Detail-mode hint. */
function taskDetailHint(task: TaskView): string {
  return `Control it with rdm_control (pause/resume/cancel/retry/remove) or block with rdm_wait taskIds=["${task.id}"]; the recorded series is in rdm_history taskId=${task.id}.`
}

/** Wait hint. */
function waitHint(tasks: TaskView[], timedOut: boolean): string {
  if (timedOut) {
    const active = tasks.filter((task) => task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled')
    return active.length > 0
      ? `Still active: ${active.map((task) => task.id).join(', ')}. Call rdm_wait again or inspect with rdm_tasks.`
      : 'The timeout expired. Re-check with rdm_tasks.'
  }
  const first = tasks[0]
  return first === undefined
    ? 'No tasks to report.'
    : `All settled; inspect verification with rdm_tasks taskId=${first.id}.`
}

/** Control hint. */
function controlHint(action: ControlAction, taskId: string, deletePart: boolean): string {
  switch (action) {
    case 'pause':
      return `Resume with rdm_control action=resume taskId=${taskId}.`
    case 'resume':
    case 'retry':
      return `Follow with rdm_wait taskIds=["${taskId}"] or rdm_tasks taskId=${taskId}.`
    case 'cancel':
      return `Resume later with rdm_control action=resume taskId=${taskId}, or remove it.`
    case 'remove':
      return deletePart ? 'Task record and resume data removed.' : 'Task record removed; resume data kept.'
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

/**
 * Build the six model-facing tool definitions bound to one kernel service.
 * Exported separately from {@link registerRdmTools} so tests and docs can
 * inspect the surface (and its receipts) without a host context.
 */
export function createRdmTools(kernel: KernelService): ToolDefinition<any, any>[] {
  return [
    defineTool<DownloadArgs, DownloadValue>({
      name: 'rdm_download',
      description:
        'Start an HTTP(S) download in the resident RDM kernel and return its task view. ' +
        'Waits up to waitProbeMs (default 2000) for the preflight server facts; returns without them ' +
        'when the probe is slower than that (the transfer keeps running). Pass waitSec (max 300) to ' +
        'also block until the task settles.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL.' },
        dir: {
          type: 'string',
          description: 'Absolute destination directory (default: plugin defaultDir, then the DSH host cwd).',
        },
        fileName: { type: 'string', description: 'Output file-name override (sanitized by the kernel).' },
        connections: {
          type: 'number',
          description: `Parallel connections 1..${MAX_CONNECTIONS} (default: plugin config, normally 8).`,
        },
        maxConnections: {
          type: 'number',
          description:
            `Adaptive concurrency ceiling 1..${MAX_CONNECTIONS} (default: plugin config, ${DEFAULT_MAX_CONNECTIONS}). ` +
            'Passed to the kernel; the controller may grow from `connections` up to this while throughput is healthy.',
        },
        headers: {
          type: 'json',
          description: 'Extra request headers as a JSON object, e.g. {"Authorization":"Bearer ..."}.',
        },
        cookie: { type: 'string', description: 'Cookie header value, e.g. "a=1; b=2".' },
        referer: { type: 'string', description: 'Referer header value.' },
        userAgent: { type: 'string', description: 'User-Agent override.' },
        expectedSha256: {
          type: 'string',
          description: '64-hex SHA-256 the kernel verifies before finalizing the file.',
        },
        speedLimitBps: {
          type: 'number',
          description: 'Per-task bandwidth cap in bytes/second (0/omitted = unlimited).',
        },
        resume: { type: 'boolean', description: 'Resume from existing .part state (default true).' },
        singleStream: {
          type: 'boolean',
          description: 'Force one rangeless GET; useful for origins without range support.',
        },
        proxy: { type: 'string', description: 'HTTP proxy URL, e.g. http://127.0.0.1:7890.' },
        insecure: { type: 'boolean', description: 'Accept invalid TLS certificates (debug only).' },
        waitProbeMs: {
          type: 'number',
          description: 'Max ms to wait inline for preflight server facts (0..5000, default 2000).',
        },
        waitSec: {
          type: 'number',
          description: 'Also block until the task settles: 0..300 s (default 0 = return right after preflight).',
        },
      },
      output: {
        schema: objectNode({
          task: req(TASK_VIEW_SCHEMA),
          server: nullableNode(SERVER_FACTS_SCHEMA),
          preflightTimedOut: { type: 'boolean', required: true },
          terminal: { type: 'boolean', required: true },
          hint: str(),
        }),
        render: (_args, value) => [
          { type: 'text', text: renderDownloadReceipt(value).join('\n') },
        ],
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const waitProbeMs = clampInteger(args.waitProbeMs, DEFAULT_WAIT_PROBE_MS, 0, MAX_WAIT_PROBE_MS)
          const waitSec = clampInteger(args.waitSec, 0, 0, Math.floor(MAX_WAIT_MS / 1000))
          const sessionId = sessionIdFromExec(exec)
          let task = await kernel.start(
            {
              url: args.url,
              ...(args.dir === undefined ? {} : { dir: args.dir }),
              ...(args.fileName === undefined ? {} : { fileName: args.fileName }),
              ...(args.connections === undefined ? {} : { connections: args.connections }),
              ...(args.maxConnections === undefined ? {} : { maxConnections: args.maxConnections }),
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
              ...(sessionId === null ? {} : { sessionId }),
              waitProbeMs,
            },
            exec.signal,
          )
          let server: ServerFacts | null = null
          let preflightTimedOut = false
          if (waitProbeMs > 0) {
            const preflight = await kernel.waitForServerFacts(task.id, waitProbeMs, exec.signal)
            task = preflight.task
            server = preflight.server
            preflightTimedOut = preflight.timedOut
          }
          let terminal = false
          if (waitSec > 0) {
            const result = await kernel.wait([task.id], waitSec * 1000, exec.signal)
            const settled = result.tasks[0]
            if (settled !== undefined) task = settled
            terminal = result.timedOut === false
            if (server === null) {
              const latest = await kernel.get(task.id, 0, exec.signal)
              task = latest.task
              server = latest.detail.server
            }
          }
          return {
            task,
            server,
            preflightTimedOut,
            terminal,
            hint: downloadHint(task, preflightTimedOut, waitProbeMs, terminal),
          }
        }),
    }),

    defineTool<ProbeArgs, ProbeValue>({
      name: 'rdm_probe',
      description:
        'Inspect an HTTP(S) URL without downloading the body. Returns server facts (final URL, size, ' +
        'type, range support, resume safety, signed-URL/TLS expiry, redirects, timing, origin history), ' +
        'stable warning codes and an advisory transfer plan. Use it before rdm_download for an unknown source.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL.' },
        headers: {
          type: 'json',
          description: 'Extra request headers as a JSON object, e.g. {"Authorization":"Bearer ..."}.',
        },
        cookie: { type: 'string', description: 'Cookie header value.' },
        referer: { type: 'string', description: 'Referer header value.' },
        userAgent: { type: 'string', description: 'User-Agent override.' },
      },
      output: {
        schema: objectNode({
          server: nullableNode(SERVER_FACTS_SCHEMA),
          error: nullableNode(TOOL_ERROR_SCHEMA),
          hint: str(),
        }),
        render: (_args, value) => [
          { type: 'text', text: renderProbeReceipt(value).join('\n') },
        ],
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          try {
            const server = await kernel.probe(
              args.url,
              {
                ...(args.headers === undefined ? {} : { headers: args.headers as Record<string, string> }),
                ...(args.cookie === undefined ? {} : { cookie: args.cookie }),
                ...(args.referer === undefined ? {} : { referer: args.referer }),
                ...(args.userAgent === undefined ? {} : { userAgent: args.userAgent }),
              },
              exec.signal,
            )
            return { server, error: null, hint: probeHint(server) }
          } catch (error) {
            const recoverable = recoverableError(error)
            if (recoverable === null) throw error
            return { server: null, error: recoverable, hint: probeErrorHint(args.url, recoverable) }
          }
        }),
    }),

    defineTool<TasksArgs, TasksValue>({
      name: 'rdm_tasks',
      description:
        'Read download state. With taskId: one task plus telemetry windows, server facts, target, ' +
        'verification, timing, diagnosis and recent events. Without taskId: kernel status, aggregate ' +
        'counters and bounded task views. Task state is authoritative; events are diagnostic only.',
      parameters: {
        taskId: {
          type: 'string',
          description: 'Task id to inspect in detail. Omit to list tasks.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'all'],
          description:
            'List scope: "session" (default when the caller has a session) or "all" for every session.',
        },
        status: {
          type: 'string',
          description: `List filter: ${TASK_STATUSES.join('|')} (comma-separate for several).`,
        },
        limit: {
          type: 'number',
          description: `Max tasks to list (1..${TOOL_LIST_MAX}, default ${TOOL_LIST_DEFAULT}).`,
        },
        events: {
          type: 'number',
          description: `With taskId: recent events to return (0..${TOOL_MAX_EVENTS}, default 5).`,
        },
      },
      output: {
        schema: objectNode({
          kernel: req(KERNEL_SCHEMA),
          tasks: arrayNode(TASK_VIEW_SCHEMA),
          aggregate: AGGREGATE_SCHEMA,
          counts: COUNTS_SCHEMA,
          scope: { type: 'string', enum: ['session', 'all'] },
          task: nullableNode(TASK_VIEW_SCHEMA),
          detail: nullableNode(TASK_DETAIL_SCHEMA),
          events: arrayNode(EVENT_SCHEMA),
          error: nullableNode(TOOL_ERROR_SCHEMA),
          hint: str(),
        }),
        render: (_args, value) => {
          const record = value as unknown as Record<string, unknown>
          if (record.detail === undefined) {
            return [{ type: 'text', text: renderTasksListReceipt(value as TasksListValue).join('\n') }]
          }
          return [{ type: 'text', text: renderTaskDetailReceipt(value as TaskDetailValue).join('\n') }]
        },
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const sessionId = sessionIdFromExec(exec)
          if (args.taskId !== undefined && args.taskId.trim() !== '') {
            const taskId = normalizeTaskId(args.taskId)
            const events = clampInteger(args.events, 5, 0, TOOL_MAX_EVENTS)
            try {
              const result = await kernel.get(taskId, events, exec.signal)
              return {
                kernel: kernel.kernelStatus(),
                task: result.task,
                detail: result.detail,
                events: result.events,
                error: null,
                hint: taskDetailHint(result.task),
              } satisfies TaskDetailValue
            } catch (error) {
              const recoverable = recoverableError(error)
              if (recoverable === null) throw error
              return {
                kernel: kernel.kernelStatus(),
                task: null,
                detail: null,
                events: [],
                error: recoverable,
                hint: tasksErrorHint(recoverable),
              } satisfies TaskDetailValue
            }
          }
          const scope: 'session' | 'all' =
            args.scope === 'all' ? 'all' : args.scope === 'session' ? 'session' : sessionId === null ? 'all' : 'session'
          const filterSession = scope === 'session' ? sessionId : null
          const request = {
            ...(parseStatusFilter(args.status) === undefined ? {} : { status: parseStatusFilter(args.status) }),
            ...(filterSession === null ? {} : { sessionId: filterSession }),
            limit: clampInteger(args.limit, TOOL_LIST_DEFAULT, 1, TOOL_LIST_MAX),
          }
          try {
            const result = await kernel.list(request, exec.signal)
            return {
              kernel: kernel.kernelStatus(),
              tasks: result.tasks,
              aggregate: result.aggregate,
              counts: {
                total: result.aggregate.total,
                active: result.aggregate.active,
                paused: result.aggregate.paused,
                failed: result.aggregate.failed,
                completed: result.aggregate.completed,
              },
              scope,
              error: null,
              hint: tasksListHint(scope, result.tasks),
            } satisfies TasksListValue
          } catch (error) {
            const recoverable = recoverableError(error)
            if (recoverable === null) throw error
            return {
              kernel: kernel.kernelStatus(),
              tasks: [],
              aggregate: EMPTY_AGGREGATE,
              counts: { total: 0, active: 0, paused: 0, failed: 0, completed: 0 },
              scope,
              error: recoverable,
              hint: tasksErrorHint(recoverable),
            } satisfies TasksListValue
          }
        }),
    }),

    defineTool<WaitArgs, WaitValue>({
      name: 'rdm_wait',
      description:
        'Wait until every given task is terminal (completed/failed/cancelled) or timeoutSec expires. ' +
        'Returns the final task views and timedOut; prefer it over polling rdm_tasks.',
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
          tasks: arrayNode(TASK_VIEW_SCHEMA),
          timedOut: { type: 'boolean', required: true },
          error: nullableNode(TOOL_ERROR_SCHEMA),
          hint: str(),
        }),
        render: (_args, value) => [
          { type: 'text', text: renderWaitReceipt(value).join('\n') },
        ],
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
          try {
            const result = await kernel.wait(args.taskIds, timeoutSec * 1000, exec.signal)
            return {
              tasks: result.tasks,
              timedOut: result.timedOut,
              error: null,
              hint: waitHint(result.tasks, result.timedOut),
            }
          } catch (error) {
            const recoverable = recoverableError(error)
            if (recoverable === null) throw error
            return {
              tasks: [],
              timedOut: false,
              error: recoverable,
              hint: waitErrorHint(recoverable),
            }
          }
        }),
    }),

    defineTool<ControlArgs, ControlValue>({
      name: 'rdm_control',
      description:
        'Control an existing task: pause (resume state kept), resume (continue paused/interrupted/' +
        'cancelled/failed tasks when resume state exists, otherwise restart), cancel (stop, keep ' +
        '.part), retry (discard .part and restart from zero) or remove (delete the task record; ' +
        'deletePart also deletes resume data, never the finished file).',
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
          description: 'For action=remove only: also delete .part resume data (never the finished file).',
        },
      },
      output: {
        schema: objectNode({
          action: enumOf(['pause', 'resume', 'cancel', 'retry', 'remove']),
          task: nullableNode(TASK_VIEW_SCHEMA),
          removedId: nullableNode({ type: 'string' }),
          deletePart: { type: 'boolean', required: true },
          error: nullableNode(TOOL_ERROR_SCHEMA),
          hint: str(),
        }),
        render: (_args, value) => [
          { type: 'text', text: renderControlReceipt(value).join('\n') },
        ],
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const deletePart = args.deletePart === true
          try {
            const task = await kernel.control(args.taskId, args.action, deletePart, exec.signal)
            return {
              action: args.action,
              task,
              removedId: args.action === 'remove' ? args.taskId : null,
              deletePart: args.action === 'remove' && deletePart,
              error: null,
              hint: controlHint(args.action, args.taskId, deletePart),
            }
          } catch (error) {
            const recoverable = recoverableError(error)
            if (recoverable === null) throw error
            return {
              action: args.action,
              task: null,
              removedId: null,
              deletePart: args.action === 'remove' && deletePart,
              error: recoverable,
              hint: controlErrorHint(args.action, args.taskId, recoverable),
            }
          }
        }),
    }),

    defineTool<HistoryArgs, HistoryValue>({
      name: 'rdm_history',
      description:
        'Read the persisted per-sample telemetry and event recording for one task (JSONL under the kernel data dir). ' +
        'Survives kernel restarts; use it to replay a transfer and tune the kernel. ' +
        'Returns bounded samples/events plus their file paths.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id, e.g. "t_9f3a1c2d5e6b7a80".' },
        limit: {
          type: 'number',
          description: `Max samples to return (1..${MAX_HISTORY_SAMPLES}, default ${DEFAULT_HISTORY_SAMPLES}).`,
        },
        offset: {
          type: 'number',
          description: 'Number of recorded samples to skip before the returned page (default 0).',
        },
        includeEvents: {
          type: 'boolean',
          description: 'Also return the recorded task events (default true).',
        },
      },
      output: {
        schema: objectNode({
          kernel: req(KERNEL_SCHEMA),
          taskId: str(),
          samplesPath: nullableNode({ type: 'string' }),
          eventsPath: nullableNode({ type: 'string' }),
          samples: arrayNode(HISTORY_SAMPLE_SCHEMA),
          events: arrayNode(HISTORY_EVENT_SCHEMA),
          builds: arrayNode({ type: 'string' }),
          totalSamples: num(),
          totalEvents: num(),
          truncated: { type: 'boolean', required: true },
          error: nullableNode(TOOL_ERROR_SCHEMA),
          hint: str(),
        }),
        render: (args, value) => [
          {
            type: 'text',
            text: renderHistoryReceipt(
              value,
              clampInteger(args.offset, 0, 0, MAX_HISTORY_SAMPLES),
            ).join('\n'),
          },
        ],
      },
      execute: (args, exec: ToolRunContext) =>
        runTool(async () => {
          exec.signal.throwIfAborted()
          const taskId = normalizeTaskId(args.taskId)
          const offsetSupplied = args.offset !== undefined
          const offset = clampInteger(args.offset, 0, 0, MAX_HISTORY_SAMPLES)
          const limit = clampInteger(args.limit, DEFAULT_HISTORY_SAMPLES, 1, MAX_HISTORY_SAMPLES)
          const includeEvents = args.includeEvents !== false
          try {
            // Only a model-supplied offset means "page the literal recording":
            // KernelService turns that into `raw: true`. Without it the kernel's
            // default evenly-downsampled review series is returned.
            const history = await kernel.history(
              taskId,
              {
                limit,
                includeEvents,
                eventsLimit: DEFAULT_HISTORY_EVENTS,
                ...(offsetSupplied ? { offset } : {}),
              },
              exec.signal,
            )
            return {
              kernel: kernel.kernelStatus(),
              taskId: history.taskId,
              samplesPath: history.samplesPath,
              eventsPath: history.eventsPath,
              samples: history.samples,
              events: history.events,
              builds: history.builds,
              totalSamples: history.totalSamples,
              totalEvents: history.totalEvents,
              truncated: history.truncated,
              error: null,
              hint: historyHint(history, includeEvents),
            } satisfies HistoryValue
          } catch (error) {
            const recoverable = recoverableError(error)
            if (recoverable === null) throw error
            return {
              kernel: kernel.kernelStatus(),
              taskId,
              samplesPath: null,
              eventsPath: null,
              samples: [],
              events: [],
              builds: [],
              totalSamples: 0,
              totalEvents: 0,
              truncated: false,
              error: recoverable,
              hint: historyErrorHint(taskId, recoverable),
            } satisfies HistoryValue
          }
        }),
    }),
  ]
}

/**
 * Register the six `rdm_*` tools on the host tool registry.
 *
 * @param ctx - Host plugin context (must provide `ctx.tools`).
 * @param kernel - The shared kernel service.
 */
export function registerRdmTools(ctx: HostContext, kernel: KernelService): void {
  for (const tool of createRdmTools(kernel)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-rdm: tool ${tool.name}`)
  }
}
