// The session review surface — the body of the native right-sidebar tab
// (`dsh-rdm/downloads`, kind `rdm`).
//
// Same record primitive and evidence drawer as the global workbench, scoped to
// one session: no composer, no filters, no batch bar; the row actions are the
// same pause/resume/open/delete verbs so a human can intervene from either
// surface.

import React, { useEffect, useMemo, useState } from 'react'
import { controlTasks, errorText, openTask } from './api'
import { copyText } from './clipboard'
import { useLedger, type HistorySeed } from './data'
import { formatSpeed } from './format'
import { RecordRow } from './ledger'
import { fileNameOf, groupBySession } from './model'
import { EmptyState, LiveRegion, Note, ReviewStyle, SkeletonRows, TextButton } from './primitives'
import { DownloadGlyph } from './icons'
import type { NativeTabFrameworkProps, TFunction, TaskView } from './types'

/**
 * Read the native column's session id from the surrounding host markup. The
 * slot framework injects `sessionId`; this is a last-resort fallback for a
 * host build that does not pass it, so the tab never silently shows global
 * records.
 */
function useFallbackSessionId(direct: string | undefined): string | undefined {
  const [found, setFound] = useState<string | undefined>(direct)
  useEffect(() => {
    if (direct !== undefined && direct !== '') {
      setFound(direct)
      return
    }
    const roots = document.querySelectorAll('.rdm2-session')
    for (const root of Array.from(roots)) {
      const holder = root.closest('[data-sidebar-right-session]') as HTMLElement | null
      const id = holder?.dataset.sidebarRightSession
      if (typeof id === 'string' && id !== '') {
        setFound(id)
        return
      }
    }
  }, [direct])
  return direct !== undefined && direct !== '' ? direct : found
}

export interface SessionSurfaceProps {
  t: TFunction
  sessionId?: string
  /** Preview-only seeded rate history. */
  historySeed?: HistorySeed
  /** Reveal the saved file in the host file viewer (session scope only). */
  onReveal?: (path: string, sessionId: string | undefined) => void
  /** The framework injects this hook; absent on older slot runtimes. */
  useTabInfo?: () => { tab?: { visible?: boolean } } | undefined
  /** Preview-only: force visibility when no framework hook exists. */
  visible?: boolean
}

/** Header: active count + aggregate rate. */
function SessionHeader({ t, state }: { t: TFunction; state: ReturnType<typeof useLedger> }) {
  const rate = state.aggregate.nowBps
  const active = state.aggregate.active
  return (
    <header className="rdm2-session-header">
      <div className="rdm2-session-title-line">
        <h1 className="rdm2-session-title">{t('session.title')}</h1>
        <span className="rdm2-session-sub">
          <span>{t('counts.active', { n: active })}</span>
          <span>{rate > 0 ? formatSpeed(rate) : t('rates.idle')}</span>
        </span>
      </div>
    </header>
  )
}

interface SessionSurfaceCoreProps extends SessionSurfaceProps {
  visible: boolean
}

