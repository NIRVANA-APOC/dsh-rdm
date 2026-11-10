// Pure presentation model for the review surfaces: everything that turns a
// normalized TaskView into the words and marks the UI shows. No JSX, no React,
// no network — this module is trivially reviewable and testable.

import { formatBytes, formatDuration, formatRemaining, hashPrefix, shortSessionId, taskStateOf } from './format'
import type { SessionMeta, TFunction, TaskView, WorkspaceMeta } from './types'

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

/**
 * The directory that contains a record's saved file.
 *
 * Finished tasks carry the full file path, so the containing directory is its
 * parent; running or unfinished tasks only know their destination directory.
 * This is the path the "open containing folder" affordance acts on (and the
 * one offered for copying when the host cannot open it).
 */
export function taskFolder(task: TaskView): string {
  if (task.path !== null && task.path !== '') {
    const trimmed = task.path.replace(/[\\/]+$/, '')
    const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    if (at > 0) return trimmed.slice(0, at)
  }
  return task.dir !== null && task.dir !== '' ? task.dir.replace(/[\\/]+$/, '') : taskPath(task)
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

/* -------------------------------------------------------------- grouping */

/** One owning session inside a workspace group. */
export interface SessionGroup {
  sessionId: string | null
  /** Raw log-backed title, or null when the host has no catalog entry. */
  title: string | null
  tasks: TaskView[]
  active: number
  done: number
  failed: number
  nowBps: number
  lastActivity: number
}

/** Records grouped workspace first, then session (the human's mental model). */
export interface WorkspaceGroup {
  workspaceId: string | null
  title: string | null
  path: string | null
  sessions: SessionGroup[]
  tasks: TaskView[]
  active: number
  done: number
  failed: number
  lastActivity: number
}

/** The state buckets the stat cards and filters share. */
export type StatusBucket = 'all' | 'active' | 'done' | 'failed'

/** Recency key of one record (finished/started/created, newest wins). */
function recencyOf(task: TaskView): number {
  return Math.max(task.finishedAt ?? 0, task.startedAt ?? 0, task.createdAt ?? 0)
}

function bucketOf(task: TaskView): Exclude<StatusBucket, 'all'> {
  if (task.status === 'failed') return 'failed'
  if (task.status === 'completed') return 'done'
  return 'active'
}

/** Count of records in each stat-card bucket. */
export function cardCounts(tasks: TaskView[]): Record<Exclude<StatusBucket, 'all'>, number> {
  const counts = { active: 0, done: 0, failed: 0 }
  for (const task of tasks) counts[bucketOf(task)] += 1
  return counts
}

/** Whether a record belongs to the active bucket (queued/probing/running). */
export function isActive(task: TaskView): boolean {
  return task.status === 'queued' || task.status === 'probing' || task.status === 'running'
}

/** Whether the record is finished in a terminal sense. */
export function isFinished(task: TaskView): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
}

/** Normalize a path for prefix comparison (`\` → `/`, trim trailing slash). */
function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Longest-prefix workspace match for a directory (case-insensitive). */
function workspaceOfPath(dir: string | null, workspaces: WorkspaceMeta[]): WorkspaceMeta | null {
  if (dir === null || dir === '') return null
  const target = normalPath(dir)
  let best: WorkspaceMeta | null = null
  let bestLength = -1
  for (const workspace of workspaces) {
    const candidate = normalPath(workspace.path)
    if (candidate === '') continue
    if (target === candidate || target.startsWith(`${candidate}/`)) {
      if (candidate.length > bestLength) {
        best = workspace
        bestLength = candidate.length
      }
    }
  }
  return best
}

/** The workspace a record belongs to, from its session, cwd or destination. */
export function workspaceOf(
  task: TaskView,
  sessions: Record<string, SessionMeta>,
  workspaces: WorkspaceMeta[],
): { workspace: WorkspaceMeta | null; session: SessionMeta | null } {
  const session = task.sessionId === null ? null : (sessions[task.sessionId] ?? null)
  if (session !== null && session.workspaceId !== null) {
    const direct = workspaces.find((workspace) => workspace.id === session.workspaceId)
    if (direct !== undefined) return { workspace: direct, session }
  }
  const byCwd = workspaceOfPath(session?.workspacePath ?? session?.cwd ?? null, workspaces)
  if (byCwd !== null) return { workspace: byCwd, session }
  return { workspace: workspaceOfPath(task.dir, workspaces), session }
}

