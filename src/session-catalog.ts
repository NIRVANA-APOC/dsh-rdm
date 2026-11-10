/**
 * Host-side session/workspace catalog and desktop helpers.
 *
 * The 0.3.0 review surfaces group downloads by workspace and session title
 * instead of a raw session id, so the host route must resolve display metadata
 * for every owning session. That resolution is shared by the browser route
 * (`list`) and the model-facing `rdm_search` tool, cached briefly, and kept
 * strictly optional: a deployment without `sessionQuery`,
 * `workspaceRegistry` or `sessions` still serves a complete (if unlabelled)
 * task list.
 *
 * The same module owns the side effect the review UI triggers:
 *  - {@link SessionCatalog.openPath} launches the host desktop opener for a
 *    file or folder (the route resolves the path from the task, so no
 *    arbitrary browser-supplied path reaches the shell). The opener is honest
 *    about deployment limits: a host without a graphical session or a
 *    resolvable `xdg-open` reports `unsupported` instead of pretending a
 *    window appeared, and a failed spawn (ENOENT, EACCES, ...) is observed
 *    before success is reported.
 *
 * This module imports Node built-ins only; like the rest of the host half it
 * must not depend on `@deepseek-ai/*` packages at runtime.
 *
 * @module dsh-rdm/session-catalog
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import type { TaskView } from './protocol'

// ── Public value shapes ─────────────────────────────────────────────────────

/**
 * Display identity of one owning session.
 *
 * `title`, `cwd` and the workspace fields stay `null` when the corresponding
 * host service is absent or the session is unknown; the client then renders
 * the short session id under the unattributed-workspace group.
 */
export interface SessionMeta {
  id: string
  title: string | null
  live: boolean
  cwd: string | null
  workspaceId: string | null
  workspaceTitle: string | null
  workspacePath: string | null
}

/** One durable workspace registration, in registry order. */
export interface WorkspaceMeta {
  id: string
  title: string
  path: string
}

/** Canonical value of {@link SessionCatalog.describe}. */
export interface SessionCatalogResult {
  sessions: Record<string, SessionMeta>
  workspaces: WorkspaceMeta[]
}

/** Failure classification carried by {@link OpenPathResult}. */
export type OpenPathFailure = 'invalid_request' | 'not_found' | 'io' | 'unsupported'

/** Canonical value of {@link SessionCatalog.openPath}. */
export interface OpenPathResult {
  opened: boolean
  /** Human-readable reason when `opened` is false (rendered by the route). */
  error?: string
  /** Stable classification for the route's error envelope. */
  code?: OpenPathFailure
}

/** One resolved desktop opener command line. */
export interface OpenerSpec {
  /** Executable to spawn (an absolute path on POSIX). */
  command: string
  /** Arguments passed verbatim; on POSIX the resolved task path comes last. */
  args: string[]
}

/** Outcome of {@link desktopAvailability}: can this host open a file manager? */
export interface DesktopAvailability {
  /** `true` when the platform/env pair has a launchable desktop opener. */
  available: boolean
  /** Why the host cannot open a desktop window (`ready` when it can). */
  reason: 'ready' | 'no_display' | 'no_opener'
  /** Human-readable explanation; present only when `available` is false. */
  error?: string
}

/** Discriminated result of {@link resolveOpener}. */
export type OpenerResolution =
  | { ok: true; spec: OpenerSpec }
  | { ok: false; code: 'unsupported'; error: string }

/** The subset of a spawned child that the opener launcher observes. */
export interface OpenerChildLike {
  /** Listens for `'spawn'` (success) and `'error'` (spawn failure). */
  on(event: string, listener: (...args: any[]) => void): unknown
  /** Detaches the started child from the host event loop. */
  unref(): void
}

/** Child-process factory signature of {@link OpenPathEnvironment.spawn}. */
export type SpawnOpener = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => OpenerChildLike

/**
 * Injectable host facts for {@link SessionCatalog.openPath}.
 *
 * Production uses `process.platform`, `process.env` and `child_process.spawn`;
 * tests substitute these fields to exercise every platform/branch from one OS.
 */
