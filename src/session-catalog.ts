/**
 * Host-side session/workspace catalog and desktop helpers.
 *
 * The 0.3.0 review surfaces group downloads by workspace and session title
 * instead of a raw session id, so the host route must resolve display metadata
 * for every owning session. That resolution is shared by the browser route
 * (`list`) and the model-facing `rdm_search` tool, cached briefly, and kept
 * strictly optional: a deployment without `sessionQuery`,
 * `workspaceRegistry`, `sessions`, `agents` or `sessionController` still
 * serves a complete (if unlabelled) task list.
 *
 * The same module owns the two side effects the review UI triggers:
 *  - {@link SessionCatalog.notify} hands a short model-facing note to a live
 *    agent (never resumes a cold session);
 *  - {@link SessionCatalog.openPath} launches the host desktop opener for a
 *    file or folder (the route resolves the path from the task, so no
 *    arbitrary browser-supplied path reaches the shell).
 *
 * This module imports Node built-ins only; like the rest of the host half it
 * must not depend on `@deepseek-ai/*` packages at runtime.
 *
 * @module dsh-rdm/session-catalog
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { normalizeSessionId } from './kernel-client'
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
export type OpenPathFailure = 'invalid_request' | 'not_found' | 'io'

/** Canonical value of {@link SessionCatalog.openPath}. */
export interface OpenPathResult {
  opened: boolean
  /** Human-readable reason when `opened` is false (rendered by the route). */
  error?: string
  /** Stable classification for the route's error envelope. */
  code?: OpenPathFailure
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

/** `ctx.agents` (live-agent registry). */
interface AgentsService {
  get(id: string): unknown
}

/**
 * Request shape of `sessionController.prompt` (`SessionPromptRequest`).
 *
 * The Harness service accepts a second cancellation argument; the catalog
 * deliberately omits it so a notice is never cancelled by a background route.
 */
interface SessionPromptRequestLike {
  requestId: string
  sessionId: string
  mode: 'queue'
  content: Array<{ type: 'text'; text: string }>
  clientTimeZone: string
}

/** `ctx.sessionController` (the host service behind `ctx.remote.session`). */
interface SessionControllerService {
  /** The real Host method takes a cancellation signal second (it may be unused). */
  prompt(request: SessionPromptRequestLike, signal?: AbortSignal): unknown
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
  /** Monotonic suffix so notice request ids are unique within a process. */
  private promptSeq = 0

  /**
   * @param ctx - Host plugin context (services are read through `ctx.get`).
   * @param now - Clock seam for tests; defaults to `Date.now`.
   */
  constructor(ctx: HostContext, now: () => number = Date.now) {
    this.ctx = ctx
    this.now = now
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
   * Deliver one short note to the live agent that owns a session.
   *
   * A cold (not currently live) session is never resumed for a notice: the
   * agent could otherwise wake up just to read "a human clicked pause". The
   * prompt is queued so it is processed with the agent's next turn.
   *
   * @param sessionId - owning session id.
   * @param text - model-facing notice text.
   * @returns `true` only when the live agent accepted the prompt.
   */
  async notify(sessionId: string, text: string): Promise<boolean> {
    try {
      const id = normalizeSessionId(sessionId)
      if (id === null || text.trim() === '') return false
      const agents = this.ctx.get<AgentsService>('agents')
      const agent = agents === undefined || agents === null ? undefined : agents.get(id)
      if (agent === undefined || agent === null) return false
      const controller = this.ctx.get<SessionControllerService>('sessionController')
      if (
        controller === undefined ||
        controller === null ||
        typeof controller.prompt !== 'function'
      ) {
        return false
      }
      this.promptSeq += 1
      await controller.prompt(
        {
          requestId: `rdm-${id}-${Date.now()}-${this.promptSeq}`,
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: resolveClientTimeZone(),
        },
        // The Host prompt gate calls `signal.throwIfAborted()` before admitting
        // the message, so a real (never-aborted) signal keeps this call valid
        // while still letting it run detached from any request.
        new AbortController().signal,
      )
      return true
    } catch {
      // Notification is best-effort by contract; the control result stands.
      return false
    }
  }

  /**
   * Open a file or folder with the host desktop opener.
   *
   * Validation happens here (absolute path, no NUL, existing target) so the
   * browser route can only ever launch paths it resolved from a task. The
   * opener is spawned detached with ignored stdio: the plugin never waits for
   * or reports the file manager's exit status.
   *
   * @param path - absolute file or directory path.
   * @param target - `file` opens the file, `folder` reveals/opens its folder.
   */
  async openPath(path: string, target: 'file' | 'folder'): Promise<OpenPathResult> {
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
    if (!isAbsolutePath(candidate)) {
      return { opened: false, code: 'invalid_request', error: `the path is not absolute: ${candidate}` }
    }
    if (!existsSync(candidate)) {
      return { opened: false, code: 'not_found', error: `the path does not exist: ${candidate}` }
    }
    try {
      const spec = openerSpec(candidate, target)
      const child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      // `error` has no listener by default and would crash the host process.
      child.on('error', () => {
        /* The opener is advisory; an async spawn failure is not actionable. */
      })
      child.unref()
      return { opened: true }
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

/** Absolute-path check for the two path dialects the host may run on. */
function isAbsolutePath(path: string): boolean {
  if (process.platform === 'win32') {
    // Drive-qualified (`C:\dir`, `C:/dir`) or UNC (`\\server\share`).
    return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
  }
  return path.startsWith('/')
}

/** Pick the OS opener for one target (`folder` uses reveal semantics on macOS). */
function openerSpec(path: string, target: 'file' | 'folder'): { command: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      // `explorer.exe <path>` opens a file or a folder; `/select,` is not used
      // because the route already resolves the folder itself.
      return { command: 'explorer.exe', args: [path] }
    case 'darwin':
      return target === 'folder'
        ? { command: 'open', args: ['-R', path] }
        : { command: 'open', args: [path] }
    default:
      return { command: 'xdg-open', args: [path] }
  }
}

/**
 * IANA time zone of the host, used to stamp agent notices.
 *
 * `clientTimeZone` is optional in `SessionPromptRequest`; sending the host
 * zone lets the receiving agent render relative times correctly.
 */
function resolveClientTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
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