function pushTask(map: Map<string, SessionGroup>, task: TaskView, title: string | null): void {
  const key = task.sessionId ?? ''
  let group = map.get(key)
  if (group === undefined) {
    group = {
      sessionId: task.sessionId,
      title,
      tasks: [],
      active: 0,
      done: 0,
      failed: 0,
      nowBps: 0,
      lastActivity: 0,
    }
    map.set(key, group)
  }
  group.tasks.push(task)
  group[bucketOf(task)] += 1
  if (task.status === 'running' || task.status === 'probing') group.nowBps += task.speedBps
  group.lastActivity = Math.max(group.lastActivity, recencyOf(task))
}

/**
 * Group the ledger workspace first, then by session. Sessions are identified by
 * their real title (the host resolves it from the session log); when the host
 * has no catalog entry the title stays null and the UI falls back to a short id.
 * Groups with active work come first inside a workspace, then recency.
 */
export function groupByWorkspace(
  tasks: TaskView[],
  sessions: Record<string, SessionMeta>,
  workspaces: WorkspaceMeta[],
): WorkspaceGroup[] {
  const byWorkspace = new Map<string, { meta: WorkspaceMeta | null; sessions: Map<string, SessionGroup> }>()

  for (const task of tasks) {
    const resolved = workspaceOf(task, sessions, workspaces)
    const key = resolved.workspace?.id ?? ''
    let bucket = byWorkspace.get(key)
    if (bucket === undefined) {
      bucket = { meta: resolved.workspace, sessions: new Map() }
      byWorkspace.set(key, bucket)
    }
    pushTask(bucket.sessions, task, resolved.session?.title ?? null)
  }

  const groups: WorkspaceGroup[] = []
  for (const bucket of byWorkspace.values()) {
    const sessionGroups = [...bucket.sessions.values()]
    for (const group of sessionGroups) group.tasks.sort((left, right) => recencyOf(right) - recencyOf(left))
    sessionGroups.sort((left, right) => right.active - left.active || right.lastActivity - left.lastActivity)
    const all = sessionGroups.flatMap((group) => group.tasks)
    groups.push({
      workspaceId: bucket.meta?.id ?? null,
      title: bucket.meta?.title ?? null,
      path: bucket.meta?.path ?? null,
      sessions: sessionGroups,
      tasks: all,
      active: sessionGroups.reduce((sum, group) => sum + group.active, 0),
      done: sessionGroups.reduce((sum, group) => sum + group.done, 0),
      failed: sessionGroups.reduce((sum, group) => sum + group.failed, 0),
      lastActivity: Math.max(...sessionGroups.map((group) => group.lastActivity), 0),
    })
  }
  groups.sort((left, right) => right.active - left.active || right.lastActivity - left.lastActivity)
  return groups
}

/** Rows grouped by owning session, newest first (legacy callers). */
export function groupBySession(tasks: TaskView[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>()
  for (const task of tasks) pushTask(map, task, null)
  const groups = [...map.values()]
  for (const group of groups) group.tasks.sort((left, right) => recencyOf(right) - recencyOf(left))
  groups.sort((left, right) => right.active - left.active || right.lastActivity - left.lastActivity)
  return groups
}

/* --------------------------------------------------------------- filters */

/** The filter state the workbench toolbar owns. */
export interface FilterState {
  query: string
  bucket: StatusBucket
  /** Lower-case extensions without the dot; empty means every suffix. */
  extensions: string[]
}

export const EMPTY_FILTER: FilterState = { query: '', bucket: 'all', extensions: [] }

/** File-name extension, lower-case without the dot (url path when no name). */
export function extensionOf(task: TaskView): string | null {
  const fromName = /\.([a-z0-9]{1,12})$/i.exec(task.fileName)
  if (fromName !== null) return fromName[1]!.toLowerCase()
  if (task.path !== null) {
    const fromPath = /\.([a-z0-9]{1,12})$/i.exec(task.path)
    if (fromPath !== null) return fromPath[1]!.toLowerCase()
  }
  try {
    const pathname = new URL(task.url).pathname
    const fromUrl = /\.([a-z0-9]{1,12})$/i.exec(pathname)
    if (fromUrl !== null) return fromUrl[1]!.toLowerCase()
  } catch {
    // Not a parseable absolute URL: no suffix.
  }
  return null
}

/** One entry of the suffix dropdown, with its current record count. */
export interface ExtensionOption {
  extension: string
  count: number
}

/** Every suffix present in the given records, most frequent first. */
export function extensionOptions(tasks: TaskView[]): ExtensionOption[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    const extension = extensionOf(task)
    if (extension === null) continue
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([extension, count]) => ({ extension, count }))
    .sort((left, right) => right.count - left.count || left.extension.localeCompare(right.extension))
}

