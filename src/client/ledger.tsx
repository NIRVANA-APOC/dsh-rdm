// The global review page — the left-sidebar `main` slot, key `rdm`.
//
// Layout follows docs/design/0.2.0-agent-native.md §6.2: a quiet ledger header
// (engine line, counts, aggregate rates), the recorder strip (the only live
// motion), then the session-grouped ledger. A record expands into the shared
// evidence drawer. There is no composer, no start form and no connection
// control anywhere on this page.
//
// The same `RecordRow` primitive is reused by the session right-sidebar tab;
// `variant` only changes the progress device (byte meter vs micro-strip).

import React, { useMemo, useState } from 'react'
import { controlTask, errorText } from './api'
import { PAGE_SAMPLES, useLedger, useTaskDetail, type HistorySeed, type LedgerHistory } from './data'
import { formatHourMinute, formatSpeed, progressFraction, shortSessionId } from './format'
import {
  byteMeterLabel,
  chipsFor,
  elapsedOf,
  etaOf,
  fileNameOf,
  groupBySession,
  hostOf,
  isMoving,
  riskNotes,
  sealFor,
  statusLabel,
  toneOf,
} from './model'
import { ByteMeter, ChipRow, ConfidenceMark, LiveRegion, Note, ReviewStyle, Seal, SkeletonRows, StatusGlyph } from './primitives'
import { Waveform } from './wave'
import { EvidenceDrawer } from './drawer'
import type { TFunction, TaskView } from './types'

/** Percent copy; null stays absent rather than inventing a number. */
function percentText(task: TaskView): string {
  return task.percent === null ? '' : `${Math.round(task.percent)}%`
}

/** Rate + 5s window, when the record is moving and the kernel sampled it. */
function RateGroup({ t, task }: { t: TFunction; task: TaskView }) {
  if (!isMoving(task)) return null
  const hasNow = task.speedBps > 0
  const hasWindow = task.speed5sBps !== null && task.speed5sBps > 0
  if (!hasNow && !hasWindow) return null
  return (
    <>
      {hasNow ? <span className="rdm2-meta-item rdm2-meta-rate">{formatSpeed(task.speedBps)}</span> : null}
      {hasWindow ? (
        <span className="rdm2-meta-item">
          <span className="rdm2-meta-label">5s</span>
          {formatSpeed(task.speed5sBps)}
        </span>
      ) : null}
    </>
  )
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
  history: LedgerHistory
  expanded: boolean
  onToggle: (id: string) => void
  onReveal?: (path: string) => void
  onStop: (task: TaskView) => void
  /** Drawer id shared with `aria-controls`. */
  domId: string
}

/** One evidence record in the ledger. The whole header is the toggle. */
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
  const path = task.path ?? ''

  return (
    <div className="rdm2-record" data-status={task.status} data-rdm2-row={task.id} data-tone={tone}>
      <div
        className="rdm2-record-main"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={expanded ? props.domId : undefined}
        aria-label={t('record.toggle', { name: fileNameOf(task), status: label })}
        onClick={() => props.onToggle(task.id)}
        onKeyDown={(event: { key: string; preventDefault(): void }) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onToggle(task.id)
          }
        }}
      >
        <span className="rdm2-record-head">
          <StatusGlyph status={task.status} tone={tone} label={label} />
          <span className="rdm2-record-name" title={fileNameOf(task)}>
            {fileNameOf(task)}
          </span>
          {seal !== null ? <Seal seal={seal} /> : null}
          <span className="rdm2-record-percent">{percentText(task)}</span>
        </span>

        {variant === 'page' ? (
          <ByteMeter fraction={progressFraction(task.downloaded, task.total)} tone={tone} />
        ) : (
          <Waveform
            values={samples}
            capacity={40}
            height={26}
            mini
            live={moving && task.speedBps > 0}
            ariaLabel={t('record.pulse', { name: fileNameOf(task) })}
          />
        )}

        <span className="rdm2-record-meta">
          <span className="rdm2-meta-item rdm2-status-word">{label}</span>
          {task.error !== null ? <span className="rdm2-meta-item rdm2-record-error">{errorText(t, task.error)}</span> : null}
          <RateGroup t={t} task={task} />
          <EtaGroup t={t} task={task} />
          {variant === 'page' ? <span className="rdm2-meta-item rdm2-record-size">{byteMeterLabel(t, task)}</span> : null}
          {host !== '' ? <span className="rdm2-meta-item rdm2-record-host">{host}</span> : null}
          <span className="rdm2-record-spacer" />
          {elapsed !== null ? <span className="rdm2-meta-item rdm2-record-elapsed">{elapsed}</span> : null}
        </span>

        <ChipRow chips={chips} max={variant === 'session' ? 3 : 4} />
      </div>
      {expanded ? (
        <EvidenceDrawer
          t={t}
          task={task}
          detail={detail}
          onRetry={() => setReloadToken((value) => value + 1)}
          onReveal={path !== '' ? props.onReveal : undefined}
          onStop={props.onStop}
          id={props.domId}
        />
      ) : null}
    </div>
  )
}

