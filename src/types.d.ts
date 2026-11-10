/**
 * Ambient declarations for the host half of `dsh-rdm`.
 *
 * The plugin runs inside a DeepSeek Harness profile where the real
 * `@deepseek-ai/*` packages and `node:*` built-in modules are available at
 * runtime. This repository has no Harness type packages installed, so this
 * file declares the minimal surface the host half consumes; it is what lets
 * `npx tsc --noEmit` pass without depending on the Harness installation.
 *
 * These declarations describe only the subset used here. The runtime modules
 * are the real ones — never import this file for runtime values.
 */

// ── Node.js globals used by the host half ───────────────────────────────────

declare const process: {
  platform: string
  arch: string
  pid: number
  execPath: string
  env: Record<string, string | undefined>
  exitCode?: number
}

declare const __dirname: string
declare const __filename: string

// ── Node.js built-in modules used by the host half ──────────────────────────

declare module 'node:child_process' {
  /** Event plumbing shared by the pipe streams. */
  export interface StreamLike {
    on(event: string, listener: (...args: any[]) => void): void
    once(event: string, listener: (...args: any[]) => void): void
    removeListener(event: string, listener: (...args: any[]) => void): void
  }

  /** `child.stdout` / `child.stderr` with a string decoder. */
  export interface ReadableStreamLike extends StreamLike {
    setEncoding(encoding: string): void
  }

  /** `child.stdin` (always a pipe for the kernel). */
  export interface WritableStreamLike extends StreamLike {
    write(chunk: string, encoding?: string, callback?: (error?: Error | null) => void): boolean
    end(): void
    destroy?(): void
  }

  /** The subset of `ChildProcess` the kernel client observes. */
  export interface ChildProcess {
    readonly pid?: number
    readonly exitCode: number | null
    readonly signalCode: string | null
    readonly stdin: WritableStreamLike
    readonly stdout: ReadableStreamLike
    readonly stderr: ReadableStreamLike
    kill(signal?: string): boolean
    /** Detach the child from the host event loop (used by the desktop opener). */
    unref(): void
    on(event: string, listener: (...args: any[]) => void): this
    once(event: string, listener: (...args: any[]) => void): this
    removeListener(event: string, listener: (...args: any[]) => void): this
  }

  export interface ChildProcessWithoutNullStreams extends ChildProcess {}

  export interface SpawnOptions {
    stdio?: any
    windowsHide?: boolean
    cwd?: string
    env?: Record<string, string | undefined>
    /** Start the child in its own process group (desktop opener). */
    detached?: boolean
  }

  export function spawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean }
  export function accessSync(path: string, mode?: number): void
  export const constants: { F_OK: number; R_OK: number; W_OK: number; X_OK: number }
}

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, ext?: string): string
  export function normalize(p: string): string
  export const sep: string
  export const delimiter: string
  const path: {
    join: typeof join
    resolve: typeof resolve
    dirname: typeof dirname
    basename: typeof basename
    normalize: typeof normalize
    sep: string
    delimiter: string
  }
  export default path
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
  export function platform(): string
  export function arch(): string
  const os: {
    homedir: typeof homedir
    tmpdir: typeof tmpdir
    platform: typeof platform
    arch: typeof arch
  }
  export default os
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
  export function pathToFileURL(path: string): URL
}

// ── DSH tool registry (`@deepseek-ai/dsh-tools`) ────────────────────────────
//
// `defineTool` receives parameter specs in the unified schema DSL and returns
// a registry-ready definition; `output.schema` uses the same DSL for the
// canonical value and `output.render` projects that value to text blocks.

declare module '@deepseek-ai/dsh-tools' {
  /** A rendered content block (the plugin only emits text). */
  export interface TextContentBlock {
    type: 'text'
    text: string
  }

  export type ContentBlock = TextContentBlock | { type: string; text?: string; [key: string]: unknown }

  /** The calling agent/session, when the tool runs inside one. */
  export interface ToolAgentRef {
    session?: { id?: string }
    [key: string]: unknown
  }

