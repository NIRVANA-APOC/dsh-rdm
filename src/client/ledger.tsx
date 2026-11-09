// The global download workbench — the left-sidebar `main` slot, key `rdm`.
//
// Order (0.3.0): title + kernel health, the paste-a-link composer, the three
// state cards (which double as filters), the risk queue, the filter/selection
// toolbar, then the ledger grouped workspace → session title.
//
// The same `RecordRow` primitive is reused by the session right-sidebar tab;
// `variant` only changes the progress device (byte meter vs micro strip) and
// whether the selection checkbox exists.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { controlTasks, errorText, openTask, startTask } from './api'
import { copyText } from './clipboard'
import { useGlobalLedger, refreshGlobalLedger, useTaskDetail, type RateHistory } from './data'
import {
  formatPercent,
  formatSpeed,
  progressFraction,
  shortPath,
  shortTaskId,
} from './format'
import {
  AlertGlyph,
  CheckGlyph,
  CloseGlyph,
  CopyGlyph,
  DownloadGlyph,
  FileGlyph,
  FolderGlyph,
  LinkGlyph,
  PauseGlyph,
  PlayGlyph,
  SearchGlyph,
  TrashGlyph,
} from './icons'
import {
  EMPTY_FILTER,
  byteMeterLabel,
  canPause,
  canResume,
  cardCounts,
  chipsFor,
  connectionInfoOf,
  currentConnections,
  elapsedOf,
  etaOf,
  extensionOptions,
  fileNameOf,
  filterActive,
  filterTasks,
  groupByWorkspace,
  hostOf,
  isMoving,
  riskNotes,
  sealFor,
  sessionFallbackId,
  statusLabel,
  taskPath,
  toneOf,
  type ConnectionInfo,
  type FilterState,
  type StatusBucket,
} from './model'
import {
  ByteMeter,
  Checkbox,
  ChipRow,
  ConfidenceMark,
  ConnectionBadge,
  Disclosure,
  EmptyState,
  IconButton,
  KernelDot,
  LiveRegion,
  ReviewStyle,
  Seal,
  SkeletonRows,
  StatusGlyph,
  TextButton,
} from './primitives'
import { Waveform } from './wave'
import { EvidenceDrawer } from './drawer'
import type { TFunction, TaskView } from './types'

/** Percent copy; null stays absent rather than inventing a number. */
function percentText(task: TaskView): string {
  return formatPercent(task.percent)
}

/** Human connection summary for the badge tooltip. */
function connectionsTitle(t: TFunction, task: TaskView, info: ConnectionInfo): string {
  const value = (number: number | null): string => (number === null ? '—' : String(number))
  return t('record.connectionsTitle', {
    current: value(info.current),
    target: value(info.target),
    requested: value(info.requested),
    max: value(info.max),
  })
}

/** Rate, when the record is moving and the kernel sampled it. */
function RateGroup({ task }: { task: TaskView }) {
  if (!isMoving(task)) return null
  if (task.speedBps <= 0) return null
  return <span className="rdm2-meta-item rdm2-meta-rate">{formatSpeed(task.speedBps)}</span>
}

/** ETA + confidence marker, when the kernel produced one. */
function EtaGroup({ t, task }: { t: TFunction; task: TaskView }) {
  const eta = etaOf(t, task)
  if (eta === null) return null
  return (
    <span className="rdm2-meta-item">
      <span className="rdm2-meta-label">{t('record.etaLabel')}</span>
      {eta.value}
      <ConfidenceMark bars={eta.bars} label={t('record.etaConfidence', { level: eta.confidence })} />
    </span>
  )
}

export interface RecordRowProps {
  t: TFunction
  task: TaskView
  variant: 'page' | 'session'
  history: RateHistory
  expanded: boolean
  onToggle: (id: string) => void
  /** Page selection (absent on the session surface). */
  selected?: boolean
  onSelect?: (id: string, next: boolean) => void
  onPause?: (task: TaskView) => void
  onResume?: (task: TaskView) => void
  onDelete?: (task: TaskView) => void
  onOpen?: (task: TaskView, target: 'file' | 'folder') => void
  onCopyId?: (task: TaskView) => void
  /** Session surface: reveal in the host file viewer. */
  onReveal?: (path: string) => void
  /** Drawer id shared with `aria-controls`. */
  domId: string
}

