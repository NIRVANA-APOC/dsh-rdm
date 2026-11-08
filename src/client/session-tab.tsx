// The session review surface — the body of the native right-sidebar tab
// (`dsh-rdm/downloads`, kind `rdm`).
//
// Same visual language and the same evidence drawer as the global page, scoped
// to one session (docs/design/0.2.0-agent-native.md §6.3). The pane itself is
// the surface: no outer card, a sticky two-line header, hairline-separated
// records newest first, a micro recorder strip per record.

import React, { useEffect, useMemo, useState } from 'react'
import { controlTask, errorText } from './api'
import { useLedger, type HistorySeed } from './data'
import { formatSpeed } from './format'
import { RecordRow } from './ledger'
import { fileNameOf, groupBySession } from './model'
import { LiveRegion, Note, ReviewStyle, SkeletonRows } from './primitives'
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

/** Header: active count + aggregate rate, with verified and risk counts. */
function SessionHeader({ t, state, verified }: { t: TFunction; state: ReturnType<typeof useLedger>; verified: number }) {
  const risk = state.aggregate.riskCount
  const rate = state.aggregate.nowBps
  return (
    <header className="rdm2-session-header">
      <div className="rdm2-session-title-line">
        <h1 className="rdm2-session-title">{t('session.title')}</h1>
        <span className="rdm2-session-counts">
          {verified > 0 ? <span>{t('session.verifiedCount', { n: verified })}</span> : null}
          {risk > 0 ? <span className="rdm2-session-risk">{t('session.riskCount', { n: risk })}</span> : null}
        </span>
      </div>
      <div className="rdm2-session-sub">
        <span>{t('counts.active', { n: state.aggregate.active })}</span>
        <span>{rate > 0 ? formatSpeed(rate) : t('rates.idle')}</span>
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

  const sorted = useMemo(() => {
    if (!scoped) return []
    const group = groupBySession(state.tasks.filter((task) => task.sessionId === sessionId))[0]
    return group === undefined ? [] : group.tasks
  }, [scoped, sessionId, state.tasks])
  const verified = useMemo(() => state.tasks.filter((task) => task.verified === true).length, [state.tasks])

  const stop = (task: TaskView): void => {
    setActionError(null)
    void controlTask(task.id, 'cancel')
      .then(() => setFeedback(t('record.stopRequested', { name: fileNameOf(task) })))
      .catch((error: unknown) => setActionError(errorText(t, error)))
  }
  const toggle = (id: string): void => {
    setExpandedId((previous) => (previous === id ? null : id))
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
      <SessionHeader t={t} state={state} verified={verified} />
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
        </div>
      ) : null}

      <div className="rdm2-session-body">
        {scoped && loading ? (
          <div className="rdm2-session-loading">
            <SkeletonRows rows={2} />
          </div>
        ) : !scoped ? null : sorted.length === 0 ? (
          <Note>{t('empty.session')}</Note>
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
              onReveal={
                props.onReveal === undefined
                  ? undefined
                  : (path: string) => {
                      props.onReveal?.(path, sessionId)
                    }
              }
              onStop={stop}
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