export interface OpenPathEnvironment {
  /** Host platform discriminant (`process.platform` by default). */
  platform: string
  /** Environment read for DISPLAY/WAYLAND_DISPLAY and PATH detection. */
  env: Record<string, string | undefined>
  /** Child-process factory (defaults to `child_process.spawn`). */
  spawn: SpawnOpener
  /** Bound on the child 'spawn' vs 'error' race. */
  startTimeoutMs: number
}

/**
 * The catalog surface the host route and tools depend on.
 *
 * Narrow on purpose: tests substitute a plain object and the host route never
 * touches catalog internals.
 */
export interface SessionCatalogLike {
  describe(ids: readonly string[]): Promise<SessionCatalogResult>
}

// ── Optional host services ──────────────────────────────────────────────────
//
// Every declaration mirrors the subset of a real Harness service this module
// reads. They are structural and defensive: service methods are checked at
// call time, so a partial deployment degrades to empty metadata.

/** One element of `sessionQuery.readTitleSnapshots`. */
interface TitleSnapshotLike {
  sessionId?: unknown
  status?: unknown
  value?: unknown
  reason?: unknown
}

/** `ctx.sessionQuery` (dsh-session-query). */
interface SessionQueryService {
  readTitleSnapshots(...args: unknown[]): unknown
}

/** Session header subset (immutable creation metadata). */
interface SessionHeaderLike {
  cwd?: unknown
}

/** A live session from `ctx.sessions` (`sessions.get(id)`). */
interface LiveSessionLike {
  header?: SessionHeaderLike | null
}

/** `ctx.sessions` (in-memory live session store). */
interface SessionsService {
  get(id: string): LiveSessionLike | null | undefined
}

/** One workspace from `workspaceRegistry.list()` (entity with a `sessionIds` getter). */
interface WorkspaceEntryLike {
  id?: unknown
  title?: unknown
  path?: unknown
  sessionIds?: unknown
}

/** `ctx.workspaceRegistry` (durable workspace registry; `list()` is synchronous). */
interface WorkspaceRegistryService {
  list(): unknown
}

// ── Cache / bound constants ─────────────────────────────────────────────────

/** Title and header cache lifetime; negative entries expire the same way. */
const TITLE_TTL_MS = 15_000

/** Workspace registry list cache lifetime. */
const WORKSPACE_TTL_MS = 30_000

/** Bound on one describe batch (the task list cap is 100). */
const MAX_DESCRIBE_IDS = 100

/** Defensive cap on single-flight retry passes (a batch always caches its ids). */
const MAX_FETCH_PASSES = 3

/** Cached title/header resolution for one session. */
interface TitleCacheEntry {
  title: string | null
  cwd: string | null
  at: number
}

/** One workspace entry plus its metadata and canonical path prefix. */
interface WorkspaceIndexEntry {
  meta: WorkspaceMeta
  /** Canonical, separator-normalized path used for cwd prefix matching. */
  canonicalPath: string
}

// ── Small structural helpers ────────────────────────────────────────────────

/** Narrow an unknown JSON-ish value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Read a string field from a record, or `null`. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Canonicalize a filesystem path for prefix comparison.
 *
 * Resolves against the host cwd (session headers are absolute), normalizes
 * separators to `/`, drops trailing slashes, and lower-cases on Windows where
 * the filesystem is case-insensitive.
 */
