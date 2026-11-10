// The floating active-download popup (bottom-right, `shell.overlay`).
//
// Product rule: this surface exists **iff** at least one session has an active
// download (queued / probing / running). With nothing active the component
// renders nothing at all, so the frame carries no empty chrome. While active it
// can be collapsed to a pill but never dismissed: the running work stays visible
// until it settles.
//
// Each row is one download, titled by its file name. The owning session is
// secondary metadata only: a popup headed by session names made several
// concurrent files in one session look like a single transfer and was reported
// as misleading. The aggregate header still sums every active task.
//
// It shares the global feed with the workbench page, so the popup costs no extra
// polling when the page is open.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useGlobalLedger } from './data'
import { formatPercent, formatSpeed, shortSessionId } from './format'
import { ChevronGlyph, CloseGlyph, DownloadGlyph } from './icons'
import { currentConnections, fileNameOf, isActive } from './model'
import { ReviewStyle } from './primitives'
import type { TFunction, TaskView } from './types'

/** One active download row inside the popup. */
interface ActiveTaskRow {
  /** Kernel task id, stable across polls. */
  id: string
  /** File name: the row's visible title. */
  title: string
  /** Owning session's display name, secondary metadata. */
  sessionTitle: string
  task: TaskView
  percent: number | null
  speedBps: number
  connections: number
  /** 0..1 for the row's meter. */
  fraction: number
}

/** Aggregate completion of a task set: bytes when known, mean percent otherwise. */
function aggregatePercent(tasks: TaskView[]): number | null {
  let downloaded = 0
  let total = 0
  let unknown = false
  let percentSum = 0
  let percentCount = 0
  for (const task of tasks) {
    if (task.total !== null && task.total > 0) {
      downloaded += task.downloaded
      total += task.total
    } else {
      unknown = true
    }
    if (task.percent !== null) {
      percentSum += task.percent
      percentCount += 1
    }
  }
  if (!unknown && total > 0) return Math.min(100, (downloaded / total) * 100)
  if (percentCount > 0) return percentSum / percentCount
  return null
}

/** The owning session's display name; unattributed tasks say so explicitly. */
function sessionTitleOf(task: TaskView, sessions: ReturnType<typeof useGlobalLedger>['sessions'], t: TFunction): string {
  if (task.sessionId === null) return t('group.unattributedSession')
  const meta = sessions[task.sessionId] ?? null
  if (meta !== null && meta.title !== null && meta.title.trim() !== '') return meta.title
  return t('group.sessionFallback', { id: shortSessionId(task.sessionId) })
}

/** One row per active download, sorted by file name. */
function rowsOf(t: TFunction, tasks: TaskView[], sessions: ReturnType<typeof useGlobalLedger>['sessions']): ActiveTaskRow[] {
  return tasks
    .map((task) => {
      const percent = task.percent
      return {
        id: task.id,
        title: fileNameOf(task),
        sessionTitle: sessionTitleOf(task, sessions, t),
        task,
        percent,
        speedBps: task.speedBps,
        connections: currentConnections(task) ?? 0,
        fraction: percent === null ? 0 : Math.max(0, Math.min(1, percent / 100)),
      }
    })
    .sort((left, right) => left.title.localeCompare(right.title) || left.sessionTitle.localeCompare(right.sessionTitle))
}

export interface DownloadsPopupProps {
  t: TFunction
  /** Switch the shell to the plugin's global panel. */
  onOpen: () => void
}

/** The frame-wide active-download popup. */
export function DownloadsPopup({ t, onOpen }: DownloadsPopupProps) {
  const state = useGlobalLedger()
  const active = useMemo(() => state.tasks.filter(isActive), [state.tasks])
  const rows = useMemo(() => rowsOf(t, active, state.sessions), [t, active, state.sessions])
  const [collapsed, setCollapsed] = useState(false)
  // A newly started task always re-expands the popup, even after a manual collapse.
  const seenRef = useRef<Set<string>>(new Set())
  const activeKey = active.map((task) => task.id).join(',')

  useEffect(() => {
    const ids = active.map((task) => task.id)
    const fresh = ids.some((id) => !seenRef.current.has(id))
    for (const id of ids) seenRef.current.add(id)
    if (fresh) setCollapsed(false)
    // Only task identity matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  if (active.length === 0) return null

  const percent = aggregatePercent(active)
  const speed = active.reduce((sum, task) => sum + task.speedBps, 0)
  const connections = active.reduce((sum, task) => sum + (currentConnections(task) ?? 0), 0)

  if (collapsed) {
    return (
      <>
        <ReviewStyle />
        <div className="rdm2 rdm2-pop" data-collapsed="true">
          <button
            type="button"
            className="rdm2-pop-pill"
            aria-expanded={false}
            aria-label={t('popup.expand')}
            onClick={() => setCollapsed(false)}
          >
            <span className="rdm2-pop-live-dot" aria-hidden="true" />
            <span className="rdm2-pop-pill-text">
              {t('popup.pill', { n: active.length })}
              {percent !== null ? ` · ${formatPercent(percent)}` : ''}
            </span>
            <span className="rdm2-pop-pill-chevron" aria-hidden="true">
              <ChevronGlyph size={12} />
            </span>
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <ReviewStyle />
      <section className="rdm2 rdm2-pop" data-collapsed="false" aria-label={t('popup.title', { n: active.length })}>
        <header className="rdm2-pop-head">
          <span className="rdm2-pop-live-dot" aria-hidden="true" />
          <span className="rdm2-pop-title">{t('popup.title', { n: active.length })}</span>
          <span className="rdm2-pop-summary">
            {percent !== null ? formatPercent(percent) : ''}
            {speed > 0 ? ` · ${formatSpeed(speed)}` : ''}
            {connections > 0 ? ` · ${t('popup.connections', { n: connections })}` : ''}
          </span>
          <button
            type="button"
            className="rdm2-icon-button rdm2-pop-collapse"
            aria-label={t('popup.collapse')}
            title={t('popup.collapse')}
            onClick={() => setCollapsed(true)}
          >
            <ChevronGlyph size={13} />
          </button>
        </header>

        <div className="rdm2-pop-rows">
          {rows.map((row) => (
            <button
              type="button"
              className="rdm2-pop-row"
              key={row.id}
              onClick={onOpen}
              title={t('popup.openPanel')}
            >
              <span className="rdm2-pop-row-top">
                <span className="rdm2-pop-file" title={row.title}>
                  {row.title}
                </span>
                <span className="rdm2-pop-percent">{row.percent === null ? '' : formatPercent(row.percent)}</span>
              </span>
              <span className="rdm2-pop-meter" aria-hidden="true">
                <span className="rdm2-pop-meter-fill" style={{ width: `${Math.round(row.fraction * 100)}%` }} />
              </span>
              <span className="rdm2-pop-row-meta">
                <span className="rdm2-pop-session" title={row.sessionTitle}>
                  {row.sessionTitle}
                </span>
                {row.speedBps > 0 ? <span>{formatSpeed(row.speedBps)}</span> : null}
                {row.connections > 0 ? <span>{t('popup.connections', { n: row.connections })}</span> : null}
              </span>
            </button>
          ))}
        </div>

        <footer className="rdm2-pop-foot">
          <button type="button" className="rdm2-pop-open" onClick={onOpen}>
            <DownloadGlyph size={13} />
            {t('popup.openPanel')}
          </button>
          <button type="button" className="rdm2-pop-open-quiet" onClick={() => setCollapsed(true)}>
            {t('popup.collapse')}
            <CloseGlyph size={11} />
          </button>
        </footer>
      </section>
    </>
  )
}
