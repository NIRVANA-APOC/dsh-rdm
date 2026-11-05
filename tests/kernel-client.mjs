// NDJSON client + process/filesystem helpers for the dsh-rdm kernel e2e suite.
//
// Wire contract: dsh-rdm/PROTOCOL.md — one UTF-8 JSON object per line on
// stdout (responses + notifications), request envelope {"id","method","params"},
// responses {"id","ok",...} possibly out of order, stderr is human logs only.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const RDM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The bundled kernel lives under bin/<platform>-<arch>/ (same layout the plugin
// resolves at runtime), so the suite finds a locally built binary on any host.
const KERNEL_FILE_NAME = process.platform === 'win32' ? 'rdm-kernel.exe' : 'rdm-kernel'
export const DEFAULT_KERNEL_PATH = path.join(
  RDM_ROOT,
  'bin',
  `${process.platform}-${process.arch}`,
  KERNEL_FILE_NAME,
)

// This host denies the kernel process writing under %LOCALAPPDATA%\Temp (os.tmpdir())
// — `create_dir_all(<data-dir>/tasks)` fails with ACCESS_DENIED (os error 5) when the
// data dir lives in Temp, while workspace-owned dirs work. All kernel data dirs and
// download dirs therefore live under a workspace-owned temp root, never os.tmpdir().
export const TEST_TMP_ROOT = process.env.DSH_RDM_TEST_TMP_ROOT || path.join(RDM_ROOT, 'tests', '.tmp-e2e')

export async function ensureTestTmpRoot() {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true })
  return TEST_TMP_ROOT
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fsp.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export async function makeTempDir(prefix) {
  await ensureTestTmpRoot()
  return fs.mkdtemp(path.join(TEST_TMP_ROOT, prefix))
}

export async function removeDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (attempt === 5) throw err
      await sleep(100)
    }
  }
}

export async function listDir(dir) {
  try {
    return (await fs.readdir(dir)).sort()
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export async function pathExists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

export async function fileSize(p) {
  const stat = await fs.stat(p)
  return stat.size
}

export function round(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Poll an async predicate until truthy or deadline; returns the value. */
export async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  let lastError
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch (err) {
      lastError = err
      last = undefined
    }
    if (last) return last
    await sleep(intervalMs)
  }
  const suffix = lastError ? ` (last error: ${lastError.message})` : ''
  throw new Error(`pollUntil timed out after ${timeoutMs}ms waiting for ${label}${suffix}`)
}

// ── error types ─────────────────────────────────────────────────────────────

export class KernelRpcError extends Error {
  constructor(code, message, { method = null, raw = null } = {}) {
    super(message ? `${code}: ${message}` : String(code))
    this.name = 'KernelRpcError'
    this.code = code
    this.kernelMessage = message
    this.method = method
    this.raw = raw
  }
}

export class KernelTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`request ${method} timed out after ${timeoutMs}ms`)
    this.name = 'KernelTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class KernelExitError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'KernelExitError'
    this.details = details
  }
}

const METHOD_TIMEOUTS = {
  initialize: 10000,
  probe: 30000,
  start: 10000,
  list: 10000,
  get: 10000,
  control: 20000,
  stats: 10000,
  shutdown: 8000,
}

/**
 * One live kernel child process speaking NDJSON on stdio.
 */
export class NdjsonKernel {
  /**
   * @param {string} kernelPath absolute executable path
   * @param {object} options
   * @param {string} options.dataDir absolute kernel data dir
   * @param {string} [options.logLevel] --log-level value, default 'warn'
   * @param {string[]} [options.extraArgs]
   * @param {string} [options.label] label for diagnostics
   */
  constructor(kernelPath, options = {}) {
    this.kernelPath = kernelPath
    this.dataDir = options.dataDir
    this.logLevel = options.logLevel ?? 'warn'
    this.extraArgs = options.extraArgs ?? []
    this.label = options.label ?? 'kernel'
    this.child = null
    this.pid = null
    this.ready = null
    this.exited = { code: null, signal: null, at: null }
    this.notifications = []
    this.stderrLines = []
    this.parseErrors = []
    this.orphanResponses = []
    this.pending = new Map()
    this.requestSeq = 0
    this._stdoutBuffer = ''
    this._exitPromise = null
    this._exitResolve = null
    this._readyWaiters = []
    this._notificationWaiters = []
    this._stdoutEnded = false
  }

