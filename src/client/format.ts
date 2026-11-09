// Small display helpers for the review surfaces. Pure functions, no locale
// data: every string that is UI copy lives in locale/{en,zh}.json; these
// helpers format measured values only.
//
// RULE: unknown is `—` (em dash). The em dash carries exactly one meaning in
// this UI; it is never used as decoration or as a separator between facts.

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Format a byte count with binary units; unknown values render an em dash. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

/** Format a transfer rate; unknown or zero-idle renders an em dash. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (typeof bytesPerSecond !== 'number' || !isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Format a remaining-time duration in seconds (`42s`, `1m 12s`). */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const restSeconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Format an elapsed duration in milliseconds (`2.4s`, `1m 50s`). */
export function formatElapsed(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatDuration(ms / 1000)
}

/** Format an epoch-millisecond timestamp as a local wall clock (`21:03:12`). */
export function formatClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Format an epoch-millisecond timestamp as local `HH:MM` (waveform edge ticks). */
export function formatHourMinute(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Compact remaining time for an expiry instant (`45s`, `19m`, `4h`, `40d`).
 * Negative values mean "already expired" and render `0s` — the caller decides
 * the wording, so an expired signed URL reads "signed expired", not "-19m".
 */
export function formatRemaining(expiresAtMs: number | null | undefined): string | null {
  if (typeof expiresAtMs !== 'number' || !isFinite(expiresAtMs) || expiresAtMs <= 0) return null
  const diff = expiresAtMs - Date.now()
  if (diff <= 0) return '0s'
  const seconds = Math.round(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Short hash prefix for the verification seal (8 hex characters by spec). */
export function hashPrefix(hash: string | null | undefined, length = 8): string | null {
  if (typeof hash !== 'string') return null
  const trimmed = hash.trim()
  if (trimmed === '') return null
  return trimmed.slice(0, Math.max(4, length)).toLowerCase()
}

/** Shorten a hash for a dense label while keeping both ends (`3f2ac9…a4b5`). */
export function shortHash(hash: string | null | undefined): string {
  if (typeof hash !== 'string' || hash.trim() === '') return '—'
  const trimmed = hash.trim()
  if (trimmed.length <= 20) return trimmed
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`
}

/**
 * Shorten a session id for a group heading. Session ids are credentials-free
 * opaque strings; the last 8 characters identify them without reading as a
 * wall of text. A session id that is already short is kept verbatim.
 */
export function shortSessionId(sessionId: string | null | undefined): string {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const cleaned = sessionId.replace(/^sess[_-]?/i, '')
  if (cleaned.length <= 8) return cleaned
  return cleaned.slice(-8)
}

/** Keep the tail of a long filesystem path for tight row space. */
export function shortPath(path: string | null | undefined): string {
  if (typeof path !== 'string' || path === '') return ''
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length <= 2) return path
  return `…${separator}${parts.slice(-2).join(separator)}`
}

/** The file name of a path (the download name when the task has no fileName). */
export function baseName(path: string | null | undefined): string {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.length === 0 ? path : (parts[parts.length - 1] as string)
}

/** One-line detail for a diagnostic event (message, attempt, retry delay). */
export function eventDetail(event: {
  message?: string | null
  attempt?: number | null
  delayMs?: number | null
}): string {
  const message = typeof event.message === 'string' ? event.message : ''
  const parts: string[] = []
  if (message !== '') parts.push(message)
  // Kernel messages often carry the same facts; only append what is not there.
  if (typeof event.attempt === 'number' && event.attempt > 0 && !/attempt\s+\d+/i.test(message)) {
    parts.push(`attempt ${event.attempt}`)
  }
  if (typeof event.delayMs === 'number' && event.delayMs > 0 && !message.includes(`+${event.delayMs}ms`)) {
    parts.push(`+${event.delayMs}ms`)
  }
  return parts.join(', ')
}

/** Clamp one number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Human-readable status word lookup handled by the caller's `t`; this only maps codes. */
export function taskStateOf(status: string): 'live' | 'paused' | 'done' | 'failed' | 'idle' {
  switch (status) {
    case 'running':
    case 'probing':
    case 'queued':
      return 'live'
    case 'paused':
    case 'interrupted':
      return 'paused'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

/** Progress fraction 0..1 for the byte meter; unknown total renders a 0 width. */
export function progressFraction(downloaded: number, total: number | null): number {
  if (total === null || total <= 0) return 0
  return clamp(downloaded / total, 0, 1)
}

/** Integer percent copy (`42%`); unknown stays empty, never `0%`. */
export function formatPercent(percent: number | null | undefined): string {
  if (typeof percent !== 'number' || !isFinite(percent)) return ''
  return `${Math.round(clamp(percent, 0, 100))}%`
}

/** A task id shortened for a dense chip; the full id is the copy payload. */
export function shortTaskId(id: string, length = 11): string {
  const trimmed = id.trim()
  if (trimmed.length <= length) return trimmed
  return `${trimmed.slice(0, length)}…`
}

/** A file name without its extension, for tight titles. */
export function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}