  /** Execution context handed to every `execute` body. */
  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly agent?: ToolAgentRef
    readonly toolCallId?: string
    [key: string]: unknown
  }

  /** One value-schema node of the author-facing DSL. */
  export type SchemaNode = {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
    description?: string
    title?: string
    default?: unknown
    examples?: unknown[]
    required?: boolean
    properties?: Record<string, SchemaNode>
    additionalProperties?: boolean
    items?: SchemaNode
    enum?: unknown[]
    const?: unknown
    oneOf?: SchemaNode[]
  }

  /** The definition accepted by `defineTool`. */
  export interface ToolDefinition<Args = Record<string, unknown>, Value = unknown> {
    name: string
    description: string
    parameters: Record<string, SchemaNode>
    output: {
      schema: SchemaNode
      render(args: Args, value: Value): ContentBlock[]
    }
    execute(args: Args, exec: ToolRunContext): Promise<Value> | Value
    [key: string]: unknown
  }

  export function defineTool<Args = Record<string, unknown>, Value = unknown>(
    options: ToolDefinition<Args, Value>,
  ): ToolDefinition<Args, Value>
}

// ── DSH config schema (`@deepseek-ai/schemastery`) ──────────────────────────
//
// Fluent schema builder used for the plugin's Loader row `Config`. Only the
// chainable methods used by this plugin are declared.

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = any> {
    default(value: T): Schema<T>
    description(text: string): Schema<T>
    step(value: number): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
    pattern(value: RegExp | string): Schema<T>
    role(value: string): Schema<T>
    hidden(): Schema<T>
    required(): Schema<T>
    comment(text: string): Schema<T>
    [key: string]: any
  }

  export interface SchemasteryStatic {
    <T = any>(inner?: unknown): Schema<T>
    object(shape?: Record<string, any>): Schema<Record<string, any>>
    dict(inner?: any): Schema<Record<string, any>>
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    array(inner?: any): Schema<any[]>
    union(types: any[]): Schema<any>
    intersect(types: any[]): Schema<any>
    const(value: any): Schema<any>
    any(): Schema<any>
    lazy(fn: () => Schema): Schema<any>
    [key: string]: any
  }

  const z: SchemasteryStatic
  export default z
}

// ── Local DSH host context (`Context` subset) ───────────────────────────────
//
// The host plugin receives a Cordis context. `inject = ['tools','connection']`
// guarantees the first two; `systemPrompt` and `logger` are looked up through
// `get()` because other deployments may omit them.

/** One browser-route registration accepted by `ctx.connection.fetch.register`. */
interface HostFetchRouteRegistration {
  path: string
  methods: string[]
  requestBody?: 'buffered' | 'stream'
  fetch: (request: Request) => Promise<Response> | Response
}

interface HostConnectionService {
  fetch: {
    register(
      registration: HostFetchRouteRegistration,
    ): (() => void) | Promise<unknown> | unknown
  }
}

/** Context the system-prompt service passes to a section's text callback. */
interface HostPromptSectionContext {
  scope?: unknown
  toolSet?: unknown
}

/** One ordered system-prompt section. */
interface HostPromptSection {
  name: string
  order: number
  text: string | ((context: HostPromptSectionContext) => string)
  interpolate?: boolean
}

interface HostSystemPromptService {
  section(section: HostPromptSection): unknown
  getSectionOrder(name: string): number
}

interface HostToolsService {
  register(tool: unknown): () => void
  /**
   * Registry lookup used by tool-guidance sections: `undefined` when the tool
   * is not visible to this agent/step (restricted away by a preset or mask).
   */
  get?(name: string, scope?: unknown, toolSet?: unknown): unknown
}

/** A Cordis effect callback: registers something and returns its disposer. */
type HostEffectCallback = () => unknown

/** The subset of the Cordis `Context` the `dsh-rdm` host half uses. */
interface HostContext {
  tools: HostToolsService
  connection?: HostConnectionService
  logger?: any
  effect(callback: HostEffectCallback, label?: string): () => void
  get<T = unknown>(name: string): T | undefined
  [key: string]: unknown
}
