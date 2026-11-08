// Pure presentation model for the review surfaces: everything that turns a
// normalized TaskView into the words and marks the UI shows. No JSX, no React,
// no network — this module is trivially reviewable and testable.

import { formatBytes, formatDuration, formatRemaining, hashPrefix, taskStateOf } from './format'
import type { TFunction, TaskView } from './types'

/** Localized status word for a kernel status code. */
export function statusLabel(t: TFunction, status: string): string {
  const key = `status.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

/** The display name of a record. */
export function fileNameOf(task: TaskView): string {
  if (task.fileName !== '') return task.fileName
  if (task.url !== '') return task.url
  return task.id
}

/** The host of a record, falling back to the URL's host. */
export function hostOf(task: TaskView): string {
  if (task.host !== null && task.host !== '') return task.host
  if (task.finalUrl !== null && task.finalUrl !== '') {
    const match = /^[a-z]+:\/\/([^/]+)/i.exec(task.finalUrl)
    if (match !== null) return match[1] as string
  }
  return ''
}

/** The resolved destination path, when known. */
export function taskPath(task: TaskView): string {
  if (task.path !== null && task.path !== '') return task.path
  if (task.dir !== null && task.dir !== '') return `${task.dir.replace(/[\\/]$/, '')}`
  return ''
}

/** One server-risk chip. */
export interface ChipModel {
  key: string
  label: string
  tone: 'quiet' | 'warn' | 'error'
}

export type Severity = 'warn' | 'error'

/** One entry in the page's review queue (risk strip above the ledger). */
export interface RiskNote {
  key: string
  name: string
  cause: string
  severity: Severity
}

/**
 * Server-fact chips for one record: range, resume, signed URL, TLS and the
 * verification expectation. Unknown facts produce no chip at all — an empty
 * state is honest, a "unknown" chip on every old task is noise.
 */
export function chipsFor(t: TFunction, task: TaskView, now = Date.now()): ChipModel[] {
  const chips: ChipModel[] = []
  if (task.rangeSupported === true) {
    chips.push({ key: 'range', label: t('chips.range'), tone: 'quiet' })
  } else if (task.rangeSupported === false) {
    chips.push({ key: 'noRange', label: t('chips.noRange'), tone: 'warn' })
  }
  if (task.resumeSafety === 'strong') {
    chips.push({ key: 'resumeStrong', label: t('chips.resumeStrong'), tone: 'quiet' })
  } else if (task.resumeSafety === 'weak') {
    chips.push({ key: 'resumeWeak', label: t('chips.resumeWeak'), tone: 'warn' })
  } else if (task.resumeSafety === 'none') {
    chips.push({ key: 'resumeNone', label: t('chips.resumeNone'), tone: 'warn' })
  }
  if (task.signedUrlExpiresAt !== null) {
    const remaining = formatRemaining(task.signedUrlExpiresAt)
    const expired = task.signedUrlExpiresAt - now <= 0
    if (expired) {
      chips.push({ key: 'signedExpired', label: t('chips.signedExpired'), tone: 'error' })
    } else {
      const expiring = task.signedUrlExpiresAt - now < 10 * 60 * 1000
      chips.push({
        key: 'signed',
        label: t('chips.signed', { time: remaining ?? '—' }),
        tone: expiring ? 'warn' : 'quiet',
      })
    }
  }
  if (task.tlsNotAfter !== null) {
    const remaining = formatRemaining(task.tlsNotAfter)
    const expired = task.tlsNotAfter - now <= 0
    if (expired) {
      chips.push({ key: 'tlsExpired', label: t('chips.tlsExpired'), tone: 'error' })
    } else {
      const expiring = task.tlsNotAfter - now < 24 * 60 * 60 * 1000
      chips.push({
        key: 'tls',
        label: t('chips.tls', { time: remaining ?? '—' }),
        tone: expiring ? 'warn' : 'quiet',
      })
    }
  }
  if (task.verified === null && task.expectedSha256 !== null) {
    chips.push({ key: 'verify', label: t('chips.verify'), tone: 'quiet' })
  }
  return chips
}

/**
 * The page's review queue: one entry per record a human should look at.
 *
 * Errors are real failures and hash mismatches; warnings are facts that can
 * still be acted on before they become failures (signed URL or TLS surviving
 * less than 10 minutes / 24 hours, and a live transfer the server cannot
 * resume). Errors come first; stable record order inside a severity.
 */
export function riskNotes(t: TFunction, tasks: TaskView[], now = Date.now()): RiskNote[] {
  const errors: RiskNote[] = []
  const warnings: RiskNote[] = []
  for (const task of tasks) {
    const name = fileNameOf(task)
    if (task.status === 'failed') {
      errors.push({
        key: `failed:${task.id}`,
        name,
        cause: task.error === null ? t('risk.failedCause') : errorCause(t, task.error.code),
        severity: 'error',
      })
      continue
    }
    if (task.verified === false) {
      errors.push({ key: `mismatch:${task.id}`, name, cause: t('risk.mismatchCause'), severity: 'error' })
      continue
    }
    if (task.status === 'completed' || task.status === 'cancelled') continue
    const reasons: string[] = []
    if (task.signedUrlExpiresAt !== null && task.signedUrlExpiresAt - now < 10 * 60 * 1000) {
      const remaining = formatRemaining(task.signedUrlExpiresAt)
      const expired = task.signedUrlExpiresAt - now <= 0
      reasons.push(t(expired ? 'risk.signedExpiredReason' : 'risk.signedExpiringReason', { time: remaining ?? '—' }))
    }
    if (task.tlsNotAfter !== null && task.tlsNotAfter - now < 24 * 60 * 60 * 1000) {
      const remaining = formatRemaining(task.tlsNotAfter)
      const expired = task.tlsNotAfter - now <= 0
      reasons.push(t(expired ? 'risk.tlsExpiredReason' : 'risk.tlsExpiringReason', { time: remaining ?? '—' }))
    }
    if (task.status === 'running' && task.rangeSupported === false) {
      reasons.push(t('risk.noRangeReason'))
    }
    if (reasons.length > 0) warnings.push({ key: `risk:${task.id}`, name, cause: reasons.join(' '), severity: 'warn' })
  }
  return [...errors, ...warnings]
}

/** Localized cause for a failed record (falls back to the code itself). */
function errorCause(t: TFunction, code: string): string {
  const key = `error.code.${code}`
  const localized = t(key)
  return localized === key ? code : localized
}

/** Rows grouped by owning session, groups in recency order, records newest first. */
export interface SessionGroup {
  sessionId: string | null
  tasks: TaskView[]
  nowBps: number
  records: number
}

/** Recency key of one record (finished/started/created, newest wins). */
function recencyOf(task: TaskView): number {
  return Math.max(task.finishedAt ?? 0, task.startedAt ?? 0, task.createdAt ?? 0)
}

/** Group a normalized task list for the global ledger. */
export function groupBySession(tasks: TaskView[]): SessionGroup[] {
  const groups = new Map<string, TaskView[]>()
  for (const task of tasks) {
    const key = task.sessionId ?? ''
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [task])
    else bucket.push(task)
  }
  const result: SessionGroup[] = []
  for (const [key, bucket] of groups) {
    bucket.sort((left, right) => recencyOf(right) - recencyOf(left))
    result.push({
      sessionId: key === '' ? null : key,
      tasks: bucket,
      nowBps: bucket.reduce((sum, task) => sum + (task.status === 'running' || task.status === 'probing' ? task.speedBps : 0), 0),
      records: bucket.length,
    })
  }
  result.sort((left, right) => {
    const leftAt = Math.max(...left.tasks.map(recencyOf))
    const rightAt = Math.max(...right.tasks.map(recencyOf))
    return rightAt - leftAt
  })
  return result
}

/** Live rate of a set of records (running + probing only). */
export function liveRateOf(tasks: TaskView[]): number {
  return tasks.reduce((sum, task) => sum + (task.status === 'running' || task.status === 'probing' ? task.speedBps : 0), 0)
}

/** Count of records that are currently moving. */
export function movingCount(tasks: TaskView[]): number {
  return tasks.filter((task) => task.status === 'running' || task.status === 'probing').length
}

/** The seal model: present only when a hash was actually compared. */
export interface SealModel {
  state: 'verified' | 'mismatch'
  hash: string
  label: string
}

/** Verification seal for one record, or null when no comparison happened. */
export function sealFor(t: TFunction, task: TaskView): SealModel | null {
  if (task.verified === null) return null
  const hash = hashPrefix(task.sha256 ?? task.expectedSha256 ?? '')
  if (hash === null) return null
  return {
    state: task.verified ? 'verified' : 'mismatch',
    hash,
    label: task.verified ? t('seal.verified', { hash }) : t('seal.mismatch', { hash }),
  }
}

/** ETA copy: value plus the confidence marker's accessible word. */
export function etaOf(t: TFunction, task: TaskView): { value: string; confidence: string; bars: number } | null {
  if (task.etaSecs === null) return null
  const confidence = task.etaConfidence ?? 'unknown'
  const bars = confidence === 'high' ? 3 : confidence === 'medium' ? 2 : confidence === 'low' ? 1 : 0
  return {
    value: formatDuration(task.etaSecs),
    confidence: t(`confidence.${confidence}`),
    bars,
  }
}

/** Width label for the byte meter: `1.6 GB / 2.4 GB` or the unknown-size copy. */
export function byteMeterLabel(t: TFunction, task: TaskView): string {
  if (task.total !== null && task.total > 0) {
    return `${formatBytes(task.downloaded)} / ${formatBytes(task.total)}`
  }
  return t('record.sizeUnknown')
}

/** Elapsed copy for a record (live: since start; terminal: total active time). */
export function elapsedOf(task: TaskView): string | null {
  if (task.elapsedMs !== null && task.elapsedMs > 0) return formatDuration(task.elapsedMs / 1000)
  if (task.startedAt !== null) {
    const end = task.finishedAt ?? Date.now()
    const seconds = (end - task.startedAt) / 1000
    return seconds >= 1 ? formatDuration(seconds) : null
  }
  return null
}

/** The state bucket used for glyph tone. */
export function toneOf(task: TaskView): 'live' | 'paused' | 'done' | 'failed' | 'idle' {
  const state = taskStateOf(task.status)
  if (state === 'done' && task.verified === false) return 'failed'
  return state
}

/** Whether Stop is offered for a record. */
export function canStop(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'probing' || task.status === 'queued' || task.status === 'paused'
}

/** Whether the record's rate is expected to move right now. */
export function isMoving(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'probing'
}