/** One record in the ledger. The name line is the keyboard toggle. */
export function RecordRow(props: RecordRowProps) {
  const { t, task, variant, history, expanded } = props
  const [reloadToken, setReloadToken] = useState(0)
  const detail = useTaskDetail(task, expanded, reloadToken)
  const tone = toneOf(task)
  const label = statusLabel(t, task.status)
  const seal = sealFor(t, task)
  const chips = chipsFor(t, task)
  const moving = isMoving(task)
  const samples = variant === 'session' ? (history.tasks.get(task.id) ?? []) : []
  const elapsed = elapsedOf(task)
  const host = hostOf(task)
  const folderPath = taskPath(task)
  const filePath = task.path ?? ''
  const info = connectionInfoOf(task)
  const current = currentConnections(task)
  const hasSelection = variant === 'page' && props.onSelect !== undefined
  const finished = task.status === 'completed' || task.status === 'cancelled'
  const terminal = finished || task.status === 'failed'
  // A terminal record does not need the "ranges/resume" reassurance on every
  // row; the drawer still carries it. Only a real warning survives.
  const visibleChips = terminal ? chips.filter((chip) => chip.tone !== 'quiet') : chips

  const toggle = (event?: { stopPropagation(): void }): void => {
    event?.stopPropagation()
    props.onToggle(task.id)
  }

  return (
    <div
      className="rdm2-record"
      data-status={task.status}
      data-rdm2-row={task.id}
      data-tone={tone}
      data-selected={props.selected === true ? 'true' : 'false'}
    >
      <div className="rdm2-record-row">
        {hasSelection ? (
          <Checkbox
            checked={props.selected === true}
            label={t('record.select', { name: fileNameOf(task) })}
            onChange={(next) => props.onSelect?.(task.id, next)}
            className="rdm2-record-check"
          />
        ) : null}
        <div className="rdm2-record-body" onClick={() => props.onToggle(task.id)}>
          <div className="rdm2-record-name-line">
            <StatusGlyph status={task.status} tone={tone} label={label} />
            <button
              type="button"
              className="rdm2-record-name"
              title={fileNameOf(task)}
              aria-expanded={expanded}
              aria-controls={expanded ? props.domId : undefined}
              onClick={toggle}
            >
              {fileNameOf(task)}
            </button>
            {seal !== null ? <Seal seal={seal} /> : null}
            <span className="rdm2-record-spacer" />
            <span className="rdm2-record-percent">{percentText(task)}</span>
          </div>

          <div className="rdm2-record-meta">
            <span className="rdm2-meta-item rdm2-status-word">{label}</span>
            {task.error !== null ? <span className="rdm2-meta-item rdm2-record-error">{errorText(t, task.error)}</span> : null}
            <RateGroup task={task} />
            <EtaGroup t={t} task={task} />
            {current !== null ? (
              <span className="rdm2-meta-item">
                <ConnectionBadge
                  label={t('record.connections', { n: String(current) })}
                  title={connectionsTitle(t, task, info)}
                />
              </span>
            ) : null}
            {variant === 'page' ? <span className="rdm2-meta-item rdm2-record-size">{byteMeterLabel(t, task)}</span> : null}
            {host !== '' ? <span className="rdm2-meta-item rdm2-record-host">{host}</span> : null}
            <span className="rdm2-record-spacer" />
            {elapsed !== null ? <span className="rdm2-meta-item rdm2-record-elapsed">{elapsed}</span> : null}
            <button
              type="button"
              className="rdm2-id-chip"
              title={t('record.copyIdHint', { id: task.id })}
              aria-label={t('record.copyIdHint', { id: task.id })}
              onClick={(event) => {
                event.stopPropagation()
                props.onCopyId?.(task)
              }}
            >
              <code>{shortTaskId(task.id)}</code>
              <CopyGlyph size={11} />
            </button>
          </div>

          {variant === 'page' ? (
            finished ? null : <ByteMeter fraction={progressFraction(task.downloaded, task.total)} tone={tone} />
          ) : finished ? null : (
            <Waveform
              values={samples}
              capacity={40}
              height={26}
              mini
              live={moving && task.speedBps > 0}
              ariaLabel={t('record.pulse', { name: fileNameOf(task) })}
            />
          )}

          <ChipRow chips={visibleChips} max={variant === 'session' ? 3 : 4} />
        </div>

        <div className="rdm2-record-actions">
          {canPause(task) && props.onPause !== undefined ? (
            <IconButton label={t('record.pause')} onClick={() => props.onPause?.(task)}>
              <PauseGlyph size={15} />
            </IconButton>
          ) : null}
          {canResume(task) && props.onResume !== undefined ? (
            <IconButton label={t('record.resume')} onClick={() => props.onResume?.(task)}>
              <PlayGlyph size={15} />
            </IconButton>
          ) : null}
          <IconButton
            label={t('record.openFile')}
            disabled={filePath === '' || props.onOpen === undefined}
            onClick={() => props.onOpen?.(task, 'file')}
          >
            <FileGlyph size={15} />
          </IconButton>
          <IconButton
            label={t('record.openFolder')}
            disabled={folderPath === '' || props.onOpen === undefined}
            onClick={() => props.onOpen?.(task, 'folder')}
          >
            <FolderGlyph size={15} />
          </IconButton>
          <IconButton
            label={t('record.delete')}
            tone="danger"
            disabled={props.onDelete === undefined}
            onClick={() => props.onDelete?.(task)}
          >
            <TrashGlyph size={15} />
          </IconButton>
        </div>
      </div>
      {expanded ? (
        <EvidenceDrawer
          t={t}
          task={task}
          detail={detail}
          onRetry={() => setReloadToken((value) => value + 1)}
          onReveal={folderPath !== '' ? props.onReveal : undefined}
          id={props.domId}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ header */

/** Kernel health: words plus one dot, as asked. Nothing else. */
function KernelHealth({ t, state }: { t: TFunction; state: ReturnType<typeof useGlobalLedger> }) {
  if (state.phase === 'loading') {
    return (
      <span className="rdm2-kernel" data-ok="loading" title={t('kernel.checking')}>
        {t('kernel.checking')}
        <KernelDot tone="idle" label={t('kernel.checking')} />
      </span>
    )
  }
  const ok = state.kernel.running && state.kernel.error === null
  const detail = state.kernel.starting
    ? t('kernel.starting')
    : state.kernel.error !== null
      ? state.kernel.error
      : ok
        ? t('kernel.running')
        : t('kernel.stopped')
  return (
    <span className="rdm2-kernel" title={detail} data-ok={ok ? 'true' : 'false'}>
      {ok ? t('kernel.ok') : t('kernel.bad')}
      <KernelDot tone={ok ? 'ok' : 'bad'} label={detail} />
    </span>
  )
}

/* ---------------------------------------------------------------- composer */

interface ComposerProps {
  t: TFunction
  onStarted: (task: TaskView) => void
}

/** Paste a link and start a download without leaving the review page. */
function Composer({ t, onStarted }: ComposerProps) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event?: { preventDefault(): void }): Promise<void> => {
    event?.preventDefault()
    if (busy) return
    const trimmed = url.trim()
    if (trimmed === '') return
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      setError(t('composer.invalid'))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError(t('composer.invalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const task = await startTask(trimmed)
      setUrl('')
      onStarted(task)
      refreshGlobalLedger()
    } catch (failure) {
      setError(errorText(t, failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="rdm2-composer" onSubmit={(event) => void submit(event)}>
      <div className="rdm2-composer-field" data-invalid={error !== null ? 'true' : 'false'}>
        <LinkGlyph size={15} />
        <input
          type="url"
          className="rdm2-composer-input"
          value={url}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.placeholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setUrl(event.target.value)
            if (error !== null) setError(null)
          }}
        />
        <button type="submit" className="rdm2-composer-submit" disabled={busy || url.trim() === ''}>
          <DownloadGlyph size={14} />
          {busy ? t('composer.starting') : t('composer.submit')}
        </button>
      </div>
      {error !== null ? <p className="rdm2-composer-error" role="alert">{error}</p> : null}
    </form>
  )
}

/* ------------------------------------------------------------- stat cards */

interface StatCardProps {
  t: TFunction
  bucket: Exclude<StatusBucket, 'all'>
  value: number
  label: string
  hint: string
  active: boolean
  onToggle: () => void
}

function StatCard({ bucket, value, label, hint, active, onToggle, t }: StatCardProps) {
  const icon =
    bucket === 'active' ? <DownloadGlyph size={16} /> : bucket === 'done' ? <CheckGlyph size={16} /> : <AlertGlyph size={16} />
  return (
    <button
      type="button"
      className="rdm2-stat"
      data-tone={bucket}
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      aria-label={t('cards.filterAria', { label, count: value })}
      onClick={onToggle}
    >
      <span className="rdm2-stat-top">
        <span className="rdm2-stat-label">{label}</span>
        <span className="rdm2-stat-icon" aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className="rdm2-stat-value">{value}</span>
      <span className="rdm2-stat-hint">{hint}</span>
    </button>
  )
}

function StatCards({
  t,
  tasks,
  filter,
  onToggle,
}: {
  t: TFunction
  tasks: TaskView[]
  filter: FilterState
  onToggle: (bucket: Exclude<StatusBucket, 'all'>) => void
}) {
  const counts = cardCounts(tasks)
  return (
    <section className="rdm2-cards" aria-label={t('cards.regionLabel')}>
      <StatCard
        t={t}
        bucket="active"
        value={counts.active}
        label={t('cards.active')}
        hint={counts.active > 0 ? t('cards.activeHint', { n: counts.active }) : t('cards.activeIdle')}
        active={filter.bucket === 'active'}
        onToggle={() => onToggle('active')}
      />
      <StatCard
        t={t}
        bucket="done"
        value={counts.done}
        label={t('cards.done')}
        hint={t('cards.doneHint')}
        active={filter.bucket === 'done'}
        onToggle={() => onToggle('done')}
      />
      <StatCard
        t={t}
        bucket="failed"
        value={counts.failed}
        label={t('cards.failed')}
        hint={counts.failed > 0 ? t('cards.failedHint', { n: counts.failed }) : t('cards.failedNone')}
        active={filter.bucket === 'failed'}
        onToggle={() => onToggle('failed')}
      />
    </section>
  )
}

/* ------------------------------------------------------------------ filters */

interface ExtensionMenuProps {
  t: TFunction
  options: ReturnType<typeof extensionOptions>
  selected: string[]
  onChange: (next: string[]) => void
}

/** Multi-select suffix dropdown; composes with the text filter. */
function ExtensionMenu({ t, options, selected, onChange }: ExtensionMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (extension: string): void => {
    onChange(selected.includes(extension) ? selected.filter((item) => item !== extension) : [...selected, extension])
  }

  return (
    <div className="rdm2-ext" ref={rootRef}>
      <button
        type="button"
        className="rdm2-ext-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t('filters.extensions')}
        {selected.length > 0 ? <span className="rdm2-ext-count">{selected.length}</span> : null}
        <Disclosure open={open} />
      </button>
      {open ? (
        <div className="rdm2-ext-menu" role="group" aria-label={t('filters.extensions')}>
          {options.length === 0 ? (
            <p className="rdm2-ext-empty">{t('filters.noExtensions')}</p>
          ) : (
            options.map((option) => (
              <button
                type="button"
                key={option.extension}
                className="rdm2-ext-row"
                role="checkbox"
                aria-checked={selected.includes(option.extension)}
                data-checked={selected.includes(option.extension) ? 'true' : 'false'}
                onClick={() => toggle(option.extension)}
              >
                <span className="rdm2-ext-tick" aria-hidden="true">
                  {selected.includes(option.extension) ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.6 5.2 3.8 7.4 8.4 2.6" />
                    </svg>
                  ) : null}
                </span>
                <span className="rdm2-ext-name">.{option.extension}</span>
                <span className="rdm2-ext-meta">{option.count}</span>
              </button>
            ))
          )}
          <div className="rdm2-ext-footer">
            <TextButton
              label={t('filters.clear')}
              disabled={selected.length === 0}
              onClick={() => onChange([])}
            >
              {t('filters.clear')}
            </TextButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- page */

interface PendingDelete {
  ids: string[]
  name: string | null
}

export interface ReviewPageProps {
  t: TFunction
}

/** The global workbench (left sidebar entry). */
export function ReviewPage(props: ReviewPageProps) {
  const { t } = props
  const state = useGlobalLedger()
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const say = (message: string): void => {
    setFeedback(message)
    if (feedbackTimer.current !== undefined) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => setFeedback(''), 4500)
  }

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== undefined) clearTimeout(feedbackTimer.current)
    }
  }, [])

  // A record that disappeared (removed elsewhere, or the kernel restarted)
  // must not stay selected; bulk actions would silently address nothing.
  useEffect(() => {
    setSelected((previous) => {
      if (previous.size === 0) return previous
      const ids = new Set(state.tasks.map((task) => task.id))
      let changed = false
      const next = new Set<string>()
      for (const id of previous) {
        if (ids.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : previous
    })
  }, [state.tasks])

  const filtered = useMemo(
    () => filterTasks(state.tasks, filter, state.sessions, state.workspaces),
    [state.tasks, state.sessions, state.workspaces, filter],
  )
  const groups = useMemo(
    () => groupByWorkspace(filtered, state.sessions, state.workspaces),
    [filtered, state.sessions, state.workspaces],
  )
  const extensions = useMemo(() => extensionOptions(state.tasks), [state.tasks])
  const tasksById = useMemo(() => new Map(state.tasks.map((task) => [task.id, task])), [state.tasks])
  const visibleIds = useMemo(() => filtered.map((task) => task.id), [filtered])
  const selectedVisible = visibleIds.filter((id) => selected.has(id))
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length
  const someVisibleSelected = selectedVisible.length > 0 && !allVisibleSelected
  const pauseable = [...selected].filter((id) => {
    const task = tasksById.get(id)
    return task !== undefined && canPause(task)
  })
  const loading = state.phase === 'loading'
  const unavailable = state.phase === 'error' && state.error !== null

  const toggle = (id: string): void => {
    setExpandedId((previous) => (previous === id ? null : id))
  }

  const onSelect = (id: string, next: boolean): void => {
    setSelected((previous) => {
      const copy = new Set(previous)
      if (next) copy.add(id)
      else copy.delete(id)
      return copy
    })
  }

  const toggleAll = (): void => {
    setSelected((previous) => {
      const copy = new Set(previous)
      if (allVisibleSelected) {
        for (const id of visibleIds) copy.delete(id)
      } else {
        for (const id of visibleIds) copy.add(id)
      }
      return copy
    })
  }

  const toggleBucket = (bucket: Exclude<StatusBucket, 'all'>): void => {
    setFilter((previous) => ({ ...previous, bucket: previous.bucket === bucket ? 'all' : bucket }))
  }

  /** Run one control verb over ids, collecting per-id failures and notices. */
  const performControl = async (ids: string[], action: 'pause' | 'resume' | 'remove'): Promise<void> => {
    if (ids.length === 0 || busy) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await controlTasks(ids, action, { notify: action !== 'resume' })
      const failures = result.results.filter((outcome) => !outcome.ok)
      const notified = result.results.some((outcome) => outcome.notified)
      const nameOf = (id: string): string => {
        const task = tasksById.get(id)
        return task === undefined ? id : fileNameOf(task)
      }
      const name = ids.length === 1 ? nameOf(ids[0]!) : null
      const base =
        action === 'pause'
          ? name !== null
            ? t('record.pausedOne', { name })
            : t('record.pausedMany', { n: ids.length })
          : action === 'resume'
            ? name !== null
              ? t('record.resumedOne', { name })
              : t('record.resumedMany', { n: ids.length })
            : name !== null
              ? t('record.deletedOne', { name })
              : t('record.deletedMany', { n: ids.length })
      say(failures.length === 0 && notified ? `${base} ${t('record.agentNotified')}` : base)
      if (failures.length > 0) {
        const first = failures[0]!
        setActionError(t('record.partialFailure', { n: failures.length, message: errorText(t, first.error) }))
      }
      if (action === 'remove') {
        setSelected((previous) => {
          const copy = new Set(previous)
          for (const id of ids) copy.delete(id)
          return copy
        })
      }
      refreshGlobalLedger()
    } catch (error) {
      setActionError(errorText(t, error))
    } finally {
      setBusy(false)
    }
  }

  const pauseSelected = (): void => {
    void performControl(pauseable, 'pause')
  }

  const requestDelete = (task: TaskView): void => {
    setPendingDelete({ ids: [task.id], name: fileNameOf(task) })
  }

  const requestDeleteSelected = (): void => {
    if (selected.size === 0) return
    const ids = [...selected]
    const task = ids.length === 1 ? tasksById.get(ids[0]!) : undefined
    setPendingDelete({ ids, name: task === undefined ? null : fileNameOf(task) })
  }

  const confirmDelete = async (): Promise<void> => {
    const pending = pendingDelete
    if (pending === null) return
    setPendingDelete(null)
    await performControl(pending.ids, 'remove')
  }

  const handleOpen = async (task: TaskView, target: 'file' | 'folder'): Promise<void> => {
    setActionError(null)
    try {
      const result = await openTask(task.id, target)
      if (!result.opened) {
        setActionError(result.error === null ? t('error.code.open_failed') : errorText(t, result.error))
        return
      }
      say(target === 'file' ? t('record.openedFile', { name: fileNameOf(task) }) : t('record.openedFolder'))
    } catch (error) {
      setActionError(errorText(t, error))
    }
  }

  const handleCopyId = async (task: TaskView): Promise<void> => {
    const ok = await copyText(task.id)
    say(ok ? t('record.idCopied') : t('common.copyFailed'))
  }

  const onStarted = (task: TaskView): void => {
    say(t('composer.started', { name: fileNameOf(task) }))
    setExpandedId(task.id)
  }

  const clearFilters = (): void => setFilter(EMPTY_FILTER)

  return (
    <div className="rdm2 rdm2-page" data-surface="global" data-rdm2-state={state.phase}>
      <ReviewStyle />
      <div className="rdm2-page-inner">
        <header className="rdm2-page-header">
          <h1 className="rdm2-title">{t('page.title')}</h1>
          <KernelHealth t={t} state={state} />
        </header>
        <Composer t={t} onStarted={onStarted} />

        <StatCards t={t} tasks={state.tasks} filter={filter} onToggle={toggleBucket} />

        <RiskLine t={t} tasks={state.tasks} />

        {unavailable ? <Banner title={errorText(t, state.error)} hint={t('route.hint')} /> : null}
        {state.banner !== null && state.phase === 'ready' ? <Banner title={errorText(t, state.banner)} hint={t('route.hint')} /> : null}
        {actionError !== null ? (
          <Banner title={actionError} onDismiss={() => setActionError(null)} dismissLabel={t('common.dismiss')} />
        ) : null}

        <div className="rdm2-toolbar">
          <div className="rdm2-toolbar-start">
            <span className="rdm2-select-all">
              <Checkbox
                checked={allVisibleSelected}
                mixed={someVisibleSelected}
                disabled={visibleIds.length === 0}
                label={t('toolbar.selectAll')}
                onChange={() => toggleAll()}
                className="rdm2-select-all-box"
              />
              <button
                type="button"
                className="rdm2-select-all-label"
                onClick={toggleAll}
                disabled={visibleIds.length === 0}
              >
                {allVisibleSelected ? t('toolbar.selectAllOn') : t('toolbar.selectAll')}
              </button>
            </span>
            {selected.size > 0 ? (
              <>
                <span className="rdm2-selected-count">{t('toolbar.selected', { n: selected.size })}</span>
                <TextButton
                  label={t('toolbar.pause')}
                  disabled={busy || pauseable.length === 0}
                  onClick={pauseSelected}
                >
                  <PauseGlyph size={13} />
                  {t('toolbar.pause')}
                </TextButton>
                <TextButton
                  label={t('toolbar.delete')}
                  tone="danger"
                  disabled={busy || selected.size === 0}
                  onClick={requestDeleteSelected}
                >
                  <TrashGlyph size={13} />
                  {t('toolbar.delete')}
                </TextButton>
                <TextButton label={t('toolbar.clearSelection')} onClick={() => setSelected(new Set())}>
                  {t('toolbar.clearSelection')}
                </TextButton>
              </>
            ) : (
              <span className="rdm2-result-count">
                {filterActive(filter) ? t('filters.showing', { n: filtered.length, total: state.tasks.length }) : t('filters.total', { n: state.tasks.length })}
              </span>
            )}
          </div>
          <div className="rdm2-toolbar-end">
            <label className="rdm2-search">
              <SearchGlyph size={14} />
              <input
                type="search"
                value={filter.query}
                placeholder={t('filters.searchPlaceholder')}
                aria-label={t('filters.searchPlaceholder')}
                onChange={(event) => setFilter((previous) => ({ ...previous, query: event.target.value }))}
              />
              {filter.query !== '' ? (
                <button
                  type="button"
                  className="rdm2-search-clear"
                  aria-label={t('filters.clearSearch')}
                  onClick={() => setFilter((previous) => ({ ...previous, query: '' }))}
                >
                  <CloseGlyph size={12} />
                </button>
              ) : null}
            </label>
            <ExtensionMenu
              t={t}
              options={extensions}
              selected={filter.extensions}
              onChange={(next) => setFilter((previous) => ({ ...previous, extensions: next }))}
            />
          </div>
        </div>

        {pendingDelete !== null ? (
          <div className="rdm2-confirm" role="alertdialog" aria-label={t('record.deleteConfirmTitle')}>
            <div className="rdm2-confirm-copy">
              <span className="rdm2-confirm-title">
                {pendingDelete.name !== null
                  ? t('record.deleteConfirmOne', { name: pendingDelete.name })
                  : t('record.deleteConfirmMany', { n: pendingDelete.ids.length })}
              </span>
              <span className="rdm2-confirm-hint">{t('record.deleteConfirmHint')}</span>
            </div>
            <div className="rdm2-confirm-actions">
              <TextButton label={t('common.cancel')} onClick={() => setPendingDelete(null)}>
                {t('common.cancel')}
              </TextButton>
              <TextButton label={t('common.delete')} tone="danger" onClick={() => void confirmDelete()}>
                {t('common.delete')}
              </TextButton>
            </div>
          </div>
        ) : null}

        {feedback !== '' ? <div className="rdm2-feedback">{feedback}</div> : null}

        <section className="rdm2-ledger-section" aria-label={t('page.title')}>
          {loading ? (
            <SkeletonRows rows={3} />
          ) : state.tasks.length === 0 ? (
            <EmptyState icon={<DownloadGlyph size={22} />} title={t('empty.global')} hint={t('empty.globalHint')} />
          ) : filtered.length === 0 ? (
            <>
              <EmptyState
                icon={<SearchGlyph size={22} />}
                title={t('empty.filtered')}
                hint={t('empty.filteredHint')}
              />
              <div className="rdm2-empty-action">
                <TextButton label={t('filters.clear')} onClick={clearFilters}>
                  {t('filters.clear')}
                </TextButton>
              </div>
            </>
          ) : (
            <div className="rdm2-ledger">
              {filterActive(filter) ? (
                <button type="button" className="rdm2-filter-chip" onClick={clearFilters}>
                  {t('filters.clear')}
                  <CloseGlyph size={11} />
                </button>
              ) : null}
              {groups.map((workspace: ReturnType<typeof groupByWorkspace>[number]) => (
                <section
                  className="rdm2-workspace"
                  key={workspace.workspaceId ?? 'unattributed'}
                  data-workspace={workspace.workspaceId ?? ''}
                >
                  <WorkspaceHeader t={t} workspace={workspace} />
                  {workspace.sessions.map((session) => (
                    <div className="rdm2-session-group" key={session.sessionId ?? 'unattributed'}>
                      <div className="rdm2-session-head">
                        <span className="rdm2-session-title">
                          {session.title !== null && session.title.trim() !== ''
                            ? session.title
                            : session.sessionId === null
                              ? t('group.unattributedSession')
                              : t('group.sessionFallback', { id: sessionFallbackId(session.sessionId) })}
                          {session.sessionId !== null && state.sessions[session.sessionId]?.live === true ? (
                            <span className="rdm2-session-live">{t('group.live')}</span>
                          ) : null}
                        </span>
                        <span className="rdm2-session-meta">
                          {t('group.records', { n: session.tasks.length })}
                          {session.active > 0 ? ` · ${t('group.active', { n: session.active })}` : ''}
                        </span>
                      </div>
                      <div className="rdm2-record-list">
                        {session.tasks.map((task) => (
                          <RecordRow
                            key={task.id}
                            t={t}
                            task={task}
                            variant="page"
                            history={state.history}
                            selected={selected.has(task.id)}
                            onSelect={onSelect}
                            expanded={expandedId === task.id}
                            onToggle={toggle}
                            onPause={(target) => void performControl([target.id], 'pause')}
                            onResume={(target) => void performControl([target.id], 'resume')}
                            onDelete={requestDelete}
                            onOpen={(target, kind) => void handleOpen(target, kind)}
                            onCopyId={(target) => void handleCopyId(target)}
                            domId={`rdm2-drawer-${task.id}`}
                          />
                        ))}
                      </div>                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
      <LiveRegion message={feedback} />
    </div>
  )
}

/* ------------------------------------------------------------- subviews */

/** Workspace heading: title, path, record count. */
function WorkspaceHeader({ t, workspace }: { t: TFunction; workspace: ReturnType<typeof groupByWorkspace>[number] }) {
  return (
    <div className="rdm2-ws-head">
      <span className="rdm2-ws-title">
        {workspace.title !== null && workspace.title.trim() !== '' ? workspace.title : t('group.unattributed')}
      </span>
      {workspace.path !== null ? <span className="rdm2-ws-path" title={workspace.path}>{shortPath(workspace.path)}</span> : null}
      <span className="rdm2-ws-meta">
        {t('group.records', { n: workspace.tasks.length })}
        {workspace.active > 0 ? ` · ${t('group.active', { n: workspace.active })}` : ''}
      </span>
    </div>
  )
}

/**
 * The review queue above the ledger: one calm row per record that needs a
 * human, errors first, capped at three with a "+N more" line.
 */
function RiskLine({ t, tasks }: { t: TFunction; tasks: TaskView[] }) {
  const notes = riskNotes(t, tasks)
  const [expanded, setExpanded] = useState(false)
  if (notes.length === 0) return null
  const visible = notes.slice(0, 3)
  const hidden = notes.length - visible.length
  return (
    <div className="rdm2-risk" data-expanded={expanded ? 'true' : 'false'} role="group" aria-label={t('risk.regionLabel')}>
      <button
        type="button"
        className="rdm2-risk-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="rdm2-risk-summary-dot" aria-hidden="true">
          {notes.some((note) => note.severity === 'error') ? '!' : '•'}
        </span>
        {t('risk.summary', { n: notes.length })}
      </button>
      <div className="rdm2-risk-rows">
        {visible.map((note) => (
          <div className="rdm2-risk-row" data-severity={note.severity} key={note.key}>
            <StatusGlyph
              status={note.severity === 'error' ? 'failed' : 'paused'}
              tone={note.severity === 'error' ? 'failed' : 'paused'}
              label={note.severity === 'error' ? t('risk.errorLabel') : t('risk.warnLabel')}
            />
            <span className="rdm2-risk-name" title={note.name}>
              {note.name}
            </span>
            <span className="rdm2-risk-cause">{note.cause}</span>
          </div>
        ))}
        {hidden > 0 ? <span className="rdm2-risk-more">{t('risk.more', { n: hidden })}</span> : null}
      </div>
    </div>
  )
}

/** Inline route/action banner; polling keeps retrying, so no retry button. */
function Banner({ title, hint, onDismiss, dismissLabel }: { title: string; hint?: string; onDismiss?: () => void; dismissLabel?: string }) {
  return (
    <div className="rdm2-banner" role="alert">
      <div className="rdm2-banner-copy">
        <span className="rdm2-banner-title">{title}</span>
        {hint !== undefined ? <span className="rdm2-banner-hint">{hint}</span> : null}
      </div>
      {onDismiss !== undefined ? (
        <IconButton label={dismissLabel ?? 'Dismiss'} onClick={onDismiss}>
          <CloseGlyph size={12} />
        </IconButton>
      ) : null}
    </div>
  )
}

// Keep the helpers referenced by the page's JSX explicit for TypeScript.