/** Engine status line: one sentence, no chrome, no chip. */
function EngineLine({ t, kernel }: { t: TFunction; kernel: ReturnType<typeof useLedger>['kernel'] }) {
  let primary: string
  if (kernel.running) primary = t('kernel.running')
  else if (kernel.starting) primary = t('kernel.starting')
  else if (kernel.error !== null) primary = t('kernel.error')
  else primary = t('kernel.stopped')
  const parts: string[] = [primary]
  if (kernel.version !== null && kernel.version !== '') parts.push(`v${kernel.version}`)
  if (kernel.pid !== null) parts.push(t('page.pid', { pid: kernel.pid }))
  if (kernel.dataDir !== null && kernel.dataDir !== '') parts.push(kernel.dataDir)
  return <p className="rdm2-engine">{parts.join('   ')}</p>
}

/** Counts + aggregate rate line under the title. */
function StatsLine({ t, state }: { t: TFunction; state: ReturnType<typeof useLedger> }) {
  const { aggregate } = state
  const counts = [
    t('counts.active', { n: aggregate.active }),
    t('counts.done', { n: aggregate.completed }),
    t('counts.failed', { n: aggregate.failed }),
  ]
  if (aggregate.paused > 0) counts.push(t('counts.paused', { n: aggregate.paused }))
  const rates: string[] = []
  if (aggregate.nowBps > 0) rates.push(`${t('rates.now')} ${formatSpeed(aggregate.nowBps)}`)
  if (aggregate.w5Bps !== null && aggregate.w5Bps > 0) rates.push(`${t('rates.w5')} ${formatSpeed(aggregate.w5Bps)}`)
  if (aggregate.w30Bps !== null && aggregate.w30Bps > 0) rates.push(`${t('rates.w30')} ${formatSpeed(aggregate.w30Bps)}`)
  return (
    <div className="rdm2-stats">
      <span className="rdm2-counts">{counts.join('   ')}</span>
      <span className="rdm2-rates">{rates.length > 0 ? rates.join('   ') : t('rates.idle')}</span>
    </div>
  )
}

/** The page-level recorder strip. */
function RecorderStrip({ t, history, nowBps }: { t: TFunction; history: LedgerHistory; nowBps: number }) {
  const full = history.aggregate.length >= PAGE_SAMPLES
  const startLabel = full && history.sampledFrom !== null ? formatHourMinute(history.sampledFrom) : '—'
  return (
    <section className="rdm2-recorder" aria-label={t('page.recorderLabel')}>
      <Waveform
        values={history.aggregate}
        capacity={PAGE_SAMPLES}
        height={64}
        live={nowBps > 0}
        startLabel={startLabel}
        endLabel={t('page.recorderNow')}
        ariaLabel={t('page.recorderAria', { rate: formatSpeed(nowBps) })}
      />
      <p className="rdm2-recorder-note">{t('page.recorderNote')}</p>
    </section>
  )
}