function canonicalPath(value: string): string {
  let text = resolve(value).replace(/\\/g, '/')
  if (text.length > 1 && text.endsWith('/')) text = text.replace(/\/+$/, '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** `true` when `cwd` is the workspace path or lives beneath it. */
function cwdIsInside(cwd: string, workspacePath: string): boolean {
  return cwd === workspacePath || cwd.startsWith(`${workspacePath}/`)
}

/** Clamp/deduplicate a session-id list without validating the id grammar. */
function normalizeIds(ids: readonly string[]): string[] {
  const unique: string[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || unique.includes(id)) continue
    unique.push(id)
    if (unique.length >= MAX_DESCRIBE_IDS) break
  }
  return unique
}

/** Read a live session's header cwd, tolerating a missing/odd header. */
function headerCwd(session: LiveSessionLike | undefined): string | null {
  const cwd = asString(session?.header?.cwd)
  return cwd === null || cwd === '' ? null : cwd
}

/** Read a workspace registry entry as a canonical workspace value. */
function workspaceMeta(entry: WorkspaceEntryLike): WorkspaceMeta | null {
  const id = asString(entry.id)
  const path = asString(entry.path)
  if (id === null || id === '' || path === null || path === '') return null
  const title = asString(entry.title)
  return {
    id,
    title: title !== null && title.trim() !== '' ? title.trim() : basename(path),
    path,
  }
}

/**
 * Extract `{title, cwd}` from one fulfilled title snapshot.
 *
 * The Harness returns `{session: header, title?: {title}}`; malformed values
 * become a negative cache entry rather than an error.
 */
function readSnapshot(snapshot: TitleSnapshotLike): { title: string | null; cwd: string | null } {
  const value = asRecord(snapshot.value)
  const session = asRecord(value?.session)
  const titleSource = value?.title
  const title =
    typeof titleSource === 'string'
      ? titleSource
      : asString(asRecord(titleSource)?.title)
  const cwd = asString(session?.cwd)
  return {
    title: title === null || title === '' ? null : title,
    cwd: cwd === null || cwd === '' ? null : cwd,
  }
}

// ── SessionCatalog ──────────────────────────────────────────────────────────

/**
 * Cached resolver for session titles, live flags and workspace grouping.
 *
 * One instance is created per plugin load ({@link createSessionCatalog}) and
 * shared by the browser route and `rdm_search`, so both surfaces agree on the
 * labels they show and neither re-reads session logs per call.
 */
export class SessionCatalog implements SessionCatalogLike {
  private readonly ctx: HostContext
  private readonly now: () => number
  /** Session id -> cached title/header resolution (negative entries included). */
  private readonly titleCache = new Map<string, TitleCacheEntry>()
  /** Workspace registry entries, refreshed at most every {@link WORKSPACE_TTL_MS}. */
  private workspaceCache: { entries: WorkspaceEntryLike[]; at: number } | null = null
  /** Single-flight title batch: concurrent describe calls join one read. */
  private titleInflight: Promise<void> | null = null
  /** Platform/env/spawn facts the desktop opener reads (injectable for tests). */
  private readonly openEnvironment: OpenPathEnvironment

  /**
   * @param ctx - Host plugin context (services are read through `ctx.get`).
   * @param now - Clock seam for tests; defaults to `Date.now`.
   * @param openEnvironment - Platform/env/spawn seam for tests; production
   *   omits it and the real process environment and `child_process.spawn` are
   *   used.
   */
  constructor(
    ctx: HostContext,
    now: () => number = Date.now,
    openEnvironment: Partial<OpenPathEnvironment> = {},
  ) {
    this.ctx = ctx
    this.now = now
    this.openEnvironment = resolveOpenPathEnvironment(openEnvironment)
  }

  /**
   * Resolve display metadata for up to 100 session ids.
   *
   * Never throws: a missing or failing service contributes empty/partial
   * metadata so the polling browser route always receives a valid payload.
   * Results are cached for {@link TITLE_TTL_MS} (negative lookups included),
   * the workspace list for {@link WORKSPACE_TTL_MS}, and concurrent calls
   * share one title batch.
   *
   * @param ids - owning session ids from the current task list (duplicates ok).
   * @returns `sessions` keyed by session id and every known `workspaces` row.
   */
  async describe(ids: readonly string[]): Promise<SessionCatalogResult> {
    try {
      const unique = normalizeIds(ids)
      const entries = this.workspaceEntries()
      await this.fillTitleCache(unique)
      const index = this.buildWorkspaceIndex(entries)
      const sessions: Record<string, SessionMeta> = {}
      for (const id of unique) {
        const cached = this.titleCache.get(id)
        const live = this.liveSession(id)
        const cwd = cached?.cwd ?? headerCwd(live) ?? null
        const workspace =
          index.bySession.get(id) ?? this.matchWorkspaceByPath(index, cwd)
        sessions[id] = {
          id,
          title: cached?.title ?? null,
          live: live !== undefined,
          cwd,
          workspaceId: workspace?.id ?? null,
          workspaceTitle: workspace?.title ?? null,
          workspacePath: workspace?.path ?? null,
        }
      }
      return { sessions, workspaces: index.workspaces }
    } catch {
      // The catalog is decoration: a broken service must never fail the route.
      return { sessions: {}, workspaces: [] }
    }
  }

  /**
   * Open a file or folder with the host desktop opener.
   *
   * Validation happens here (absolute path, no NUL, existing target) so the
   * browser route can only ever launch paths it resolved from a task. Then:
   *  1. capability detection ({@link resolveOpener}) rejects a host without a
   *     graphical session or a resolvable `xdg-open` as `unsupported`;
   *  2. the child 'spawn' vs 'error' race is observed before success is
   *     reported, so a missing/unlaunchable opener becomes `io` instead of a
   *     silent no-op;
   *  3. the started child is detached and unref'd; the plugin never waits for
   *     the file manager to exit.
   *
   * @param path - absolute file or directory path.
   * @param target - `file` opens the file, `folder` reveals/opens its folder.
   */
  async openPath(path: string, target: 'file' | 'folder'): Promise<OpenPathResult> {
    const platform = this.openEnvironment.platform
    if (target !== 'file' && target !== 'folder') {
      return { opened: false, code: 'invalid_request', error: 'target must be "file" or "folder"' }
    }
    if (typeof path !== 'string' || path.trim() === '') {
      return { opened: false, code: 'invalid_request', error: 'a path is required' }
    }
    const candidate = path.trim()
    if (candidate.includes('\0')) {
      return { opened: false, code: 'invalid_request', error: 'the path contains a NUL character' }
    }
    if (!isAbsolutePath(candidate, platform)) {
      return { opened: false, code: 'invalid_request', error: `the path is not absolute: ${candidate}` }
    }
    if (!existsSync(candidate)) {
      return { opened: false, code: 'not_found', error: `the path does not exist: ${candidate}` }
    }
    const resolution = resolveOpener(candidate, target, platform, this.openEnvironment.env)
    if (!resolution.ok) {
      return { opened: false, code: resolution.code, error: resolution.error }
    }
    try {
      const child = this.openEnvironment.spawn(resolution.spec.command, resolution.spec.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      const failure = await confirmOpenerStart(child, this.openEnvironment.startTimeoutMs)
      return failure === null ? { opened: true } : { opened: false, code: 'io', error: failure }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { opened: false, code: 'io', error: `the desktop opener failed: ${message}` }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** `true` while a cached title/header entry is within its TTL. */
  private isFresh(id: string): boolean {
    const entry = this.titleCache.get(id)
    return entry !== undefined && this.now() - entry.at < TITLE_TTL_MS
  }

  /**
   * Ensure every requested id has a cache entry, joining an in-flight batch
   * instead of starting a second read. A batch always caches every id it was
   * given, so at most {@link MAX_FETCH_PASSES} passes are needed when another
   * caller's batch covers a disjoint id set.
   */
  private async fillTitleCache(ids: readonly string[]): Promise<void> {
    for (let pass = 0; pass < MAX_FETCH_PASSES; pass += 1) {
      const pending = ids.filter((id) => !this.isFresh(id))
      if (pending.length === 0) return
      const inflight = this.titleInflight
      if (inflight !== null) {
        await inflight
        continue
      }
      const batch = this.fetchTitles(pending)
      this.titleInflight = batch
      try {
        await batch
      } finally {
        if (this.titleInflight === batch) this.titleInflight = null
      }
    }
  }

  /** Read one title batch and cache a value (positive or negative) per id. */
  private async fetchTitles(ids: readonly string[]): Promise<void> {
    const cachedAt = this.now()
    const service = this.ctx.get<SessionQueryService>('sessionQuery')
    if (service === undefined || service === null || typeof service.readTitleSnapshots !== 'function') {
      for (const id of ids) this.titleCache.set(id, { title: null, cwd: null, at: cachedAt })
      return
    }
    let snapshots: readonly TitleSnapshotLike[] = []
    try {
      const result = await service.readTitleSnapshots(ids)
      snapshots = Array.isArray(result) ? (result as TitleSnapshotLike[]) : []
    } catch {
      // Fall through with an empty batch: every id gets a negative entry below.
    }
    const seen = new Set<string>()
    for (const snapshot of snapshots) {
      const record = asRecord(snapshot)
      if (record === null) continue
      const id = asString(record.sessionId)
      if (id === null || !ids.includes(id)) continue
      seen.add(id)
      if (record.status === 'fulfilled') {
        const value = readSnapshot(record as TitleSnapshotLike)
        this.titleCache.set(id, { title: value.title, cwd: value.cwd, at: this.now() })
      } else {
        this.titleCache.set(id, { title: null, cwd: null, at: this.now() })
      }
    }
    for (const id of ids) {
      if (!seen.has(id)) this.titleCache.set(id, { title: null, cwd: null, at: this.now() })
    }
  }

  /** Current workspace registry entries, refreshed lazily (never throws). */
  private workspaceEntries(): WorkspaceEntryLike[] {
    const at = this.now()
    const cached = this.workspaceCache
    if (cached !== null && at - cached.at < WORKSPACE_TTL_MS) return cached.entries
    let entries: WorkspaceEntryLike[] = []
    try {
      const registry = this.ctx.get<WorkspaceRegistryService>('workspaceRegistry')
      if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
        const listed = registry.list()
        if (Array.isArray(listed)) entries = listed as WorkspaceEntryLike[]
      }
    } catch {
      // A failing registry is an empty registry; sessions fall back to cwd only.
      entries = []
    }
    this.workspaceCache = { entries, at }
    return entries
  }

  /** Resolve one live session (never resumes anything: `sessions.get` is a read). */
  private liveSession(id: string): LiveSessionLike | undefined {
    try {
      const sessions = this.ctx.get<SessionsService>('sessions')
      if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
        return undefined
      }
      const session = sessions.get(id)
      return session === null || session === undefined ? undefined : session
    } catch {
      return undefined
    }
  }

  /** Build the session->workspace map and the cwd-prefix index in one pass. */
  private buildWorkspaceIndex(entries: readonly WorkspaceEntryLike[]): {
    workspaces: WorkspaceMeta[]
    bySession: Map<string, WorkspaceMeta>
    byPath: WorkspaceIndexEntry[]
  } {
    const workspaces: WorkspaceMeta[] = []
    const bySession = new Map<string, WorkspaceMeta>()
    const byPath: WorkspaceIndexEntry[] = []
    for (const entry of entries) {
      const meta = workspaceMeta(entry)
      if (meta === null) continue
      workspaces.push(meta)
      const sessionIds = entry.sessionIds
      if (Array.isArray(sessionIds)) {
        for (const raw of sessionIds) {
          const sessionId = asString(raw)
          if (sessionId === null || sessionId === '' || bySession.has(sessionId)) continue
          bySession.set(sessionId, meta)
        }
      }
      byPath.push({ meta, canonicalPath: canonicalPath(meta.path) })
    }
    return { workspaces, bySession, byPath }
  }

  /**
   * Attach a session that is not in any `sessionIds` list by canonical cwd
   * prefix; the deepest matching workspace path wins.
   */
  private matchWorkspaceByPath(
    index: { byPath: WorkspaceIndexEntry[] },
    cwd: string | null,
  ): WorkspaceMeta | null {
    if (cwd === null) return null
    const canonicalCwd = canonicalPath(cwd)
    let match: WorkspaceMeta | null = null
    let matchLength = -1
    for (const candidate of index.byPath) {
      if (!cwdIsInside(canonicalCwd, candidate.canonicalPath)) continue
      if (candidate.canonicalPath.length > matchLength) {
        match = candidate.meta
        matchLength = candidate.canonicalPath.length
      }
    }
    return match
  }
}

// ── Desktop opener helpers ──────────────────────────────────────────────────

/**
 * Bound on the child `'spawn'` vs `'error'` race.
 *
 * A successful fork reports `'spawn'` within a tick or two; a missing or
 * unlaunchable executable reports `'error'` just as quickly. The bound only
 * protects the route against a pathological host, it is not a "file manager
 * launched" delay.
 */
const OPENER_START_TIMEOUT_MS = 1_500

/** Environment variables that mark a live graphical session on POSIX hosts. */
const DISPLAY_VARIABLES = ['DISPLAY', 'WAYLAND_DISPLAY'] as const

/** Capability failure when the host has no graphical desktop session. */
const NO_DISPLAY_ERROR =
  'the host has no graphical desktop session (DISPLAY and WAYLAND_DISPLAY are unset), ' +
  'so it cannot open a file manager window; copy the path and open it on the machine running this download'

/** Capability failure when the POSIX opener is not installed. */
const NO_OPENER_ERROR =
  'the host has no xdg-open executable on PATH, so it cannot open a file manager window; ' +
  'copy the path and open it manually'

/** Absolute-path check for the two path dialects the host may run on. */
function isAbsolutePath(path: string, platform: string): boolean {
  if (platform === 'win32') {
    // Drive-qualified (`C:\dir`, `C:/dir`) or UNC (`\\server\share`).
    return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
  }
  return path.startsWith('/')
}

/** `true` when the environment names a live graphical session. */
function hasGraphicalSession(env: Record<string, string | undefined>): boolean {
  for (const name of DISPLAY_VARIABLES) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return true
  }
  return false
}

/** `true` when `candidate` is a regular file the host can execute. */
function isExecutableFile(candidate: string, platform: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    // Windows has no execute bit; `PATHEXT` resolution is unnecessary because
    // the only Windows opener (`explorer.exe`) is a system executable.
    if (platform === 'win32') return true
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a bare executable name against `env.PATH`.
 *
 * Filesystem probing only (never a shell), so the opener that is spawned is
 * exactly the executable the capability check saw. Relative PATH entries are
 * resolved against the host cwd; empty entries (which would mean cwd) are
 * skipped instead of being trusted.
 */
function findExecutable(
  name: string,
  env: Record<string, string | undefined>,
  platform: string,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? env.path
  if (typeof pathValue !== 'string' || pathValue.trim() === '') return null
  const separator = platform === 'win32' ? ';' : ':'
  for (const entry of pathValue.split(separator)) {
    const dir = entry.trim()
    if (dir === '') continue
    const candidate = resolve(dir, name)
    if (isExecutableFile(candidate, platform)) return candidate
  }
  return null
}

/**
 * Decide whether this host can show a file manager window at all.
 *
 * Windows and macOS always have a system opener; the Linux/POSIX branch needs
 * both a live graphical session and a resolvable `xdg-open`. This is the honest
 * replacement for spawning blindly: a headless or SSH host now reports
 * `unsupported` (which the panel renders with a copy-path fallback) instead of
 * claiming a window opened that can never appear.
 *
 * @param platform - host platform discriminant (`process.platform`).
 * @param env - host environment (`DISPLAY`/`WAYLAND_DISPLAY` and `PATH` read).
 */
export function desktopAvailability(
  platform: string,
  env: Record<string, string | undefined>,
): DesktopAvailability {
  if (platform === 'win32' || platform === 'darwin') {
    return { available: true, reason: 'ready' }
  }
  if (!hasGraphicalSession(env)) {
    return { available: false, reason: 'no_display', error: NO_DISPLAY_ERROR }
  }
  if (findExecutable('xdg-open', env, platform) === null) {
    return { available: false, reason: 'no_opener', error: NO_OPENER_ERROR }
  }
  return { available: true, reason: 'ready' }
}

/**
 * Resolve the opener command line for one path, or an `unsupported` failure.
 *
 * Pure apart from the PATH probe: no process is spawned here. On Linux the
 * `xdg-open` path is made absolute so the execution cannot resolve to a
 * different executable than the capability check saw.
 *
 * @param path - absolute file or directory path.
 * @param target - `file` opens the file, `folder` reveals/opens its folder.
 * @param platform - host platform discriminant (`process.platform`).
 * @param env - host environment (`PATH` is read on POSIX hosts).
 */
export function resolveOpener(
  path: string,
  target: 'file' | 'folder',
  platform: string,
  env: Record<string, string | undefined>,
): OpenerResolution {
  switch (platform) {
    case 'win32':
      // `explorer.exe <path>` opens a file or a folder; `/select,` is not used
      // because the route already resolves the folder itself.
      return { ok: true, spec: { command: 'explorer.exe', args: [path] } }
    case 'darwin':
      return {
        ok: true,
        spec:
          target === 'folder'
            ? { command: 'open', args: ['-R', path] }
            : { command: 'open', args: [path] },
      }
    default: {
      const availability = desktopAvailability(platform, env)
      if (!availability.available) {
        return { ok: false, code: 'unsupported', error: availability.error ?? NO_DISPLAY_ERROR }
      }
      const command = findExecutable('xdg-open', env, platform)
      if (command === null) {
        return { ok: false, code: 'unsupported', error: NO_OPENER_ERROR }
      }
      return { ok: true, spec: { command, args: [path] } }
    }
  }
}

/** Production child-process factory: detached, ignored stdio, hidden console. */
function spawnOpener(
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
): OpenerChildLike {
  return spawn(command, args, {
    detached: options.detached,
    stdio: options.stdio,
    windowsHide: options.windowsHide,
  })
}

/** Merge the injectable opener environment with production defaults. */
function resolveOpenPathEnvironment(overrides: Partial<OpenPathEnvironment>): OpenPathEnvironment {
  return {
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    spawn: overrides.spawn ?? spawnOpener,
    startTimeoutMs: overrides.startTimeoutMs ?? OPENER_START_TIMEOUT_MS,
  }
}

/**
 * Wait for the child `'spawn'` vs `'error'` event before reporting success.
 *
 * `child_process.spawn` reports an asynchronous failure through `'error'`
 * (ENOENT, EACCES, EMFILE, ...); treating the call itself as success is why a
 * missing opener used to look like an opened window. `'spawn'` is the only
 * success signal; without it the opener did not start.
 *
 * @param child - spawned opener process.
 * @param timeoutMs - bound on the race.
 * @returns `null` when the opener started, the failure message otherwise.
 */
function confirmOpenerStart(child: OpenerChildLike, timeoutMs: number): Promise<string | null> {
  return new Promise((done) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (failure: string | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (failure === null) {
        try {
          child.unref()
        } catch {
          /* A started child that cannot be detached still opened; no failure. */
        }
      }
      done(failure)
    }
    timer = setTimeout(
      () => settle(`the desktop opener did not report a successful start within ${timeoutMs}ms`),
      timeoutMs,
    )
    child.on('spawn', () => settle(null))
    child.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      settle(`the desktop opener failed to start: ${message}`)
    })
  })
}

// ── Task-path resolution (shared with the browser route) ────────────────────

/**
 * Resolve the filesystem target {@link SessionCatalog.openPath} should open.
 *
 * The route only accepts a task id and this mapping; it never forwards a
 * browser-supplied path. `folder` prefers the containing directory of a
 * finished file and falls back to the task's destination directory.
 *
 * @param task - the kernel task record.
 * @param target - `file` (the saved file) or `folder` (its container).
 * @returns an absolute path, or `null` when the task has no such location.
 */
export function resolveTaskOpenPath(task: TaskView, target: 'file' | 'folder'): string | null {
  const filePath = typeof task.path === 'string' && task.path !== '' ? task.path : null
  if (target === 'file') return filePath
  if (filePath !== null) {
    const parent = dirname(filePath)
    return parent !== '' ? parent : null
  }
  return typeof task.dir === 'string' && task.dir !== '' ? task.dir : null
}

/**
 * Construct the one catalog instance a plugin load shares.
 *
 * @param ctx - Host plugin context.
 */
export function createSessionCatalog(ctx: HostContext): SessionCatalog {
  return new SessionCatalog(ctx)
}
