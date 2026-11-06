/**
 * Configuration and defaults for the `dsh-rdm` host half.
 *
 * The Loader validates the plugin row's `config` against {@link Config} and
 * fills in defaults; {@link resolveConfig} applies the same defaults for direct
 * callers that bypass the Loader (tests, embedded use).
 *
 * @module dsh-rdm/config
 */

import z from '@deepseek-ai/schemastery'

// ── Limits mirrored from PROTOCOL.md ────────────────────────────────────────

const MIN_CONNECTIONS = 1
const MAX_CONNECTIONS = 32
const MAX_CHUNK_SIZE_MIB = 64
const MAX_ATTEMPTS = 100
const MIN_ATTEMPTS = 1

/** Kernel log levels accepted by the `--log-level` flag. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const

/** One accepted kernel log level. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Raw deployment config for the plugin row. Every field is optional here
 * because the Loader schema fills the defaults before `apply` runs, and plain
 * object callers are handled by {@link resolveConfig}.
 */
export interface RdmConfig {
  /** Default download directory. Empty = kernel process cwd (the DSH host's cwd). */
  defaultDir?: string
  /** Default worker cap for new tasks (1..32). */
  connections?: number
  /** Default chunk size in MiB (0 = auto, else 0.25..64). */
  chunkSizeMiB?: number
  /** Flush each completed file to stable storage before renaming it (slower). */
  fsyncOnComplete?: boolean
  /** Default global/per-task bandwidth cap in bytes/second (0 = unlimited). */
  speedLimitBps?: number
  /** Per-chunk retry budget for new tasks (1..100). */
  maxAttempts?: number
  /** Auto-resume tasks interrupted by the previous kernel generation. */
  autoResume?: boolean
  /** Kernel data directory. Empty = `$DSH_HOME/dsh-rdm` (homedir fallback). */
  dataDir?: string
  /** Explicit kernel binary path. Empty = bundled `bin/<platform>-<arch>/rdm-kernel`. */
  kernelPath?: string
  /** Kernel stderr log level. */
  logLevel?: LogLevel
  /** Start the kernel immediately instead of on first tool/panel use. */
  startOnDemand?: boolean
}

/** Fully defaulted host settings consumed by the plugin. */
export interface ResolvedRdmConfig {
  defaultDir: string
  connections: number
  chunkSizeMiB: number
  speedLimitBps: number
  maxAttempts: number
  autoResume: boolean
  dataDir: string
  kernelPath: string
  logLevel: LogLevel
  startOnDemand: boolean
  fsyncOnComplete: boolean
}

/** Default config values, exported so tests and docs share one source. */
export const CONFIG_DEFAULTS: ResolvedRdmConfig = {
  defaultDir: '',
  connections: 8,
  // 0 = automatic chunk sizing in the kernel (four chunks per connection,
  // bounded to 0.25..8 MiB). A fixed 4 MiB default under-uses the connection
  // pool for files below ~32 MiB: a 10 MiB download then runs three ranges
  // instead of ten and takes about twice as long on a fast origin.
  chunkSizeMiB: 0,
  speedLimitBps: 0,
  maxAttempts: 6,
  autoResume: true,
  dataDir: '',
  kernelPath: '',
  logLevel: 'warn',
  startOnDemand: true,
  fsyncOnComplete: false,
}

/**
 * Schemastery schema for this plugin's Loader row.
 *
 * Unknown keys are tolerated by schemastery, so a config written for a later
 * version of the plugin stays harmless.
 */
