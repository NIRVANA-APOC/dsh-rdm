// Live data layer for the review surfaces.
//
// One process-wide poll (`useGlobalLedger()`) feeds every mounted review
// surface: the workbench page and the active-download popup. The poll starts
// with the first subscriber and stops with the last, so a closed panel leaves no
// timer behind.

import { useEffect, useState } from 'react'
import { getTask, listTasks, RouteError, toRouteError } from './api'
import type { Aggregate, GetValue, KernelInfo, SessionMeta, TaskView, WorkspaceMeta } from './types'

/** Poll cadence in milliseconds (protocol design: 1 s self-healing poll). */
export const POLL_MS = 1000

/** What a review surface needs to render. */
export interface LedgerState {
  phase: 'loading' | 'ready' | 'error'
  kernel: KernelInfo
  tasks: TaskView[]
  aggregate: Aggregate
  sessions: Record<string, SessionMeta>
  workspaces: WorkspaceMeta[]
  /** Set while the route has never answered. */
  error: RouteError | null
  /** Set when a later poll failed after data existed; polling keeps retrying. */
  banner: RouteError | null
  updatedAt: number
}

const IDLE_KERNEL: KernelInfo = {
  running: false,
  starting: false,
  version: null,
  pid: null,
  dataDir: null,
  protocol: null,
  error: null,
}

const EMPTY_AGGREGATE: Aggregate = {
  total: 0,
  active: 0,
  paused: 0,
  failed: 0,
  completed: 0,
  bytesDownloaded: 0,
  nowBps: 0,
  w5Bps: null,
  w30Bps: null,
  w300Bps: null,
  riskCount: 0,
}

function emptyState(): LedgerState {
  return {
    phase: 'loading',
    kernel: IDLE_KERNEL,
    tasks: [],
    aggregate: EMPTY_AGGREGATE,
    sessions: {},
    workspaces: [],
    error: null,
    banner: null,
    updatedAt: 0,
  }
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** Turn one list payload into a ready state. */
function readyState(value: Awaited<ReturnType<typeof listTasks>>): LedgerState {
  return {
    phase: 'ready',
    kernel: value.kernel,
    tasks: value.tasks,
    aggregate: value.aggregate,
    sessions: value.sessions,
    workspaces: value.workspaces,
    error: null,
    banner: null,
    updatedAt: Date.now(),
  }
}

/* --------------------------------------------------------------- global feed */

interface GlobalFeed {
  state: LedgerState
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
  busy: boolean
  started: boolean
}

let globalFeed: GlobalFeed | null = null

function ensureGlobalFeed(): GlobalFeed {
  if (globalFeed === null) {
    globalFeed = {
      state: emptyState(),
      listeners: new Set(),
      timer: undefined,
      busy: false,
      started: false,
    }
  }
  return globalFeed
}

function publish(feed: GlobalFeed, next: LedgerState): void {
  feed.state = next
  for (const listener of feed.listeners) listener()
}

function scheduleGlobal(feed: GlobalFeed, delay: number): void {
  if (!feed.started) return
  feed.timer = setTimeout(() => {
    feed.timer = undefined
    void tickGlobal(feed)
  }, delay)
}

async function tickGlobal(feed: GlobalFeed): Promise<void> {
  if (!feed.started) return
  if (!visible() || feed.busy) {
    scheduleGlobal(feed, POLL_MS)
    return
  }
  feed.busy = true
  try {
    const value = await listTasks({})
    if (!feed.started) return
    publish(feed, readyState(value))
  } catch (error) {
    if (!feed.started) return
    const routeError = toRouteError(error)
    const previous = feed.state
    publish(
      feed,
      previous.phase === 'ready'
        ? { ...previous, banner: routeError }
        : { ...previous, phase: 'error', error: routeError, banner: routeError },
    )
  } finally {
    feed.busy = false
    scheduleGlobal(feed, POLL_MS)
  }
}

function startGlobalFeed(feed: GlobalFeed): void {
  if (feed.started) return
  feed.started = true
  void tickGlobal(feed)
}

function stopGlobalFeed(feed: GlobalFeed): void {
  feed.started = false
  if (feed.timer !== undefined) {
    clearTimeout(feed.timer)
    feed.timer = undefined
  }
}

function onGlobalVisibility(): void {
  const feed = globalFeed
  if (feed === null || !feed.started || !visible() || feed.busy) return
  if (feed.timer !== undefined) clearTimeout(feed.timer)
  feed.timer = undefined
  void tickGlobal(feed)
}

/**
 * Poll `list` for the global workbench and the progress popup.
 *
 * The returned state is replaced on every successful poll; a failed poll after
 * the first success keeps the last good data and reports `banner`, and the loop
 * never stops while a surface is mounted.
 */
export function useGlobalLedger(): LedgerState {
  const feed = ensureGlobalFeed()
  const [state, setState] = useState<LedgerState>(feed.state)

  useEffect(() => {
    const current = ensureGlobalFeed()
    setState(current.state)
    const listener = (): void => setState(current.state)
    current.listeners.add(listener)
    if (current.listeners.size === 1) {
      document.addEventListener?.('visibilitychange', onGlobalVisibility)
      startGlobalFeed(current)
    }
    return () => {
      current.listeners.delete(listener)
      if (current.listeners.size === 0) {
        document.removeEventListener?.('visibilitychange', onGlobalVisibility)
        stopGlobalFeed(current)
      }
    }
  }, [])

  return state
}

/** Force an immediate global refresh (after a control/open/start mutation). */
export function refreshGlobalLedger(): void {
  const feed = globalFeed
  if (feed === null || !feed.started || feed.busy) return
  if (feed.timer !== undefined) {
    clearTimeout(feed.timer)
    feed.timer = undefined
  }
  void tickGlobal(feed)
}

/* ------------------------------------------------------------------- detail */

/** State of one lazily loaded evidence record. */
export interface DetailState {
  loading: boolean
  value: GetValue | null
  error: RouteError | null
}

/**
 * Fetch the one-shot detail for an expanded record. Re-fetches when the
 * record's status changes (a live task's drawer then shows fresh telemetry) or
 * when the caller bumps `reloadToken` (the drawer's retry), but never polls.
 */
export function useTaskDetail(task: TaskView | null, open: boolean, reloadToken = 0): DetailState {
  const [state, setState] = useState<DetailState>({ loading: false, value: null, error: null })
  const id = task?.id ?? null
  const status = task?.status ?? ''

  useEffect(() => {
    if (!open || id === null) {
      setState((previous) => (previous.loading || previous.value === null ? { loading: false, value: null, error: null } : previous))
      return
    }
    let cancelled = false
    setState((previous) => ({ loading: previous.value === null, value: previous.value, error: null }))
    void (async () => {
      try {
        const value = await getTask(id)
        if (cancelled) return
        setState({ loading: false, value, error: null })
      } catch (error) {
        if (cancelled) return
        setState((previous) => ({ loading: false, value: previous.value, error: toRouteError(error) }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, open, status, reloadToken])

  return state
}
