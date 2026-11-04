// Small display helpers for the RDM panel. Pure functions, no locale data.

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

/** Format a transfer rate. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (typeof bytesPerSecond !== 'number' || !isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Format a remaining-time duration in seconds. */
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

/** Format an epoch-millisecond timestamp as a local wall clock. */
export function formatClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Keep the tail of a long filesystem path for tight row space. */
export function shortPath(path: string | null | undefined): string {
  if (typeof path !== 'string' || path === '') return ''
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length <= 2) return path
  return `…${separator}${parts.slice(-2).join(separator)}`
}

/** One-line detail for a diagnostic event (message, attempt, retry delay). */
export function eventDetail(event: { message?: string | null; attempt?: number | null; delayMs?: number | null }): string {
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