  async launch({ readyTimeoutMs = 10000 } = {}) {
    this.child = spawn(this.kernelPath, ['--data-dir', this.dataDir, '--log-level', this.logLevel, ...this.extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.pid = this.child.pid ?? null
    this._exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.child.stdout.on('end', () => {
      this._stdoutEnded = true
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => this._onStderr(chunk))
    this.child.on('error', (err) => {
      for (const waiter of this._readyWaiters.splice(0)) waiter.reject(err)
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new KernelExitError(`kernel failed to run: ${err.message}`))
      }
      this.pending.clear()
      this._exitResolve?.({ code: null, signal: null, error: err })
    })
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal, at: Date.now() }
      for (const waiter of this._readyWaiters.splice(0)) {
        waiter.reject(new KernelExitError(`kernel exited before ready (code=${code}, signal=${signal})`))
      }
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(
          new KernelExitError(
            `kernel exited while awaiting ${entry.method} (code=${code}, signal=${signal})`,
            { code, signal, stderrTail: this.stderrTail(20) },
          ),
        )
      }
      this.pending.clear()
      this._exitResolve?.({ code, signal })
    })
    if (readyTimeoutMs > 0) await this.waitReady(readyTimeoutMs)
    return this
  }

  _onStdout(chunk) {
    this._stdoutBuffer += chunk
    let newlineIndex = this._stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this._stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '')
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1)
      if (line.length > 0) this._handleLine(line)
      newlineIndex = this._stdoutBuffer.indexOf('\n')
    }
  }

  _handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      this.parseErrors.push({ line, error: err.message })
      return
    }
    if (msg === null || typeof msg !== 'object') {
      this.parseErrors.push({ line, error: 'not a JSON object' })
      return
    }
    if (typeof msg.id === 'string' && (msg.ok === true || msg.ok === false) && !msg.event) {
      const entry = this.pending.get(msg.id)
      if (!entry) {
        this.orphanResponses.push(msg)
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok) entry.resolve(msg.result ?? {})
      else entry.reject(new KernelRpcError(msg.error?.code ?? 'unknown', msg.error?.message ?? '', { method: entry.method, raw: msg }))
      return
    }
    if (typeof msg.event === 'string') {
      const notification = { at: performance.now(), event: msg.event, raw: msg }
      this.notifications.push(notification)
      if (this.notifications.length > 4000) this.notifications.splice(0, 1000)
      if (msg.event === 'ready') {
        this.ready = msg
        for (const waiter of this._readyWaiters.splice(0)) waiter.resolve(msg)
      }
      for (const waiter of this._notificationWaiters.splice(0)) {
        try {
          if (waiter.predicate(notification)) {
            waiter.resolve(notification)
            continue
          }
        } catch (err) {
          waiter.reject(err)
          continue
        }
        this._notificationWaiters.push(waiter)
      }
      return
    }
    this.parseErrors.push({ line, error: 'unknown message shape' })
  }

  _onStderr(chunk) {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue
      this.stderrLines.push(line)
      if (this.stderrLines.length > 5000) this.stderrLines.splice(0, 1000)
    }
  }

  stderrTail(n = 30) {
    return this.stderrLines.slice(-n)
  }

  waitReady(timeoutMs = 15000) {
    if (this.ready) return Promise.resolve(this.ready)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._readyWaiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this._readyWaiters.splice(idx, 1)
        reject(new Error(`kernel ready notification not received within ${timeoutMs}ms; stderr=${JSON.stringify(this.stderrTail(10))}`))
      }, timeoutMs)
      this._readyWaiters.push({
        timer,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  waitForNotification(predicate, timeoutMs = 10000, { fromIndex = 0, label = 'notification' } = {}) {
    for (let i = fromIndex; i < this.notifications.length; i += 1) {
      const notification = this.notifications[i]
      if (predicate(notification)) return Promise.resolve(notification)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._notificationWaiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this._notificationWaiters.splice(idx, 1)
        reject(new Error(`waitForNotification(${label}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._notificationWaiters.push({
        timer,
        predicate,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  request(method, params = {}, { timeoutMs } = {}) {
    if (!this.child || this.child.exitCode !== null || this.exited.at) {
      return Promise.reject(new KernelExitError(`cannot send ${method}: kernel is not running`))
    }
    const id = `q${++this.requestSeq}`
    const effectiveTimeout = timeoutMs ?? METHOD_TIMEOUTS[method] ?? 15000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new KernelTimeoutError(method, effectiveTimeout))
      }, effectiveTimeout)
      this.pending.set(id, { resolve, reject, timer, method })
      const line = `${JSON.stringify({ id, method, params })}\n`
      try {
        this.child.stdin.write(line)
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new KernelExitError(`failed to write ${method} to kernel stdin: ${err.message}`))
      }
    })
  }

  /** Convenience wrappers. */
  initialize(params = {}) {
    return this.request('initialize', params)
  }
  stats() {
    return this.request('stats')
  }
  probe(params) {
    return this.request('probe', params)
  }
  start(spec) {
    return this.request('start', spec)
  }
  list(params = {}) {
    return this.request('list', params)
  }
  async get(id, events = 100) {
    return this.request('get', { id, events })
  }
  wait(ids, timeoutMs = 120000) {
    return this.request('wait', { ids, timeoutMs }, { timeoutMs: timeoutMs + 10000 })
  }
  control(id, action, params = {}) {
    return this.request('control', { id, action, ...params })
  }

  /** Wait via the kernel `wait` method, then poll get() if wait timed out. */
  async waitTerminal(id, timeoutMs = 120000) {
    let waitResult
    try {
      waitResult = await this.wait([id], timeoutMs)
    } catch (err) {
      // If `wait` itself is unavailable/broken, fall back to polling but keep
      // the error available to callers via the returned diagnostics.
      const task = await this.pollTask(id, timeoutMs)
      return { task, waitResult: null, waitError: err }
    }
    const task = waitResult.tasks?.find((t) => t.id === id) ?? null
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      return { task, waitResult, waitError: null }
    }
    const polled = await this.pollTask(id, timeoutMs)
    return { task: polled, waitResult, waitError: null }
  }

  pollTask(id, timeoutMs = 120000, intervalMs = 100) {
    return pollUntil(
      async () => {
        const { task } = await this.get(id, 0)
        return ['completed', 'failed', 'cancelled'].includes(task.status) ? task : null
      },
      { timeoutMs, intervalMs, label: `task ${id} terminal status` },
    )
  }

  async waitTaskStatus(id, statuses, timeoutMs = 60000, intervalMs = 50) {
    return pollUntil(
      async () => {
        const { task } = await this.get(id, 0)
        return statuses.includes(task.status) ? task : null
      },
      { timeoutMs, intervalMs, label: `task ${id} in ${statuses.join('|')}` },
    )
  }

  /** Persist final stderr/stdout state, close stdin, wait for exit; kill if needed. */
  async close({ timeoutMs = 8000 } = {}) {
    if (!this.child || this.exited.at) return this.exited
    try {
      this.child.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      return await this.waitExit(timeoutMs)
    } catch {
      return this.kill()
    }
  }

  async shutdown({ timeoutMs = 8000 } = {}) {
    try {
      await this.request('shutdown', {}, { timeoutMs: 5000 })
    } catch {
      /* kernel may exit before replying; fall through to close */
    }
    return this.close({ timeoutMs })
  }

  waitExit(timeoutMs = 10000) {
    if (this.exited.at) return Promise.resolve(this.exited)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`kernel did not exit within ${timeoutMs}ms; stderr=${JSON.stringify(this.stderrTail(10))}`))
      }, timeoutMs)
      this._exitPromise.then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }

  async kill({ timeoutMs = 5000 } = {}) {
    if (!this.child || this.exited.at) return this.exited
    try {
      this.child.kill()
    } catch {
      /* ignore */
    }
    try {
      return await this.waitExit(timeoutMs)
    } catch {
      if (this.pid) {
        try {
          execFileSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          /* ignore */
        }
      }
      try {
        return await this.waitExit(timeoutMs)
      } catch {
        return { code: null, signal: 'unconfirmed', at: Date.now() }
      }
    }
  }

  taskNotifications(id) {
    return this.notifications.filter((n) => n.event === 'task' && n.raw.task?.id === id)
  }
}

/** Launch helper: spawn + await ready. */
export async function launchKernel(kernelPath, options = {}) {
  const kernel = new NdjsonKernel(kernelPath, options)
  await kernel.launch(options)
  return kernel
}

export function hasKernelBinary(kernelPath = DEFAULT_KERNEL_PATH) {
  return fsp.existsSync(kernelPath)
}
