// Wire and service types for the dsh-rdm client half.
// TaskView/TaskEvent mirror dsh-rdm/PROTOCOL.md; the service types mirror the
// public Client locale/slots surfaces used by this plugin only.

/** Bound translate function returned by `ctx.locale.bind(ns)`. */
export type TFunction = (key: string, params?: Record<string, string | number>) => string

/** Client locale service subset used here. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): (() => void) | void
  bind(ns: string): TFunction
  subscribe?(listener: () => void): () => void
}

/** Client slot service subset used here. */
export interface SlotsService {
  inject(owner: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Client plugin context subset used here. */
export interface ClientContext {
  locale: LocaleService
  slots: SlotsService
  effect?(callback: () => unknown, label?: string): unknown
}

/** Kernel error reported on a task. */
export interface TaskError {
  code: string
  message: string
}

/** Kernel generation status reported by `list`. */
export interface KernelInfo {
  running?: boolean
  starting?: boolean
  version?: string | null
  pid?: number | null
  dataDir?: string | null
  error?: string | null
}

/** Task status values from PROTOCOL.md. */
export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Download task view from PROTOCOL.md (fields present, nullable when unknown). */
export interface TaskView {
  id: string
  url: string
  finalUrl?: string | null
  fileName: string
  dir: string
  path?: string | null
  status: TaskStatus | string
  downloaded: number
  total?: number | null
  speedBps?: number
  etaSecs?: number | null
  activeWorkers?: number
  peakWorkers?: number
  connections?: number
  chunkSize?: number | null
  resumedChunks?: number
  rangeSupported?: boolean | null
  expectedSha256?: string | null
  sha256?: string | null
  error?: TaskError | null
  retries?: number
  createdAt?: number
  startedAt?: number | null
  finishedAt?: number | null
  elapsedMs?: number
  resumable?: boolean
}

/** One diagnostic event from PROTOCOL.md TaskEvent. */
export interface TaskEvent {
  seq: number
  at: number
  kind: string
  message?: string | null
  chunk?: number | null
  attempt?: number | null
  delayMs?: number | null
}

/** `list` action value. */
export interface ListValue {
  kernel: KernelInfo
  tasks: TaskView[]
}

/** `get` action value. */
export interface GetValue {
  task: TaskView
  events: TaskEvent[]
}

/** `start` action value. */
export interface StartValue {
  task: TaskView
}

/** `control` action value (`task` is null for `remove`). */
export interface ControlValue {
  task: TaskView | null
}

/** Control verbs accepted by the host route. */
export type ControlOp = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'