/** Text that a query term may match. */
function haystackOf(task: TaskView, sessions: Record<string, SessionMeta>, workspaces: WorkspaceMeta[]): string {
  const resolved = workspaceOf(task, sessions, workspaces)
  return [
    task.id,
    task.fileName,
    task.url,
    task.finalUrl ?? '',
    task.host ?? '',
    task.path ?? '',
    task.dir ?? '',
    resolved.session?.title ?? '',
    resolved.workspace?.title ?? '',
  ]
    .join('\n')
    .toLowerCase()
}

/** Whether a record passes the workbench filter. */
export function matchesFilter(
  task: TaskView,
  filter: FilterState,
  sessions: Record<string, SessionMeta>,
  workspaces: WorkspaceMeta[],
): boolean {
  if (filter.bucket !== 'all' && bucketOf(task) !== filter.bucket) return false
  if (filter.extensions.length > 0) {
    const extension = extensionOf(task)
    if (extension === null || !filter.extensions.includes(extension)) return false
  }
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length === 0) return true
  const haystack = haystackOf(task, sessions, workspaces)
  return terms.every((term) => haystack.includes(term))
}

/** Filter a record list, keeping the incoming order. */
export function filterTasks(
  tasks: TaskView[],
  filter: FilterState,
  sessions: Record<string, SessionMeta>,
  workspaces: WorkspaceMeta[],
): TaskView[] {
  return tasks.filter((task) => matchesFilter(task, filter, sessions, workspaces))
}

/** Whether the filter is not the identity filter. */
export function filterActive(filter: FilterState): boolean {
  return filter.bucket !== 'all' || filter.extensions.length > 0 || filter.query.trim() !== ''
}

/* ------------------------------------------------------------ connections */

/** The worker counts a record exposes (all nullable on an old host). */
export interface ConnectionInfo {
  /** Actually active worker connections right now. */
  current: number | null
  /** Controller target (adaptive concurrency). */
  target: number | null
  /** Connections requested at start. */
  requested: number | null
  /** Adaptive ceiling. */
  max: number | null
}

/** Read the worker counts, preferring the live active count. */
export function connectionInfoOf(task: TaskView): ConnectionInfo {
  return {
    current: task.activeWorkers !== null && task.activeWorkers > 0 ? task.activeWorkers : null,
    target: task.targetWorkers !== null && task.targetWorkers > 0 ? task.targetWorkers : null,
    requested: task.requestedConnections !== null && task.requestedConnections > 0
      ? task.requestedConnections
      : task.connections !== null && task.connections > 0
        ? task.connections
        : null,
    max: task.maxConnections !== null && task.maxConnections > 0 ? task.maxConnections : null,
  }
}

/** The compact connection label: current workers, target when it differs. */
export function connectionLabel(task: TaskView): string | null {
  const info = connectionInfoOf(task)
  const current = info.current ?? info.target
  if (current === null) return null
  if (info.target !== null && info.current !== null && info.target !== info.current) {
    return `${info.current}→${info.target}`
  }
  return String(current)
}

/** The number shown in the record meta as "current connections". */
export function currentConnections(task: TaskView): number | null {
  if (task.status === 'running' || task.status === 'probing') {
    return task.activeWorkers ?? task.targetWorkers ?? task.requestedConnections
  }
  if (task.status === 'queued') {
    return task.targetWorkers ?? task.requestedConnections ?? task.connections
  }
  return null
}

/* ------------------------------------------------------------- rates/misc */

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

/** Whether the record's rate is expected to move right now. */
export function isMoving(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'probing'
}

/** Whether the record can be paused by the human. */
export function canPause(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'probing' || task.status === 'queued'
}

/** Whether the record can be resumed by the human. */
export function canResume(task: TaskView): boolean {
  return task.status === 'paused' || task.status === 'interrupted' || task.status === 'cancelled' || task.status === 'failed'
}

/** A stable, short label for a session without a resolvable title. */
export function sessionFallbackId(sessionId: string | null): string {
  return shortSessionId(sessionId)
}
