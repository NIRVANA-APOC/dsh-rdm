// Live data layer for the review surfaces.
//
// One poll loop feeds both surfaces: `useLedger` calls the plugin route once a
// second, normalizes the result (api.ts), keeps a bounded client-side rate
// history for the recorder strips, and pauses while the document is hidden.
//
// The kernel exposes trailing throughput *windows*, not a stored series, so
// the waveform is sampled by this client: one sample per successful poll, the
// newest at the right edge. `historySeed` exists only so the static preview
// harness can render the steady state (and tests can pin a shape); the product
// never passes it.

import { useEffect, useRef, useState } from 'react'
import { aggregateOf, getTask, listTasks, RouteError, toRouteError } from './api'
import type { Aggregate, GetValue, KernelInfo, TaskView } from './types'

/** Poll cadence in milliseconds (protocol design: 1 s self-healing poll). */
export const POLL_MS = 1000

/** Samples kept for the page-level recorder strip: 120 s at 1 Hz. */
export const PAGE_SAMPLES = 120

/** Samples kept per record: 40 s at 1 Hz. */
export const ROW_SAMPLES = 40

/** Optional pre-seeded history for the static preview harness only. */
export interface HistorySeed {
  aggregate?: number[]
  tasks?: Record<string, number[]>
}

/** Rate history for the recorder strips. */
export interface LedgerHistory {
  aggregate: number[]
  tasks: Map<string, number[]>
  /** Epoch ms of the oldest retained aggregate sample; null before sampling. */
  sampledFrom: number | null
}

/** What a review surface needs to render. */
export interface LedgerState {
  phase: 'loading' | 'ready' | 'error'
  kernel: KernelInfo
  tasks: TaskView[]
  aggregate: Aggregate
  /** Set while the route has never answered. */
  error: RouteError | null
  /** Set when a later poll failed after data existed; polling keeps retrying. */
  banner: RouteError | null
  updatedAt: number
  history: LedgerHistory
}

/** Options for the poll loop. */
export interface UseLedgerOptions {
  /** Native session surface scope; the host filters, and this client also filters defensively. */
  sessionId?: string
  /** Preview-only seed for the recorder strips. */
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

function seedHistory(seed: HistorySeed | undefined): LedgerHistory {
  const aggregate = (seed?.aggregate ?? []).slice(-PAGE_SAMPLES)
  const tasks = new Map<string, number[]>()
  if (seed?.tasks !== undefined) {
    for (const [id, values] of Object.entries(seed.tasks)) tasks.set(id, values.slice(-ROW_SAMPLES))
  }
  return {
    aggregate,
    tasks,
    sampledFrom: aggregate.length === 0 ? null : Date.now() - aggregate.length * POLL_MS,
  }
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

/**
 * Poll `list` for one surface.
 *
 * The returned object is replaced on every successful poll, so a component
 * that consumes it re-renders once a second. A failed poll after the first
 * success keeps the last good data and reports `banner`; the loop never stops.
 */
export function useLedger(options: UseLedgerOptions = {}): LedgerState {
  const sessionId = options.sessionId
  const [state, setState] = useState<LedgerState>(() => ({
    phase: 'loading',
    kernel: IDLE_KERNEL,
    tasks: [],
    aggregate: EMPTY_AGGREGATE,
    error: null,
    banner: null,
    updatedAt: 0,
    history: seedHistory(options.historySeed),
  }))
  // The poll loop reads these refs instead of closing over state, so the
  // interval is created once and never restarted by a render.
  const historyRef = useRef<LedgerHistory>(state.history)
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
      if (!visible()) {
        schedule(POLL_MS)
        return
      }
      if (busyRef.current) {
        schedule(POLL_MS)
        return
      }
      busyRef.current = true
      try {
        const value = await listTasks(sessionId === undefined ? {} : { sessionId })
        if (cancelled || !aliveRef.current) return
        // Defensive client-side scope: while the host/kernel pair lands v2
        // session attribution, a host may ignore the `sessionId` request field.
        const tasks =
          sessionId === undefined || sessionId === ''
            ? value.tasks
            : value.tasks.filter((task) => task.sessionId === sessionId)
        const aggregate = sessionId === undefined || sessionId === '' ? value.aggregate : aggregateOf(tasks)
        // Append one sample to the aggregate strip and to every unfinished
        // record's micro-strip. History rows stop sampling so a reopened
        // finished record does not grow a fake "live" pulse.
        const previous = historyRef.current
        const aggregateSample = aggregate.nowBps > 0 ? aggregate.nowBps : tasks.reduce((sum, task) => sum + (task.speedBps > 0 ? task.speedBps : 0), 0)
        const nextTasks = new Map<string, number[]>()
        for (const task of tasks) {
          if (!isSamplingStatus(task.status)) continue
          const prior = previous.tasks.get(task.id) ?? []
          nextTasks.set(task.id, pushSample(prior, task.speedBps, ROW_SAMPLES))
        }
        historyRef.current = {
          aggregate: pushSample(previous.aggregate, aggregateSample, PAGE_SAMPLES),
          tasks: nextTasks,
          sampledFrom:
            previous.sampledFrom ??
            (previous.aggregate.length === 0 && aggregateSample >= 0 ? Date.now() - POLL_MS : previous.sampledFrom),
        }
        setState({
          phase: 'ready',
          kernel: value.kernel,
          tasks,
          aggregate,
          error: null,
          banner: null,
          updatedAt: Date.now(),
          history: historyRef.current,
        })
      } catch (error) {
        if (cancelled || !aliveRef.current) return
        const routeError = toRouteError(error)
        setState((previous) => {
          if (previous.phase === 'ready') return { ...previous, banner: routeError }
          return {
            ...previous,
            phase: 'error',
            error: routeError,
            banner: routeError,
            history: historyRef.current,
          }
        })
      } finally {
        busyRef.current = false
        schedule(POLL_MS)
      }
    }

    /** Refresh immediately when the tab becomes visible again. */
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