/**
 * The review queue above the ledger: one calm row per record that needs a
 * human, errors first, capped at three with a "+N more" line. Below 600px the
 * rows collapse behind a single summary line that expands on tap, so a noisy
 * mobile record cannot push the ledger down the page.
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

/** Inline route/action banner; polling keeps retrying, so there is no button. */
function Banner({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rdm2-banner" role="alert">
      <span className="rdm2-banner-title">{title}</span>
      {hint !== undefined ? <span className="rdm2-banner-hint">{hint}</span> : null}
    </div>
  )
}

/** Group heading inside the one ledger surface. */
function GroupHeader({ t, sessionId, records, nowBps }: { t: TFunction; sessionId: string | null; records: number; nowBps: number }) {
  return (
    <div className="rdm2-group-head">
      <span className="rdm2-group-title">
        {sessionId === null ? t('group.unattributed') : t('group.session', { id: shortSessionId(sessionId) })}
      </span>
      <span className="rdm2-group-meta">
        {t('group.records', { n: records })}
        {nowBps > 0 ? `   ${formatSpeed(nowBps)}` : ''}
      </span>
    </div>
  )
}

export interface ReviewPageProps {
  t: TFunction
  /** Preview-only seeded rate history (static preview harness). */
  historySeed?: HistorySeed
}

/** The global review page (left sidebar entry). */
export function ReviewPage(props: ReviewPageProps) {
  const { t } = props
  const state = useLedger({ historySeed: props.historySeed })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const groups = useMemo(() => groupBySession(state.tasks), [state.tasks])

  const toggle = (id: string): void => {
    setExpandedId((previous) => (previous === id ? null : id))
  }

  const stop = (task: TaskView): void => {
    setActionError(null)
    void controlTask(task.id, 'cancel')
      .then(() => setFeedback(t('record.stopRequested', { name: fileNameOf(task) })))
      .catch((error: unknown) => setActionError(errorText(t, error)))
  }

  const loading = state.phase === 'loading'
  const unavailable = state.phase === 'error' && state.error !== null

  return (
    <div className="rdm2 rdm2-page" data-surface="global" data-rdm2-state={state.phase}>
      <ReviewStyle />
      <header className="rdm2-page-header">
        <div className="rdm2-page-title-block">
          <h1 className="rdm2-title">{t('page.title')}</h1>
          <EngineLine t={t} kernel={state.kernel} />
        </div>
        <StatsLine t={t} state={state} />
      </header>

      <RecorderStrip t={t} history={state.history} nowBps={state.aggregate.nowBps} />

      <RiskLine t={t} tasks={state.tasks} />

      {unavailable ? <Banner title={errorText(t, state.error)} hint={t('route.hint')} /> : null}
      {state.banner !== null && state.phase === 'ready' ? <Banner title={errorText(t, state.banner)} hint={t('route.hint')} /> : null}
      {actionError !== null ? <Banner title={actionError} /> : null}

      <section className="rdm2-ledger-section" aria-label={t('page.title')}>
        {loading ? (
          <SkeletonRows rows={3} />
        ) : state.tasks.length === 0 ? (
          <div className="rdm2-ledger rdm2-empty">
            <Note>{t('empty.global')}</Note>
          </div>
        ) : (
          <div className="rdm2-ledger">
            {groups.map((group) => (
              <section className="rdm2-group" key={group.sessionId ?? 'unattributed'} data-session={group.sessionId ?? ''}>
                <GroupHeader t={t} sessionId={group.sessionId} records={group.records} nowBps={group.nowBps} />
                {group.tasks.map((task) => (
                  <RecordRow
                    key={task.id}
                    t={t}
                    task={task}
                    variant="page"
                    history={state.history}
                    expanded={expandedId === task.id}
                    onToggle={toggle}
                    onStop={stop}
                    domId={`rdm2-drawer-${task.id}`}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </section>
      <LiveRegion message={feedback} />
    </div>
  )
}