/** The scoped surface body (no framework hook calls here). */
function SessionSurfaceCore(props: SessionSurfaceCoreProps) {
  const { t, visible } = props
  const sessionId = useFallbackSessionId(props.sessionId)
  const scoped = sessionId !== undefined && sessionId !== ''
  const state = useLedger({ sessionId: scoped ? sessionId : '', historySeed: props.historySeed })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<TaskView | null>(null)

  const sorted = useMemo(() => {
    if (!scoped) return []
    const group = groupBySession(state.tasks.filter((task) => task.sessionId === sessionId))[0]
    return group === undefined ? [] : group.tasks
  }, [scoped, sessionId, state.tasks])

  const toggle = (id: string): void => {
    setExpandedId((previous) => (previous === id ? null : id))
  }

  const control = async (task: TaskView, action: 'pause' | 'resume' | 'remove'): Promise<void> => {
    setActionError(null)
    try {
      const result = await controlTasks([task.id], action, { notify: action !== 'resume' })
      const outcome = result.results[0]
      if (outcome !== undefined && !outcome.ok && outcome.error !== null) {
        setActionError(errorText(t, outcome.error))
        return
      }
      const base =
        action === 'pause'
          ? t('record.pausedOne', { name: fileNameOf(task) })
          : action === 'resume'
            ? t('record.resumedOne', { name: fileNameOf(task) })
            : t('record.deletedOne', { name: fileNameOf(task) })
      setFeedback(outcome?.notified === true ? `${base} ${t('record.agentNotified')}` : base)
      if (action === 'remove') setConfirmDelete(null)
    } catch (error) {
      setActionError(errorText(t, error))
    }
  }

  const open = async (task: TaskView, target: 'file' | 'folder'): Promise<void> => {
    setActionError(null)
    try {
      const result = await openTask(task.id, target)
      if (!result.opened) {
        setActionError(result.error === null ? t('error.code.open_failed') : errorText(t, result.error))
        return
      }
      setFeedback(target === 'file' ? t('record.openedFile', { name: fileNameOf(task) }) : t('record.openedFolder'))
    } catch (error) {
      setActionError(errorText(t, error))
    }
  }

  const copyId = async (task: TaskView): Promise<void> => {
    setFeedback((await copyText(task.id)) ? t('record.idCopied') : t('common.copyFailed'))
  }

  const loading = scoped && state.phase === 'loading'
  const unavailable = scoped && state.phase === 'error' && state.error !== null

  return (
    <div
      className="rdm2 rdm2-session"
      data-surface="session"
      data-rdm2-state={scoped ? state.phase : 'unscoped'}
      aria-hidden={visible ? undefined : 'true'}
    >
      <ReviewStyle />
      <SessionHeader t={t} state={state} />
      {!scoped ? <Note>{t('session.unknownScope')}</Note> : null}
      {state.banner !== null && state.phase === 'ready' ? (
        <div className="rdm2-banner" role="alert">
          <span className="rdm2-banner-title">{errorText(t, state.banner)}</span>
        </div>
      ) : null}
      {unavailable ? (
        <div className="rdm2-banner" role="alert">
          <span className="rdm2-banner-title">{errorText(t, state.error)}</span>
          <span className="rdm2-banner-hint">{t('route.hint')}</span>
        </div>
      ) : null}
      {actionError !== null ? (
        <div className="rdm2-banner" role="alert">
          <span className="rdm2-banner-title">{actionError}</span>
          <TextButton label={t('common.dismiss')} onClick={() => setActionError(null)}>
            {t('common.dismiss')}
          </TextButton>
        </div>
      ) : null}

      {confirmDelete !== null ? (
        <div className="rdm2-confirm rdm2-confirm-inline" role="alertdialog" aria-label={t('record.deleteConfirmTitle')}>
          <div className="rdm2-confirm-copy">
            <span className="rdm2-confirm-title">{t('record.deleteConfirmOne', { name: fileNameOf(confirmDelete) })}</span>
            <span className="rdm2-confirm-hint">{t('record.deleteConfirmHint')}</span>
          </div>
          <div className="rdm2-confirm-actions">
            <TextButton label={t('common.cancel')} onClick={() => setConfirmDelete(null)}>
              {t('common.cancel')}
            </TextButton>
            <TextButton label={t('common.delete')} tone="danger" onClick={() => void control(confirmDelete, 'remove')}>
              {t('common.delete')}
            </TextButton>
          </div>
        </div>
      ) : null}

      <div className="rdm2-session-body">
        {scoped && loading ? (
          <div className="rdm2-session-loading">
            <SkeletonRows rows={2} />
          </div>
        ) : !scoped ? null : sorted.length === 0 ? (
          <EmptyState icon={<DownloadGlyph size={20} />} title={t('empty.session')} />
        ) : (
          sorted.map((task) => (
            <RecordRow
              key={task.id}
              t={t}
              task={task}
              variant="session"
              history={state.history}
              expanded={expandedId === task.id}
              onToggle={toggle}
              onPause={(target) => void control(target, 'pause')}
              onResume={(target) => void control(target, 'resume')}
              onDelete={(target) => setConfirmDelete(target)}
              onOpen={(target, kind) => void open(target, kind)}
              onCopyId={(target) => void copyId(target)}
              onReveal={
                props.onReveal === undefined
                  ? undefined
                  : (path: string) => {
                      props.onReveal?.(path, sessionId)
                    }
              }
              domId={`rdm2-session-drawer-${task.id}`}
            />
          ))
        )}
      </div>
      <LiveRegion message={feedback} />
    </div>
  )
}

/** Reads the framework's own `useTabInfo` hook; rendered only when provided. */
function SessionSurfaceWithInfo(props: SessionSurfaceProps) {
  const info = props.useTabInfo?.()
  return React.createElement(SessionSurfaceCore, { ...props, visible: info?.tab?.visible !== false })
}

/** The session tab body. */
export function SessionSurface(props: SessionSurfaceProps) {
  if (typeof props.useTabInfo === 'function') {
    return React.createElement(SessionSurfaceWithInfo, props as unknown as Record<string, unknown>)
  }
  return React.createElement(SessionSurfaceCore, { ...props, visible: props.visible !== false } as unknown as Record<string, unknown>)
}

/**
 * Build the slot component for `sidebar.right.pane.tab`. The body renders in
 * the HOST's React tree, but the factory is created inside the plugin's
 * `apply`, so `t` and the reveal handler are captured here rather than
 * imported from a service.
 */
export function makeSessionTabBody(t: TFunction, onReveal?: (path: string, sessionId: string | undefined) => void) {
  return function SessionTabBody(props: NativeTabFrameworkProps & Record<string, unknown>) {
    const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
    const useTabInfo = typeof props.useTabInfo === 'function' ? (props.useTabInfo as SessionSurfaceProps['useTabInfo']) : undefined
    return React.createElement(SessionSurface, { t, sessionId, onReveal, useTabInfo })
  }
}

/**
 * The chip title of the tab. The type's title is captured at open time; this
 * slot registration keeps the chip localizable when the language changes.
 */
export function makeSessionTabTitle(t: TFunction) {
  return function SessionTabTitle(props: Record<string, unknown>) {
    void props
    return React.createElement('span', { className: 'rdm2-tab-title' }, t('session.title'))
  }
}

