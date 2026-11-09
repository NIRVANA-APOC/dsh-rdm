// Live data layer for the review surfaces.
//
// Two feeds share one polling contract:
//   * `useGlobalLedger()` — one process-wide poll of every task, shared by the
//     global workbench and the top-right progress popup. The poll starts with
//     the first subscriber and stops with the last, so a closed panel leaves no
//     timer behind.
//   * `useLedger({ sessionId })` — a scoped poll for the session right-sidebar
//     tab (the host filters, and this client filters defensively).
//
// The kernel exposes trailing throughput *windows*, not a stored series, so the
// session tab's micro strip is sampled here: one sample per poll, newest at the
// right edge. `historySeed` exists only so the static preview harness can render
// a steady state; the product never passes it.

import { useEffect, useRef, useState } from 'react'
import { aggregateOf, getTask, listTasks, RouteError, toRouteError } from './api'
import type { Aggregate, GetValue, KernelInfo, SessionMeta, TaskView, WorkspaceMeta } from './types'

/** Poll cadence in milliseconds (protocol design: 1 s self-healing poll). */
export const POLL_MS = 1000

/** Samples kept per record for the session tab: 40 s at 1 Hz. */
export const ROW_SAMPLES = 40

/** Optional pre-seeded history for the static preview harness only. */
export interface HistorySeed {
  tasks?: Record<string, number[]>
}

/** Per-record rate history for the session tab's micro strips. */
export interface RateHistory {
  tasks: Map<string, number[]>
}

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
  history: RateHistory
}

/** Options for the scoped poll loop. */
export interface UseLedgerOptions {
  /** Native session surface scope; the host filters, and this client also filters defensively. */
  sessionId?: string
  /** Preview-only seed for the micro strips. */
  historySeed?: HistorySeed
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

const NO_HISTORY: RateHistory = { tasks: new Map() }

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
    history: NO_HISTORY,
  }
}

function seedHistory(seed: HistorySeed | undefined): RateHistory {
  const tasks = new Map<string, number[]>()
  if (seed?.tasks !== undefined) {
    for (const [id, values] of Object.entries(seed.tasks)) tasks.set(id, values.slice(-ROW_SAMPLES))
  }
  return { tasks }
}

function isSamplingStatus(status: string): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled'
}

function pushSample(values: number[], sample: number, capacity: number): number[] {
  const next = values.length >= capacity ? values.slice(values.length - capacity + 1) : values.slice()
  next.push(Math.max(0, sample))
  return next
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** Turn one list payload into a ready state (shared by both feeds). */
function readyState(
  value: Awaited<ReturnType<typeof listTasks>>,
  history: RateHistory,
  scopedSession: string | undefined,
): LedgerState {
  const scoped = scopedSession !== undefined && scopedSession !== ''
  // Defensive client-side scope: while the host/kernel pair lands session
  // attribution, a host may ignore the `sessionId` request field.
  const tasks = scoped ? value.tasks.filter((task) => task.sessionId === scopedSession) : value.tasks
  return {
    phase: 'ready',
    kernel: value.kernel,
    tasks,
    aggregate: scoped ? aggregateOf(tasks) : value.aggregate,
    sessions: value.sessions,
    workspaces: value.workspaces,
    error: null,
    banner: null,
    updatedAt: Date.now(),
    history,
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
    publish(feed, readyState(value, NO_HISTORY, undefined))
  } catch (error) {
    if (!feed.started) return
    const routeError = toRouteError(error)
    const previous = feed.state
    publish(
      feed,
      previous.phase === 'ready'
        ? { ...previous, banner: routeError, history: NO_HISTORY }
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

/* -------------------------------------------------------------- session feed */

/**
 * Poll `list` for one session-scoped surface.
 *
 * The returned object is replaced on every successful poll, so a component
 * that consumes it re-renders once a second.
 */
export function useLedger(options: UseLedgerOptions = {}): LedgerState {
  const sessionId = options.sessionId
  const [state, setState] = useState<LedgerState>(() => ({
    ...emptyState(),
    history: seedHistory(options.historySeed),
  }))
  // The poll loop reads these refs instead of closing over state, so the
  // interval is created once and never restarted by a render.
  const historyRef = useRef<RateHistory>(state.history)
  const aliveRef = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    const schedule = (delay: number): void => {
      if (cancelled) return
      timer = setTimeout(() => {
        void tick()
      }, delay)
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (!visible() || busyRef.current) {
        schedule(POLL_MS)
        return
      }
      busyRef.current = true
      try {
        const value = await listTasks(sessionId === undefined || sessionId === '' ? {} : { sessionId })
        if (cancelled || !aliveRef.current) return
        // One sample per unfinished record for the session tab's micro strip.
        const previous = historyRef.current
        const nextTasks = new Map<string, number[]>()
        for (const task of value.tasks) {
          if (!isSamplingStatus(task.status)) continue
          const prior = previous.tasks.get(task.id) ?? []
          nextTasks.set(task.id, pushSample(prior, task.speedBps, ROW_SAMPLES))
        }
        historyRef.current = { tasks: nextTasks }
        setState(readyState(value, historyRef.current, sessionId))
      } catch (error) {
        if (cancelled || !aliveRef.current) return
        const routeError = toRouteError(error)
        setState((previous) => {
          if (previous.phase === 'ready') return { ...previous, banner: routeError }
          return { ...previous, phase: 'error', error: routeError, banner: routeError, history: historyRef.current }
        })
      } finally {
        busyRef.current = false
        schedule(POLL_MS)
      }
    }

    const onVisibility = (): void => {
      if (!visible() || cancelled) return
      if (timer !== undefined) clearTimeout(timer)
      void tick()
    }

    if (options.historySeed !== undefined) {
      historyRef.current = seedHistory(options.historySeed)
    }

    void tick()
    document.addEventListener?.('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      aliveRef.current = false
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener?.('visibilitychange', onVisibility)
    }
    // The loop is intentionally created once per mount/session scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, options.historySeed])

  return state
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
