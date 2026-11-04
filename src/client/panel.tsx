// dsh-rdm download panel.
//
// The downloader's left-sidebar entry opens this page. The page is a transfer
// ledger: a compact instrument header, a one-line start composer, then one row
// per download. Each row's rail is split into connection lanes — the panel's
// only loud element — because parallel connections are what this engine is.
//
// All copy comes from the plugin locale namespace; all colors from host theme
// tokens. Protocol logic (poll / start / control / events) is unchanged from
// the previous version; this file reworks the surface.

import React from 'react'
import { controlTask, errorText, request } from './api'
import { eventDetail, formatBytes, formatClock, formatDuration, formatSpeed, shortPath } from './format'
import { PANEL_CSS } from './styles'
import type {
  ControlOp,
  GetValue,
  KernelInfo,
  ListValue,
  LocaleService,
  StartValue,
  TFunction,
  TaskEvent,
  TaskView,
} from './types'

const POLL_MS = 1000
const LIST_TIMEOUT_MS = 12000
const ACTION_TIMEOUT_MS = 20000
const EVENTS_TIMEOUT_MS = 15000
const EVENT_LIMIT = 20

type Filter = 'all' | 'active' | 'finished'

const ACTIVE_STATUSES = new Set(['queued', 'probing', 'running', 'paused', 'interrupted'])

export interface PanelProps {
  t: TFunction
  locale?: LocaleService
}

/** The slices of React events this panel uses (no @types/react here). */
interface FormSubmitEvent {
  preventDefault(): void
}

interface InputChangeEvent {
  target: { value: string }
}

interface ClickLikeEvent {
  currentTarget: HTMLElement
}

interface MenuKeyEvent {
  key: string
  preventDefault(): void
}

interface EventsState {
  loading: boolean
  error: string | null
  events: TaskEvent[] | null
}

interface KernelView {
  tone: 'ok' | 'warn' | 'error' | 'idle'
  label: string
  meta: string
  title: string
}

/* ---------------------------------------------------------------- helpers */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status)
}

function statusTone(status: string): 'business' | 'success' | 'warn' | 'error' | 'muted' {
  switch (status) {
    case 'running':
    case 'probing':
      return 'business'
    case 'paused':
    case 'interrupted':
      return 'warn'
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    default:
      return 'muted'
  }
}