export const Config = z.object({
  defaultDir: z.string().description('Default download directory (empty = DSH host cwd).').default(''),
  connections: z
    .number()
    .step(1)
    .min(MIN_CONNECTIONS)
    .max(MAX_CONNECTIONS)
    .description('Default connection count for new downloads (1..32).')
    .default(CONFIG_DEFAULTS.connections),
  chunkSizeMiB: z
    .number()
    .min(0)
    .max(MAX_CHUNK_SIZE_MIB)
    .description('Default chunk size in MiB (0 = auto, otherwise 0.25..64).')
    .default(CONFIG_DEFAULTS.chunkSizeMiB),
  speedLimitBps: z
    .number()
    .step(1)
    .min(0)
    .description('Default bandwidth cap in bytes/second (0 = unlimited).')
    .default(CONFIG_DEFAULTS.speedLimitBps),
  maxAttempts: z
    .number()
    .step(1)
    .min(MIN_ATTEMPTS)
    .max(MAX_ATTEMPTS)
    .description('Per-chunk retry budget for new downloads.')
    .default(CONFIG_DEFAULTS.maxAttempts),
  autoResume: z
    .boolean()
    .description('Automatically resume tasks interrupted by the previous kernel generation.')
    .default(CONFIG_DEFAULTS.autoResume),
  dataDir: z
    .string()
    .description('Kernel data directory (empty = $DSH_HOME/dsh-rdm).')
    .default(CONFIG_DEFAULTS.dataDir),
  kernelPath: z
    .string()
    .description('Explicit rdm-kernel binary path (empty = bundled bin/<platform>-<arch>/).')
    .default(CONFIG_DEFAULTS.kernelPath),
  logLevel: z
    .union(LOG_LEVELS.map((level) => z.const(level)))
    .description('Kernel stderr log level.')
    .default(CONFIG_DEFAULTS.logLevel),
  startOnDemand: z
    .boolean()
    .description('Start the kernel on first use instead of at plugin load.')
    .default(CONFIG_DEFAULTS.startOnDemand),
  fsyncOnComplete: z
    .boolean()
    .description('Flush each completed file to stable storage (fsync) before renaming it. Off by default: it adds a full file flush to every download and protects only against OS/power loss.')
    .default(CONFIG_DEFAULTS.fsyncOnComplete),
})

// ── Direct-call default resolution ──────────────────────────────────────────

/** Coerce an unknown value to a finite number, else fall back. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Clamp a finite number into an integer range. */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Coerce an unknown value to a string, else fall back. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerce an unknown value to a boolean, else fall back. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Resolve a kernel log level from an unknown config value. */
function logLevelOr(value: unknown, fallback: LogLevel): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : fallback
}

/**
 * Apply defaults (and range clamps) to deployment-provided settings.
 *
 * This is the same normalization the Loader schema performs; applying it here
 * means a direct `apply(ctx, {})` call and a validated Loader row behave
 * identically.
 *
 * @param config - Raw plugin config, possibly empty or partially filled.
 * @returns Complete settings consumed by the host half.
 */
export function resolveConfig(config: RdmConfig | undefined): ResolvedRdmConfig {
  const raw = config ?? {}
  return {
    defaultDir: stringOr(raw.defaultDir, CONFIG_DEFAULTS.defaultDir),
    connections: clampInt(
      numberOr(raw.connections, CONFIG_DEFAULTS.connections),
      MIN_CONNECTIONS,
      MAX_CONNECTIONS,
    ),
    chunkSizeMiB: clampInt(numberOr(raw.chunkSizeMiB, CONFIG_DEFAULTS.chunkSizeMiB), 0, MAX_CHUNK_SIZE_MIB),
    speedLimitBps: Math.max(0, Math.round(numberOr(raw.speedLimitBps, CONFIG_DEFAULTS.speedLimitBps))),
    maxAttempts: clampInt(numberOr(raw.maxAttempts, CONFIG_DEFAULTS.maxAttempts), MIN_ATTEMPTS, MAX_ATTEMPTS),
    autoResume: booleanOr(raw.autoResume, CONFIG_DEFAULTS.autoResume),
    dataDir: stringOr(raw.dataDir, CONFIG_DEFAULTS.dataDir),
    kernelPath: stringOr(raw.kernelPath, CONFIG_DEFAULTS.kernelPath),
    logLevel: logLevelOr(raw.logLevel, CONFIG_DEFAULTS.logLevel),
    startOnDemand: booleanOr(raw.startOnDemand, CONFIG_DEFAULTS.startOnDemand),
    fsyncOnComplete: booleanOr(raw.fsyncOnComplete, CONFIG_DEFAULTS.fsyncOnComplete),
  }
}