function statusLabel(t: TFunction, status: string): string {
  const key = `status.${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

function fileNameOf(task: TaskView): string {
  if (typeof task.fileName === 'string' && task.fileName !== '') return task.fileName
  if (typeof task.url === 'string' && task.url !== '') return task.url
  return task.id
}

function taskPath(task: TaskView): string {
  if (typeof task.path === 'string' && task.path !== '') return task.path
  if (typeof task.dir === 'string') return task.dir
  return ''
}

function taskTotal(task: TaskView): number | null {
  return typeof task.total === 'number' && isFinite(task.total) && task.total > 0 ? task.total : null
}

function taskDownloaded(task: TaskView): number {
  return typeof task.downloaded === 'number' && isFinite(task.downloaded) && task.downloaded > 0
    ? task.downloaded
    : 0
}

function taskPercent(task: TaskView): number | null {
  const total = taskTotal(task)
  if (total === null) return task.status === 'completed' ? 100 : null
  return clamp((taskDownloaded(task) / total) * 100, 0, 100)
}

/** Visible connection slots for the lane meter: planned cap and staffed lanes. */
function laneMeter(task: TaskView): { total: number; active: number; running: boolean } | null {
  if (typeof task.connections !== 'number' || !isFinite(task.connections) || task.connections <= 0) return null
  const total = clamp(Math.round(task.connections), 1, 8)
  const running = task.status === 'running'
  const active = running && typeof task.activeWorkers === 'number' && isFinite(task.activeWorkers)
    ? clamp(Math.round(task.activeWorkers), 0, total)
    : 0
  return { total, active, running }
}

function kernelView(kernel: KernelInfo | null, pollError: string | null, t: TFunction): KernelView {
  if (pollError !== null) {
    return { tone: 'error', label: t('kernel.unreachable'), meta: '', title: pollError }
  }
  if (kernel === null) return { tone: 'idle', label: t('kernel.connecting'), meta: '', title: '' }
  if (typeof kernel.error === 'string' && kernel.error !== '') {
    return { tone: 'error', label: t('kernel.error'), meta: '', title: kernel.error }
  }
  if (kernel.starting) return { tone: 'warn', label: t('kernel.starting'), meta: '', title: '' }
  if (kernel.running) {
    const version = kernel.version ? `v${kernel.version}` : ''
    const title = [
      typeof kernel.pid === 'number' ? `pid ${kernel.pid}` : '',
      typeof kernel.dataDir === 'string' ? kernel.dataDir : '',
    ]
      .filter((part) => part !== '')
      .join(' — ')
    return { tone: 'ok', label: t('kernel.running'), meta: version, title }
  }
  return { tone: 'idle', label: t('kernel.stopped'), meta: '', title: '' }
}

function statusRank(status: string): number {
  switch (status) {
    case 'running':
      return 0
    case 'probing':
      return 1
    case 'queued':
      return 2
    case 'paused':
      return 3
    case 'interrupted':
      return 4
    default:
      return 5
  }
}

/** Copy text with a fallback for environments that deny the async clipboard. */
async function copyText(text: string): Promise<boolean> {
  if (text === '') return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function eventsError(t: TFunction, error: unknown): string {
  return errorText(t, error) || t('row.eventsFailed')
}

/* ------------------------------------------------------------------ icons */

function PauseIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="4" y="3" width="3" height="10" rx="1.2" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 3.4c0-.8.9-1.3 1.6-.9l6 4.1c.6.4.6 1.3 0 1.7l-6 4.1c-.7.5-1.6 0-1.6-.8V3.4Z" fill="currentColor" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M12.6 6.4A5 5 0 1 0 13 9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M12.9 2.8v3.9H9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 5.3V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m5 6.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg className="rdm-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3.2" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.25" fill="currentColor" />
    </svg>
  )
}

function LaneMeter({ lanes }: { lanes: { total: number; active: number; running: boolean } }) {
  return (
    <span className="rdm-lanes" aria-hidden="true">
      {Array.from({ length: lanes.total }, (_, lane) => (
        <span
          className="rdm-lane-mark"
          key={lane}
          data-active={lane < lanes.active ? 'true' : undefined}
          data-running={lanes.running ? 'true' : undefined}
          style={{ animationDelay: `${lane * 0.16}s` }}
        />
      ))}
    </span>
  )
}

function Spinner() {
  return <span className="rdm-spinner" aria-hidden="true" />
}

function GhostRail() {
  return (
    <span className="rdm-empty-meter" aria-hidden="true">
      <span className="rdm-empty-lanes">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((lane) => (
          <span key={lane} data-lit={lane < 4 ? 'true' : undefined} />
        ))}
      </span>
      <span className="rdm-empty-rail">
        <span className="rdm-empty-rail-fill" />
      </span>
    </span>
  )
}

/* --------------------------------------------------------------- subviews */

function KernelStatus({ view }: { view: KernelView }) {
  return (
    <span className="rdm-kernel" data-tone={view.tone} title={view.title === '' ? undefined : view.title}>
      <span className="rdm-kernel-dot" aria-hidden="true" />
      <span className="rdm-kernel-label">{view.label}</span>
      {view.meta !== '' ? <span className="rdm-kernel-meta">{view.meta}</span> : null}
    </span>
  )
}

function RouteAlert({ message, t, retrying, onRetry }: { message: string; t: TFunction; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="rdm-alert" role="alert">
      <div className="rdm-alert-body">
        <span className="rdm-alert-title">{t('route.errorTitle')}</span>
        <span className="rdm-alert-text">{message}</span>
        <span className="rdm-alert-hint">{t('route.errorHint')}</span>
      </div>
      <button type="button" className="rdm-btn rdm-btn--ghost" onClick={onRetry} disabled={retrying}>
        {retrying ? t('route.retrying') : t('route.retry')}
      </button>
    </div>
  )
}

function EmptyState({ t }: { t: TFunction }) {
  return (
    <div className="rdm-empty">
      <GhostRail />
      <p className="rdm-empty-title">{t('empty.title')}</p>
      <p className="rdm-empty-desc">{t('empty.desc')}</p>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="rdm-skeleton" aria-hidden="true">
      {[0, 1].map((row) => (
        <div className="rdm-skeleton-row" key={row}>
          <span className="rdm-skeleton-line rdm-skeleton-line--name" />
          <span className="rdm-skeleton-rail">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((lane) => (
              <span className="rdm-skeleton-lane" key={lane} style={{ animationDelay: `${lane * 0.07}s` }} />
            ))}
          </span>
          <span className="rdm-skeleton-line rdm-skeleton-line--meta" />
        </div>
      ))}
    </div>
  )
}

function EventLog({ state, t }: { state: EventsState | undefined; t: TFunction }) {
  const events = state?.events ?? null
  const loading = state?.loading === true
  const error = state?.error ?? null
  return (
    <div className="rdm-events-block">
      <div className="rdm-events-head">
        <span>{t('row.events')}</span>
        {loading ? <span className="rdm-events-loading"><Spinner /> {t('row.eventsLoading')}</span> : null}
      </div>
      {error !== null ? <span className="rdm-events-note">{error}</span> : null}
      {!loading && error === null && events !== null && events.length === 0 ? (
        <span className="rdm-events-note">{t('row.eventsEmpty')}</span>
      ) : null}
      {events !== null && events.length > 0 ? (
        <div className="rdm-events" role="log" aria-label={t('row.events')}>
          {events.map((event) => {
            const detail = eventDetail(event)
            return (
              <div className="rdm-event" key={event.seq}>
                <span className="rdm-event-time">{formatClock(event.at)}</span>
                <span className="rdm-event-kind">{event.kind}</span>
                {detail !== '' ? <span className="rdm-event-detail">{detail}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash
}

function TaskDetails({ task, t, events }: { task: TaskView; t: TFunction; events: EventsState | undefined }) {
  const total = taskTotal(task)
  const rows: Array<{ label: string; value: string; code?: boolean; title?: string }> = []
  const source = typeof task.finalUrl === 'string' && task.finalUrl !== '' ? task.finalUrl : task.url
  if (source !== '') rows.push({ label: t('details.url'), value: source, code: true, title: source })
  if (typeof task.path === 'string' && task.path !== '') rows.push({ label: t('details.path'), value: task.path, code: true, title: task.path })
  rows.push({ label: t('details.size'), value: total !== null ? formatBytes(total) : t('details.unknown') })
  if (typeof task.peakWorkers === 'number' && task.peakWorkers > 0) {
    rows.push({ label: t('details.peakConnections'), value: String(task.peakWorkers) })
  }
  if (typeof task.chunkSize === 'number' && task.chunkSize > 0) {
    rows.push({ label: t('details.chunkSize'), value: formatBytes(task.chunkSize) })
  } else if (task.rangeSupported === false) {
    rows.push({ label: t('details.chunkSize'), value: t('details.chunkSingle') })
  }
  if (typeof task.resumedChunks === 'number' && task.resumedChunks > 0) {
    rows.push({ label: t('details.resumedChunks'), value: String(task.resumedChunks) })
  }
  if (typeof task.sha256 === 'string' && task.sha256 !== '') {
    rows.push({ label: t('details.checksum'), value: shortHash(task.sha256), code: true, title: task.sha256 })
  } else if (typeof task.expectedSha256 === 'string' && task.expectedSha256 !== '') {
    rows.push({ label: t('details.expectedChecksum'), value: shortHash(task.expectedSha256), code: true, title: task.expectedSha256 })
  }
  if (typeof task.startedAt === 'number' && task.startedAt > 0) {
    rows.push({ label: t('details.startedAt'), value: formatClock(task.startedAt) })
  }
  if (typeof task.elapsedMs === 'number' && task.elapsedMs > 0) {
    rows.push({ label: t('details.elapsed'), value: formatDuration(task.elapsedMs / 1000) })
  }
  if (typeof task.retries === 'number' && task.retries > 0) {
    rows.push({ label: t('details.retries'), value: String(task.retries) })
  }
  if (task.error !== null && typeof task.error === 'object' && typeof task.error.message === 'string' && task.error.message !== '') {
    rows.push({ label: t('details.error'), value: task.error.message, code: true, title: task.error.message })
  }

  return (
    <div className="rdm-details">
      <dl className="rdm-details-grid">
        {rows.map((row) => (
          <div className="rdm-detail" key={row.label + row.value}>
            <dt>{row.label}</dt>
            <dd>
              {row.code ? (
                <code title={row.title}>{row.value}</code>
              ) : (
                <span title={row.title}>{row.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <EventLog state={events} t={t} />
    </div>
  )
}

type PrimaryAction =
  | { kind: 'op'; op: ControlOp; label: string; icon: unknown }
  | { kind: 'copy-path'; label: string; icon: unknown }

function primaryAction(task: TaskView, t: TFunction): PrimaryAction | null {
  switch (task.status) {
    case 'queued':
    case 'probing':
    case 'running':
      return { kind: 'op', op: 'pause', label: t('row.pause'), icon: <PauseIcon /> }
    case 'paused':
    case 'interrupted':
      return { kind: 'op', op: 'resume', label: t('row.resume'), icon: <PlayIcon /> }
    case 'failed':
    case 'cancelled':
      return { kind: 'op', op: 'retry', label: t('row.retry'), icon: <RetryIcon /> }
    case 'completed':
      return { kind: 'copy-path', label: t('row.copyPath'), icon: <CopyIcon /> }
    default:
      return null
  }
}

interface MenuAction {
  kind: 'control'
  op: ControlOp
  label: string
  danger: boolean
}

function menuActions(task: TaskView, t: TFunction): MenuAction[] {
  return isActiveStatus(task.status)
    ? [{ kind: 'control', op: 'cancel', label: t('row.cancel'), danger: true }]
    : [{ kind: 'control', op: 'remove', label: t('row.remove'), danger: true }]
}

interface TaskRowProps {
  key?: string
  task: TaskView
  t: TFunction
  busy: ControlOp | null
  rowError: string | null
  expanded: boolean
  menuOpen: boolean
  events: EventsState | undefined
  onControl: (task: TaskView, op: ControlOp) => void
  onToggleDetails: (task: TaskView) => void
  onOpenMenu: (task: TaskView, trigger: HTMLElement) => void
  onCloseMenu: () => void
  onCopy: (text: string, doneMessage: string) => void
}

function TaskRow(props: TaskRowProps) {
  const { task, t, busy, rowError, expanded, menuOpen, events, onControl, onToggleDetails, onOpenMenu, onCloseMenu, onCopy } = props
  const status = typeof task.status === 'string' && task.status !== '' ? task.status : 'queued'
  const total = taskTotal(task)
  const downloaded = taskDownloaded(task)
  const speed = typeof task.speedBps === 'number' && isFinite(task.speedBps) ? task.speedBps : 0
  const eta = typeof task.etaSecs === 'number' && isFinite(task.etaSecs) ? task.etaSecs : null
  const activeWorkers = typeof task.activeWorkers === 'number' && isFinite(task.activeWorkers) ? task.activeWorkers : 0
  const connections = typeof task.connections === 'number' && isFinite(task.connections) && task.connections > 0 ? task.connections : null
  const fileName = fileNameOf(task)
  const path = typeof task.path === 'string' && task.path !== '' ? task.path : ''
  const tone = statusTone(status)
  const percent = taskPercent(task)
  const indeterminate = (status === 'running' || status === 'probing') && total === null
  const primary = primaryAction(task, t)
  const menu = menuActions(task, t)
  const started = status === 'running' || status === 'probing'
  const meter = laneMeter(task)
  const detailsId = `rdm-row-details-${task.id}`

  const meta: Array<{ label: string; value: string; lanes?: { total: number; active: number; running: boolean } }> = []
  if (total !== null) {
    meta.push({ label: t('row.size'), value: `${formatBytes(downloaded)} / ${formatBytes(total)}` })
  } else if (downloaded > 0) {
    meta.push({ label: t('row.downloaded'), value: formatBytes(downloaded) })
  }
  if (status === 'running' && speed > 0) meta.push({ label: t('row.speed'), value: formatSpeed(speed) })
  if (status === 'running' && eta !== null) meta.push({ label: t('row.eta'), value: formatDuration(eta) })
  if (connections !== null) {
    meta.push({
      label: t('row.connections'),
      value: started && activeWorkers > 0 ? `${activeWorkers}/${connections}` : String(connections),
      lanes: isActiveStatus(status) && meter !== null ? meter : undefined,
    })
  }

  const kernelError =
    task.error !== null && typeof task.error === 'object' && typeof task.error.code === 'string'
      ? errorText(t, task.error)
      : null

  const progressText =
    percent !== null
      ? `${Math.round(percent)}%`
      : (status === 'running' || status === 'probing') && total === null
        ? t('row.progressUnknown')
        : statusLabel(t, status)

  const pathLabel = status === 'completed' ? t('row.savedTo') : t('row.target')

  return (
    <article className="rdm-row" data-rdm-row data-status={status} aria-busy={busy !== null ? 'true' : undefined}>
      <div className="rdm-row-top">
        <span className="rdm-state" data-tone={tone}>
          <span className="rdm-state-dot" aria-hidden="true" />
          <span className="rdm-state-label">{statusLabel(t, status)}</span>
        </span>
        <span className="rdm-row-name" title={fileName}>
          {fileName}
        </span>
        {percent !== null && status !== 'completed' && status !== 'failed' ? <span className="rdm-row-pct">{Math.round(percent)}%</span> : null}
        <div className="rdm-row-actions">
          {primary !== null ? (
            <button
              type="button"
              className="rdm-btn rdm-btn--icon"
              data-rdm-action={primary.kind === 'op' ? primary.op : 'copy-path'}
              aria-label={primary.label}
              title={primary.label}
              disabled={busy !== null || (primary.kind === 'copy-path' && path === '')}
              onClick={() => {
                if (primary.kind === 'copy-path') onCopy(path, t('row.copiedPath'))
                else onControl(task, primary.op)
              }}
            >
              {busy !== null && primary.kind === 'op' && busy === primary.op ? <Spinner /> : primary.icon}
            </button>
          ) : null}
          <button
            type="button"
            className="rdm-btn rdm-btn--icon"
            data-rdm-action="details"
            aria-label={expanded ? t('row.hideDetails') : t('row.details')}
            title={expanded ? t('row.hideDetails') : t('row.details')}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => onToggleDetails(task)}
          >
            <span className="rdm-chevron" data-expanded={expanded}>
              <ChevronIcon />
            </span>
          </button>
          <span className="rdm-menu-anchor">
            <button
              type="button"
              className="rdm-btn rdm-btn--icon"
              data-rdm-action="menu"
              aria-label={t('row.more')}
              title={t('row.more')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy !== null}
              onClick={(event: ClickLikeEvent) => {
                if (menuOpen) onCloseMenu()
                else onOpenMenu(task, event.currentTarget)
              }}
            >
              <MoreIcon />
            </button>
            {menuOpen ? (
              <div
                className="rdm-menu"
                role="menu"
                aria-label={fileName}
                onKeyDown={(event: MenuKeyEvent) => {
                  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.rdm-menu [role="menuitem"]')).filter(
                    (item) => item.offsetParent !== null,
                  )
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    items[(index + 1) % items.length]?.focus()
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    items[(index - 1 + items.length) % items.length]?.focus()
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    items[0]?.focus()
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    items[items.length - 1]?.focus()
                  }
                }}
              >
                <div className="rdm-menu-touch">
                  {primary !== null ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="rdm-menu-item"
                      onClick={() => {
                        if (primary.kind === 'copy-path') onCopy(path, t('row.copiedPath'))
                        else onControl(task, primary.op)
                        onCloseMenu()
                      }}
                    >
                      {primary.label}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="rdm-menu-item"
                    onClick={() => {
                      onToggleDetails(task)
                      onCloseMenu()
                    }}
                  >
                    {expanded ? t('row.hideDetails') : t('row.details')}
                  </button>
                  <span className="rdm-menu-sep" aria-hidden="true" />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="rdm-menu-item"
                  onClick={() => {
                    onCopy(task.url, t('row.copiedUrl'))
                    onCloseMenu()
                  }}
                >
                  {t('row.copyUrl')}
                </button>
                <span className="rdm-menu-sep" aria-hidden="true" />
                {menu.map((item) => (
                  <button
                    key={item.op}
                    type="button"
                    role="menuitem"
                    className={['rdm-menu-item', item.danger ? 'rdm-menu-item--danger' : ''].filter((part) => part !== '').join(' ')}
                    onClick={() => {
                      onControl(task, item.op)
                      onCloseMenu()
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        </div>
      </div>

      <div
        className="rdm-rail"
        data-rdm-rail
        data-state={tone}
        data-indeterminate={indeterminate ? 'true' : undefined}
        data-history={isActiveStatus(status) ? undefined : 'true'}
        role="progressbar"
        aria-label={fileName}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent !== null ? Math.round(percent) : undefined}
        aria-valuetext={progressText}
      >
        <span className="rdm-rail-fill" style={{ width: `${percent !== null ? percent : 0}%` }} />
      </div>

      {meta.length > 0 ? (
        <div className="rdm-meta">
          {meta.map((item) => (
            <span className="rdm-meta-item" key={item.label}>
              <span className="rdm-meta-label">{item.label}</span>
              {item.lanes ? <LaneMeter lanes={item.lanes} /> : null}
              <span className="rdm-meta-value">{item.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {path !== '' && (status === 'completed' || status === 'running' || status === 'paused' || status === 'interrupted') ? (
        <div className="rdm-path-row">
          <span className="rdm-path-label">{pathLabel}</span>
          <span className="rdm-path" title={taskPath(task)}>
            {shortPath(path)}
          </span>
        </div>
      ) : null}

      {kernelError !== null ? (
        <p className="rdm-row-error">
          <span className="rdm-row-error-label">{t('row.errorTitle')}</span>
          <span>{kernelError}</span>
        </p>
      ) : null}
      {rowError !== null ? (
        <p className="rdm-row-error" role="alert">
          <span className="rdm-row-error-label">{t('row.errorTitle')}</span>
          <span>{rowError}</span>
        </p>
      ) : null}

      {expanded ? (
        <div className="rdm-row-details" id={detailsId} role="region" aria-label={t('details.title')}>
          <TaskDetails task={task} t={t} events={events} />
        </div>
      ) : null}
    </article>
  )
}

/* ------------------------------------------------------------------ panel */

export function Panel(props: PanelProps) {
  const t = props.t

  const [list, setList] = React.useState<ListValue | null>(null)
  const [pollError, setPollError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [filter, setFilter] = React.useState<Filter>('all')
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [rowBusy, setRowBusy] = React.useState<Record<string, ControlOp | null>>({})
  const [rowErrors, setRowErrors] = React.useState<Record<string, string | null>>({})
  const [events, setEvents] = React.useState<Record<string, EventsState | undefined>>({})
  const [menuTaskId, setMenuTaskId] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState<string | null>(null)

  const [url, setUrl] = React.useState('')
  const [dir, setDir] = React.useState('')
  const [connections, setConnections] = React.useState('')
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [refocusToken, setRefocusToken] = React.useState(0)
  const [formError, setFormError] = React.useState<string | null>(null)

  const mountedRef = React.useRef(true)
  const inFlightRef = React.useRef(false)
  const urlRef = React.useRef<HTMLInputElement | null>(null)
  const menuTriggerRef = React.useRef<HTMLElement | null>(null)
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Re-render on dictionary/language revisions so slot copy follows the host
  // locale switcher; the bound `t` itself resolves the active language.
  const [, bumpLocale] = React.useReducer((revision: number) => revision + 1, 0)
  React.useEffect(() => {
    const locale = props.locale
    if (!locale || typeof locale.subscribe !== 'function') return undefined
    return locale.subscribe(bumpLocale)
  }, [props.locale])

  const load = React.useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const value = await request<ListValue>({ action: 'list' }, LIST_TIMEOUT_MS)
      if (!mountedRef.current) return
      setList({
        kernel: value && value.kernel ? value.kernel : {},
        tasks: value && Array.isArray(value.tasks) ? value.tasks : [],
      })
      setPollError(null)
    } catch (error) {
      if (!mountedRef.current) return
      setPollError(errorText(t, error))
    } finally {
      inFlightRef.current = false
    }
  }, [t])

  // Poll while the document is visible; a hidden tab costs nothing.
  React.useEffect(() => {
    mountedRef.current = true
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer !== undefined) return
      void load()
      timer = setInterval(() => {
        void load()
      }, POLL_MS)
    }
    const stop = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      mountedRef.current = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  React.useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    }
  }, [])

  // Menu behavior: Escape closes and restores focus; a click outside closes.
  React.useEffect(() => {
    if (menuTaskId === null) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuTaskId(null)
      const trigger = menuTriggerRef.current
      if (trigger) trigger.focus()
    }
    const onPointerDown = (event: Event) => {
      const target = event.target as Element | null
      if (target && typeof target.closest === 'function') {
        if (target.closest('.rdm-menu') || target.closest('[data-rdm-action="menu"]')) return
      }
      setMenuTaskId(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    const focusTimer = setTimeout(() => {
      const first = Array.from(document.querySelectorAll<HTMLButtonElement>('.rdm-menu [role="menuitem"]')).find(
        (item) => item.offsetParent !== null,
      )
      if (first) first.focus()
    }, 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
      clearTimeout(focusTimer)
    }
  }, [menuTaskId])

  // Focus the composer once the submit lock has really been released; a focus
  // call from inside the async handler runs while the input is still disabled.
  React.useEffect(() => {
    if (refocusToken === 0 || submitting) return undefined
    const timer = setTimeout(() => {
      if (urlRef.current) urlRef.current.focus()
    }, 0)
    return () => clearTimeout(timer)
  }, [refocusToken, submitting])

  const showToast = React.useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }, [])

  const onCopy = React.useCallback(
    (text: string, doneMessage: string) => {
      void (async () => {
        const ok = await copyText(text)
        showToast(ok ? doneMessage : t('common.copyFailed'))
      })()
    },
    [showToast, t],
  )

  const tasks = React.useMemo(() => {
    const source = list !== null ? list.tasks : []
    const sorted = source.slice()
    sorted.sort((left, right) => {
      const leftRank = statusRank(String(left.status))
      const rightRank = statusRank(String(right.status))
      if (leftRank !== rightRank) return leftRank - rightRank
      const leftAt = (typeof left.finishedAt === 'number' && left.finishedAt > 0 ? left.finishedAt : left.createdAt) || 0
      const rightAt = (typeof right.finishedAt === 'number' && right.finishedAt > 0 ? right.finishedAt : right.createdAt) || 0
      return rightAt - leftAt
    })
    return sorted
  }, [list])

  const activeCount = tasks.filter((task) => isActiveStatus(String(task.status))).length
  const finishedCount = tasks.length - activeCount
  const runningTasks = tasks.filter((task) => task.status === 'running')
  const failedCount = tasks.filter((task) => task.status === 'failed').length
  const totalSpeed = runningTasks.reduce((sum, task) => sum + (typeof task.speedBps === 'number' ? task.speedBps : 0), 0)

  const filteredTasks = React.useMemo(() => {
    if (filter === 'all') return tasks
    return tasks.filter((task) => (filter === 'active' ? isActiveStatus(String(task.status)) : !isActiveStatus(String(task.status))))
  }, [tasks, filter])

  const summary = list === null ? '' : runningTasks.length > 0
    ? `${t('tasks.runningCount', { n: runningTasks.length })}`
    : t('tasks.idle')

  const kernel = kernelView(list !== null ? list.kernel : null, pollError, t)
  const dataReady = list !== null
  const controlsDisabled = submitting || !dataReady
  const countText = (value: number): string => (list === null ? '—' : String(value))

  const onRetryRoute = () => {
    if (refreshing) return
    setRefreshing(true)
    void load().finally(() => {
      if (mountedRef.current) setRefreshing(false)
    })
  }

  const onSubmit = async (event: FormSubmitEvent) => {
    event.preventDefault()
    if (submitting) return
    const target = url.trim()
    if (target === '') {
      setFormError(t('form.urlRequired'))
      return
    }
    if (!/^https?:\/\//i.test(target)) {
      setFormError(t('form.urlInvalid'))
      return
    }
    const rawConnections = connections.trim()
    let plannedConnections: number | undefined
    if (rawConnections !== '') {
      const parsed = Number(rawConnections)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) {
        setFormError(t('form.connectionsInvalid'))
        return
      }
      plannedConnections = parsed
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const payload: Record<string, unknown> = { action: 'start', url: target }
      const directory = dir.trim()
      if (directory !== '') payload.dir = directory
      if (plannedConnections !== undefined) payload.connections = plannedConnections
      await request<StartValue>(payload, ACTION_TIMEOUT_MS)
      setUrl('')
      setFilter('all')
      setRefocusToken((token) => token + 1)
      void load()
    } catch (error) {
      const message = errorText(t, error)
      setFormError(message !== '' ? message : t('form.startFailed'))
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  const onControl = React.useCallback(
    (task: TaskView, op: ControlOp) => {
      setRowBusy((previous) => ({ ...previous, [task.id]: op }))
      setRowErrors((previous) => ({ ...previous, [task.id]: null }))
      void (async () => {
        try {
          await controlTask(task.id, op)
          if (!mountedRef.current) return
          void load()
        } catch (error) {
          if (!mountedRef.current) return
          setRowErrors((previous) => ({ ...previous, [task.id]: errorText(t, error) }))
        } finally {
          if (!mountedRef.current) return
          setRowBusy((previous) => {
            const next = { ...previous }
            delete next[task.id]
            return next
          })
        }
      })()
    },
    [load, t],
  )

  const onOpenMenu = React.useCallback((task: TaskView, trigger: HTMLElement) => {
    menuTriggerRef.current = trigger
    setMenuTaskId(task.id)
  }, [])

  const onCloseMenu = React.useCallback(() => {
    setMenuTaskId(null)
    const trigger = menuTriggerRef.current
    if (trigger) trigger.focus()
  }, [])

  const onToggleDetails = (task: TaskView) => {
    const willOpen = !expanded[task.id]
    setExpanded((previous) => ({ ...previous, [task.id]: willOpen }))
    if (!willOpen) return
    setEvents((previous) => ({
      ...previous,
      [task.id]: { loading: true, error: null, events: previous[task.id]?.events ?? null },
    }))
    void (async () => {
      try {
        const value = await request<GetValue>({ action: 'get', id: task.id, events: EVENT_LIMIT }, EVENTS_TIMEOUT_MS)
        if (!mountedRef.current) return
        setEvents((previous) => ({
          ...previous,
          [task.id]: { loading: false, error: null, events: value && Array.isArray(value.events) ? value.events.slice(-EVENT_LIMIT) : [] },
        }))
      } catch (error) {
        if (!mountedRef.current) return
        setEvents((previous) => ({
          ...previous,
          [task.id]: { loading: false, error: eventsError(t, error), events: null },
        }))
      }
    })()
  }

  const filters: Array<{ id: Filter; label: string; count: number }> = [
    { id: 'all', label: t('tasks.filterAll'), count: tasks.length },
    { id: 'active', label: t('tasks.filterActive'), count: activeCount },
    { id: 'finished', label: t('tasks.filterFinished'), count: finishedCount },
  ]

  let board: unknown
  if (list === null) {
    board = pollError !== null ? null : <SkeletonRows />
  } else if (tasks.length === 0) {
    board = <EmptyState t={t} />
  } else if (filteredTasks.length === 0) {
    board = <p className="rdm-filter-empty">{t('tasks.filterEmpty')}</p>
  } else {
    board = filteredTasks.map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        t={t}
        busy={rowBusy[task.id] ?? null}
        rowError={rowErrors[task.id] ?? null}
        expanded={expanded[task.id] === true}
        menuOpen={menuTaskId === task.id}
        events={events[task.id]}
        onControl={onControl}
        onToggleDetails={onToggleDetails}
        onOpenMenu={onOpenMenu}
        onCloseMenu={onCloseMenu}
        onCopy={onCopy}
      />
    ))
  }

  return (
    <div className="rdm-panel">
      <style key="rdm-panel-styles">{PANEL_CSS}</style>

      <header className="rdm-header">
        <div className="rdm-headline">
          <h1 className="rdm-title">{t('panel.title')}</h1>
          <p className="rdm-sub">{t('panel.intro')}</p>
        </div>
        <KernelStatus view={kernel} />
      </header>

      {pollError !== null ? <RouteAlert message={pollError} t={t} retrying={refreshing} onRetry={onRetryRoute} /> : null}

      <form
        className="rdm-composer"
        onSubmit={onSubmit}
        noValidate
        aria-label={t('form.title')}
        aria-busy={!dataReady ? 'true' : undefined}
        data-invalid={formError !== null ? 'true' : undefined}
      >
        <div className="rdm-composer-row">
          <label className="rdm-sr-only" htmlFor="rdm-url">
            {t('form.url')}
          </label>
          <input
            id="rdm-url"
            ref={urlRef}
            className="rdm-url-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('form.urlPlaceholder')}
            value={url}
            disabled={controlsDisabled}
            aria-invalid={formError !== null ? 'true' : undefined}
            aria-describedby={formError !== null ? 'rdm-form-error' : undefined}
            onChange={(event: InputChangeEvent) => {
              setUrl(event.target.value)
              if (formError !== null) setFormError(null)
            }}
          />
          <button
            type="button"
            className="rdm-btn rdm-btn--ghost rdm-options-toggle"
            data-rdm-action="options"
            aria-expanded={optionsOpen}
            aria-controls="rdm-form-options"
            onClick={() => setOptionsOpen((open) => !open)}
            disabled={controlsDisabled}
          >
            {optionsOpen ? t('form.optionsHide') : t('form.options')}
          </button>
          <button
            type="submit"
            className="rdm-btn rdm-btn--primary rdm-start"
            data-rdm-action="start"
            disabled={controlsDisabled}
          >
            {submitting ? t('form.starting') : t('form.start')}
          </button>
        </div>

        {optionsOpen ? (
          <div className="rdm-options" id="rdm-form-options">
            <div className="rdm-field">
              <label className="rdm-field-label" htmlFor="rdm-dir">
                {t('form.directory')}
              </label>
              <input
                id="rdm-dir"
                className="rdm-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('form.directoryPlaceholder')}
                value={dir}
                disabled={controlsDisabled}
                onChange={(event: InputChangeEvent) => setDir(event.target.value)}
              />
            </div>
            <div className="rdm-field">
              <label className="rdm-field-label" htmlFor="rdm-connections">
                {t('form.connections')}
              </label>
              <input
                id="rdm-connections"
                className="rdm-input"
                type="number"
                min={1}
                max={32}
                step={1}
                placeholder={t('form.connectionsPlaceholder')}
                value={connections}
                disabled={controlsDisabled}
                onChange={(event: InputChangeEvent) => setConnections(event.target.value)}
              />
            </div>
          </div>
        ) : null}

        {formError !== null ? (
          <p className="rdm-form-error" id="rdm-form-error" role="alert">
            {formError}
          </p>
        ) : null}
      </form>

      {list !== null || pollError === null ? (
        <section className="rdm-section" aria-labelledby="rdm-board-title">
        <div className="rdm-section-head">
          <h2 className="rdm-section-title" id="rdm-board-title">
            {t('tasks.title')}
            <span className="rdm-count">{countText(tasks.length)}</span>
          </h2>
          <div className="rdm-filters" role="group" aria-label={t('tasks.filterLabel')}>
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                className="rdm-filter"
                data-rdm-filter={item.id}
                aria-pressed={filter === item.id}
                onClick={() => {
                  setMenuTaskId(null)
                  setFilter(item.id)
                }}
              >
                {item.label}
                <span className="rdm-filter-count">{countText(item.count)}</span>
              </button>
            ))}
          </div>
          <div className="rdm-summary">
            {list === null ? (
              <span>{t('common.loading')}</span>
            ) : (
              <span className="rdm-summary-group">
                <span>{summary}</span>
                {runningTasks.length > 0 ? <span className="rdm-summary-speed">{formatSpeed(totalSpeed)}</span> : null}
                {failedCount > 0 ? <span className="rdm-summary-failed">{t('tasks.failedCount', { n: failedCount })}</span> : null}
              </span>
            )}
          </div>
        </div>

        <div className="rdm-board" aria-busy={list === null ? 'true' : undefined}>
          {board}
        </div>
        </section>
      ) : null}

      {toast !== null ? (
        <div className="rdm-toast" role="status" aria-live="polite" data-rdm-toast>
          {toast}
        </div>
      ) : null}
    </div>
  )
}
