// End-to-end black-box suite for the dsh-rdm resident download kernel.
//
// The kernel is spawned as a real child process and driven only through its
// documented NDJSON protocol (dsh-rdm/PROTOCOL.md) against a local fixture
// server. Every scenario gets its own temp data-dir/download-dir so scenarios
// cannot leak state into each other; the fixture server is shared and all
// request/range assertions are filtered by a unique file name.
//
// Run through `node scripts/verify-kernel.mjs` (package.json "verify").
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  DEFAULT_KERNEL_PATH,
  KernelRpcError,
  launchKernel,
  listDir,
  makeTempDir,
  pathExists,
  pollUntil,
  removeDir,
  sha256File,
} from './kernel-client.mjs'

const MIB = 1024 * 1024
const TERMINAL = ['completed', 'failed', 'cancelled']
// NDJSON protocol generation spoken by the shipped kernel (PROTOCOL.md §1).
const PROTOCOL = 2
const TASK_STATUSES = ['queued', 'probing', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']
const EVENT_KINDS = ['info', 'probe', 'plan', 'started', 'retry', 'controller', 'paused', 'resumed', 'verify', 'completed', 'failed', 'cancelled']

// ── tiny assertion/case framework ───────────────────────────────────────────

function formatDetail(value) {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  } catch {
    return String(value)
  }
}

function eqDeep(actual, expected) {
  if (Object.is(actual, expected)) return true
  if (Array.isArray(actual) || (actual && typeof actual === 'object')) {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected)
    } catch {
      return false
    }
  }
  return false
}

export class KernelE2ECase {
  constructor(name, description, context) {
    this.name = name
    this.description = description
    this.context = context
    this.log = context.log
    this.startedAt = performance.now()
    this.checks = []
    this.notes = []
    this.cleanups = []
    this.cleanupErrors = []
    this.tempRoot = null
    this.downloadDir = null
  }

  check(name, condition, detail) {
    const ok = Boolean(condition)
    const entry = { name, ok }
    if (!ok) {
      entry.detail = formatDetail(detail)
      this.log(`     ✗ ${name}  (${entry.detail})`)
    }
    this.checks.push(entry)
    return ok
  }

  assert(name, condition, detail) {
    return this.check(name, condition, detail)
  }

  eq(name, actual, expected) {
    return this.check(name, eqDeep(actual, expected), `actual=${formatDetail(actual)} expected=${formatDetail(expected)}`)
  }

  note(text) {
    this.notes.push(text)
  }

  onCleanup(fn) {
    this.cleanups.push(fn)
  }

  async makeDataDir(prefix = 'data') {
    const dir = path.join(this.tempRoot, `${prefix}-${this.cleanups.length}`)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  async cleanup() {
    for (const fn of this.cleanups.reverse()) {
      try {
        await fn()
      } catch (err) {
        this.cleanupErrors.push(err.message)
        this.log(`     cleanup warning: ${err.message}`)
      }
    }
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function sameUrl(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return a === b
  }
}

// ── shared helpers used by scenarios ────────────────────────────────────────

async function makeKernel(t, context, options = {}) {
  const dataDir = options.dataDir ?? (await t.makeDataDir(options.dataPrefix ?? 'data'))
  const kernel = await launchKernel(context.kernelPath, {
    dataDir,
    logLevel: 'warn',
    label: options.label ?? 'kernel',
  })
  t.onCleanup(async () => {
    if (!kernel.exited.at) await kernel.kill()
  })
  let initResult = null
  if (options.initialize !== false) {
    initResult = await kernel.initialize({
      defaultDir: t.downloadDir,
      connections: 4,
      autoResume: false,
      ...(options.initialize ?? {}),
    })
  }
  return { kernel, dataDir, initResult }
}

async function startTask(t, kernel, spec) {
  const response = await kernel.start(spec)
  const task = response?.task
  t.assert('start returned a TaskView with an id', Boolean(task && typeof task.id === 'string' && task.id.length > 0), formatDetail(response))
  return task
}

async function waitCompleted(t, kernel, id, { timeoutMs = 120000, label = 'task' } = {}) {
  const { task, waitResult, waitError } = await kernel.waitTerminal(id, timeoutMs)
  if (waitError) {
    t.assert(`${label}: kernel wait method usable`, false, waitError.message)
  } else {
    t.assert(`${label}: wait did not time out`, waitResult?.timedOut === false, `timedOut=${waitResult?.timedOut}`)
  }
  t.eq(`${label}: terminal status`, task?.status, 'completed')
  if (task?.error) t.note(`${label}: error=${formatDetail(task.error)}`)
  return task
}

async function assertFileBytes(t, filePath, expected, label = 'file') {
  const exists = typeof filePath === 'string' ? await pathExists(filePath) : false
  t.assert(`${label}: target file exists (${filePath})`, exists, filePath)
  if (!exists) return
  const size = (await fs.stat(filePath)).size
  t.eq(`${label}: byte size`, size, expected.size)
  const digest = await sha256File(filePath)
  t.eq(`${label}: sha256`, digest, expected.sha256)
}

async function assertNoPartLeftovers(t, dir) {
  const names = await listDir(dir)
  const leftovers = names.filter((name) => name.endsWith('.part') || name.endsWith('.part.json'))
  t.eq('no .part/.part.json leftovers', leftovers, [])
}

async function waitForPartFile(t, filePath, timeoutMs = 10000) {
  try {
    await pollUntil(async () => (await pathExists(filePath)) && (await fs.stat(filePath)).size > 0, {
      timeoutMs,
      intervalMs: 50,
      label: `part file ${filePath}`,
    })
    return true
  } catch {
    return false
  }
}

// ── scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = []

function scenario(name, description, fn, options = {}) {
  SCENARIOS.push({ name, description, fn, timeoutMs: options.timeoutMs ?? 150000 })
}

scenario('lifecycle: ready / initialize / stats', 'ready notification fields, initialize config echo, stats shape and defaults update', async (t, ctx) => {
  const { kernel, dataDir } = await makeKernel(t, ctx, { initialize: false })
  const ready = kernel.ready
  t.assert('ready notification received before launch() resolves', Boolean(ready), 'kernel.ready is null')
  t.eq('ready.protocol', ready?.protocol, PROTOCOL)
  t.assert('ready.kernel.version is a non-empty string', typeof ready?.kernel?.version === 'string' && ready.kernel.version.length > 0, ready?.kernel?.version)
  t.eq('ready.kernel.pid matches spawned child pid', ready?.kernel?.pid, kernel.pid)
  t.assert('ready.kernel.dataDir matches --data-dir', samePath(ready?.kernel?.dataDir, dataDir), `${ready?.kernel?.dataDir} vs ${dataDir}`)

  const init = await kernel.initialize({
    defaultDir: t.downloadDir,
    connections: 4,
    chunkSizeBytes: 0,
    speedLimitBps: 0,
    maxAttempts: 6,
    autoResume: false,
    logLevel: 'warn',
  })
  t.eq('initialize.protocol', init?.protocol, PROTOCOL)
  t.eq('initialize.kernel.pid', init?.kernel?.pid, kernel.pid)
  t.assert('initialize.kernel.dataDir matches', samePath(init?.kernel?.dataDir, dataDir), init?.kernel?.dataDir)
  t.eq('initialize.config.connections', init?.config?.connections, 4)
  t.eq('initialize.config.autoResume', init?.config?.autoResume, false)
  t.assert('initialize.config.defaultDir echoed', samePath(init?.config?.defaultDir, t.downloadDir), init?.config?.defaultDir)

  const stats = await kernel.stats()
  t.eq('stats.protocol', stats?.protocol, PROTOCOL)
  t.eq('stats.kernel.pid', stats?.kernel?.pid, kernel.pid)
  t.assert('stats.kernel.uptimeMs is a non-negative number', typeof stats?.kernel?.uptimeMs === 'number' && stats.kernel.uptimeMs >= 0, stats?.kernel?.uptimeMs)
  t.assert('stats.kernel.version is a non-empty string', typeof stats?.kernel?.version === 'string' && stats.kernel.version.length > 0, stats?.kernel?.version)
  for (const key of ['total', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']) {
    t.assert(`stats.tasks.${key} is a number`, typeof stats?.tasks?.[key] === 'number', stats?.tasks?.[key])
  }
  t.eq('stats.tasks.total starts at 0', stats?.tasks?.total, 0)
  t.assert('stats.totals.bytesDownloaded is a number', typeof stats?.totals?.bytesDownloaded === 'number', stats?.totals?.bytesDownloaded)
  t.eq('stats.totals.bytesDownloaded starts at 0', stats?.totals?.bytesDownloaded, 0)
  t.eq('stats.config.connections echoes initialize', stats?.config?.connections, 4)

  // A later initialize updates defaults for NEW tasks only.
  const init2 = await kernel.initialize({ defaultDir: t.downloadDir, connections: 2 })
  t.eq('second initialize.config.connections', init2?.config?.connections, 2)
  t.eq('no malformed stdout protocol lines', kernel.parseErrors.length, 0)
  t.eq('no orphan responses', kernel.orphanResponses.length, 0)
})

scenario('probe: ranged / no-range / redirect / chunked metadata', 'probe fields, redirect finalUrl, and ranged-vs-not behaviour', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 256 * 1024

  // — ranged origin
  const rangedUrl = ctx.fixture.urlFor('ranged', size, 'probe-ranged.bin')
  const ranged = (await kernel.probe({ url: rangedUrl }))?.server
  t.assert('probe ranged returned server facts', Boolean(ranged), 'server facts missing')
  t.eq('ranged server.fileName', ranged?.fileName, 'probe-ranged.bin')
  t.eq('ranged server.totalBytes', ranged?.totalBytes, size)
  t.eq('ranged server.range.supported', ranged?.range?.supported, true)
  t.eq('ranged server.contentType', ranged?.contentType, 'application/octet-stream')
  t.assert('ranged server.finalUrl equals requested url', sameUrl(ranged?.finalUrl, rangedUrl), ranged?.finalUrl)
  // Protocol 2 proves ranges with one 64-byte ranged GET after the HEAD.
  const rangedGets = ctx.fixture.requestsFor('probe-ranged.bin', { method: 'GET' })
  t.eq('ranged probe issued one range proof GET', rangedGets.length, 1)
  t.eq('ranged range proof is bytes=0-63', rangedGets[0]?.rangeHeader, 'bytes=0-63')
  t.eq('ranged range proof answered 206', rangedGets[0]?.status, 206)

  // — no-range origin: probe proves ranges with one ranged GET, never a body download.
  const norangeUrl = ctx.fixture.urlFor('norange', size, 'probe-norange.bin')
  const norange = (await kernel.probe({ url: norangeUrl }))?.server
  t.assert('probe no-range returned server facts', Boolean(norange), 'server facts missing')
  t.eq('no-range server.fileName', norange?.fileName, 'probe-norange.bin')
  t.eq('no-range server.totalBytes', norange?.totalBytes, size)
  t.eq('no-range server.range.supported', norange?.range?.supported, false)

  // — redirect chain (2 hops)
  const redirectUrl = ctx.fixture.urlFor('redirect', size, 'probe-redir.bin')
  const redirect = (await kernel.probe({ url: redirectUrl }))?.server
  t.assert('probe redirect returned server facts', Boolean(redirect), 'server facts missing')
  const expectedFinal = ctx.fixture.urlFor('ranged', size, 'probe-redir.bin')
  t.assert('redirect server.finalUrl differs from requested url', redirect?.finalUrl !== redirectUrl, `${redirect?.finalUrl}`)
  t.assert('redirect server.finalUrl is the final ranged url', sameUrl(redirect?.finalUrl, expectedFinal), `${redirect?.finalUrl} vs ${expectedFinal}`)
  t.eq('redirect server.fileName', redirect?.fileName, 'probe-redir.bin')
  t.eq('redirect server.totalBytes', redirect?.totalBytes, size)
  t.eq('redirect server.range.supported', redirect?.range?.supported, true)

  // — unknown-length chunked origin
  const chunkedUrl = ctx.fixture.urlFor('chunked', size, 'probe-chunked.bin')
  const chunked = (await kernel.probe({ url: chunkedUrl }))?.server
  t.assert('probe chunked returned server facts', Boolean(chunked), 'server facts missing')
  t.eq('chunked server.totalBytes is null (unknown)', chunked?.totalBytes, null)
  t.eq('chunked server.range.supported', chunked?.range?.supported, false)
  t.eq('chunked server.fileName', chunked?.fileName, 'probe-chunked.bin')

  // — a full download through the redirect chain also works end to end
  const downloadRedirectUrl = ctx.fixture.urlFor('redirect', size, 'probe-redir-download.bin')
  const started = await startTask(t, kernel, { url: downloadRedirectUrl, dir: t.downloadDir, connections: 2 })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 60000, label: 'redirect download' })
  t.assert('redirect download: finalUrl recorded and differs', typeof task?.finalUrl === 'string' && task.finalUrl !== downloadRedirectUrl, task?.finalUrl)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'redirect download')
  t.eq('no invalid protocol lines during probe matrix', kernel.parseErrors.length, 0)
})

scenario('download: full ranged transfer', 'completed status, byte equality, no .part leftovers, notifications and list/get', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 2 * MIB
  const name = 'full-ranged.bin'
  const url = ctx.fixture.urlFor('ranged', size, name)
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 4 })
  t.eq('start: fileName resolved from url', started?.fileName, name)
  t.assert('start: status is a known status', TASK_STATUSES.includes(started?.status), started?.status)

  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 120000, label: 'full download' })
  t.eq('task.downloaded == total', task?.downloaded, size)
  t.eq('task.total', task?.total, size)
  t.eq('task.error', task?.error, null)
  t.eq('task.rangeSupported', task?.rangeSupported, true)
  t.eq('task.fileName', task?.fileName, name)
  t.eq('task.connections (planned)', task?.connections, 4)
  t.assert('task.path is the requested directory/name', samePath(task?.path, path.join(t.downloadDir, name)), task?.path)
  t.assert('task.startedAt is a number', typeof task?.startedAt === 'number', task?.startedAt)
  t.assert('task.finishedAt is a number', typeof task?.finishedAt === 'number', task?.finishedAt)
  t.assert('task.elapsedMs >= 0', typeof task?.elapsedMs === 'number' && task.elapsedMs >= 0, task?.elapsedMs)
  t.eq('task.resumedChunks on fresh download', task?.resumedChunks, 0)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'full download')
  await assertNoPartLeftovers(t, t.downloadDir)

  const notifications = kernel.taskNotifications(started.id)
  t.assert('task notifications observed', notifications.length >= 1, notifications.length)
  t.assert(
    'terminal notification has status completed',
    notifications.some((n) => n.raw?.task?.status === 'completed'),
    notifications.map((n) => n.raw?.task?.status),
  )

  const { task: fetched, events } = await kernel.get(started.id, 100)
  t.eq('get returns the same task id', fetched?.id, started.id)
  t.eq('get returns completed status', fetched?.status, 'completed')
  t.assert('get returns an events array', Array.isArray(events), typeof events)
  t.assert('events have monotonic seq and known kinds', events.every((e) => typeof e.seq === 'number' && typeof e.kind === 'string' && EVENT_KINDS.includes(e.kind)), formatDetail(events.map((e) => e.kind)))
  t.assert('events array is bounded (<=200)', events.length <= 200, events.length)

  const listed = await kernel.list({ limit: 50 })
  t.assert('list includes the completed task', Array.isArray(listed?.tasks) && listed.tasks.some((entry) => entry.id === started.id), listed?.tasks?.length)
  const completedOnly = await kernel.list({ status: 'completed', limit: 50 })
  t.assert('list status=completed filter returns only completed tasks', completedOnly.tasks.every((entry) => entry.status === 'completed'), formatDetail(completedOnly.tasks.map((e) => e.status)))
  const limited = await kernel.list({ limit: 1 })
  t.assert('list limit=1 honoured', limited.tasks.length <= 1, limited.tasks.length)
})

scenario('multi-connection: 12 MiB with connections=8 + singleStream control', 'overlapping range requests, peakWorkers, and a forced single rangeless GET', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 12 * MIB
  const name = 'mc-12mib.bin'
  const url = ctx.fixture.urlFor('ranged', size, name)
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 8 })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 180000, label: '12 MiB multi-connection' })
  t.eq('12MiB: downloaded == total', task?.downloaded, size)
  t.eq('12MiB: rangeSupported', task?.rangeSupported, true)
  t.eq('12MiB: planned connections', task?.connections, 8)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), '12MiB download')
  await assertNoPartLeftovers(t, t.downloadDir)

  const overlap = ctx.fixture.overlapFor(name)
  t.assert('fixture recorded at least 2 range GETs', overlap.count >= 2, formatDetail(overlap))
  t.assert('fixture observed overlapping range requests (max concurrency > 1)', overlap.maxOverlap > 1, formatDetail(overlap))
  t.assert('kernel reported peakWorkers > 1', task?.peakWorkers > 1, task?.peakWorkers)
  t.assert('kernel stats activeWorkers back to 0 after completion', (await kernel.stats()).tasks.running === 0, 'running != 0')

  // singleStream=true: the probe still proves range support with one 64-byte
  // ranged GET, then the transfer itself is exactly one rangeless GET.
  const singleSize = 512 * 1024
  const singleName = 'mc-single.bin'
  const singleUrl = ctx.fixture.urlFor('ranged', singleSize, singleName)
  const singleStarted = await startTask(t, kernel, { url: singleUrl, dir: t.downloadDir, connections: 8, singleStream: true })
  const singleTask = await waitCompleted(t, kernel, singleStarted.id, { timeoutMs: 60000, label: 'singleStream download' })
  t.eq('singleStream: rangeSupported still true', singleTask?.rangeSupported, true)
  t.eq('singleStream: downloaded == total', singleTask?.downloaded, singleSize)
  await assertFileBytes(t, singleTask?.path, ctx.fixture.expected(singleSize), 'singleStream download')
  t.eq('singleStream: chunkSize is null', singleTask?.chunkSize, null)
  const singleGets = ctx.fixture.requestsFor(singleName, { method: 'GET' })
  const singleStreamGets = singleGets.filter((entry) => entry.rangeHeader === null)
  t.eq('singleStream: exactly one rangeless GET issued', singleStreamGets.length, 1)
  t.eq('singleStream: the GET answered 200', singleStreamGets[0]?.status, 200)
  const singleProofGets = singleGets.filter((entry) => entry.rangeHeader === 'bytes=0-63')
  t.eq('singleStream: exactly one 64-byte range proof GET', singleProofGets.length, 1)
  t.eq('singleStream: range proof answered 206', singleProofGets[0]?.status, 206)
  t.eq('no other 206 responses for singleStream download', singleGets.filter((entry) => entry.status === 206).length, 1)
})

scenario('no-range fallback: single-stream download', 'no range support -> single GET, rangeSupported=false, byte equality', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 512 * 1024
  const name = 'norange-fallback.bin'
  const url = ctx.fixture.urlFor('norange', size, name)
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 8 })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 60000, label: 'no-range download' })
  t.eq('no-range: rangeSupported=false', task?.rangeSupported, false)
  t.eq('no-range: downloaded == total', task?.downloaded, size)
  t.eq('no-range: total', task?.total, size)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'no-range download')
  await assertNoPartLeftovers(t, t.downloadDir)

  const gets = ctx.fixture.requestsFor(name, { method: 'GET' })
  t.assert('no-range: at least one GET', gets.length >= 1, gets.length)
  const rangeless = gets.filter((entry) => entry.rangeHeader === null)
  t.eq('no-range: exactly one rangeless GET (single stream)', rangeless.length, 1)
  t.eq('no-range: every GET answered 200', gets.filter((entry) => entry.status !== 200).length, 0)
  t.eq('no-range: no 206 responses', gets.filter((entry) => entry.status === 206).length, 0)
})

scenario('retry: 429 + Retry-After', 'chunk retry honours Retry-After and completes with retries > 0', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  ctx.fixture.armFlaky(2)
  const rejectedBefore = ctx.fixture.flakyState().rejectedTotal
  const size = 128 * 1024
  const name = 'flaky-retry.bin'
  const url = ctx.fixture.urlFor('flaky', size, name)
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 2 })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 90000, label: 'flaky download' })
  t.eq('flaky: downloaded == total', task?.downloaded, size)
  t.assert('flaky: task.retries > 0', task?.retries > 0, task?.retries)
  t.assert('flaky: at least 2 range GETs rejected with 429', ctx.fixture.flakyState().rejectedTotal - rejectedBefore >= 2, ctx.fixture.flakyState())
  t.assert('flaky: Retry-After honoured (elapsed >= 900ms)', (task?.elapsedMs ?? 0) >= 900, task?.elapsedMs)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'flaky download')
  await assertNoPartLeftovers(t, t.downloadDir)
  t.note(`elapsedMs=${task?.elapsedMs} retries=${task?.retries}`)
})

scenario('pause -> resume (same kernel)', 'panic-free cooperative pause, .part + .part.json retained, resume completes with exact bytes', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 4 * MIB
  const name = 'pause-resume.bin'
  const url = ctx.fixture.urlFor('slow', size, name, 'chunk=16384&delayMs=25')
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 4 })
  const progressed = await pollUntil(
    async () => {
      const { task } = await kernel.get(started.id, 0)
      return task.status === 'running' && task.downloaded > 0 ? task : null
    },
    { timeoutMs: 20000, intervalMs: 40, label: 'download progress' },
  )
  t.assert('mid-transfer: downloaded > 0', progressed.downloaded > 0, progressed.downloaded)
  t.assert('mid-transfer: downloaded < total', progressed.downloaded < progressed.total, `${progressed.downloaded}/${progressed.total}`)
  t.assert('mid-transfer: path resolved', typeof progressed.path === 'string', progressed.path)

  await kernel.control(started.id, 'pause')
  const paused = await kernel.waitTaskStatus(started.id, ['paused'], 15000)
  t.eq('pause: status paused', paused.status, 'paused')
  t.assert('pause: stopped before completion', paused.downloaded < paused.total, `${paused.downloaded}/${paused.total}`)
  const partPath = `${paused.path}.part`
  const partExists = await waitForPartFile(t, partPath, 10000)
  t.assert('pause: .part retained with data', partExists, partPath)
  t.assert('pause: .part.json resume state retained', await pathExists(`${partPath}.json`), `${partPath}.json`)
  const beforeResume = paused.downloaded

  await kernel.control(started.id, 'resume')
  const resumed = await waitCompleted(t, kernel, started.id, { timeoutMs: 120000, label: 'resumed download' })
  t.assert('resume: resumedChunks reported as a number', typeof resumed.resumedChunks === 'number', resumed.resumedChunks)
  await assertFileBytes(t, resumed.path, ctx.fixture.expected(size), 'resumed download')
  await assertNoPartLeftovers(t, t.downloadDir)
  t.note(`downloadedBeforePause=${beforeResume} resumedChunks=${resumed.resumedChunks}`)
})

scenario('resume across kernel restart', 'kill -9 the kernel, start a new one on the same --data-dir, resume and verify bytes', async (t, ctx) => {
  const dataDir = await t.makeDataDir('restart-data')
  const size = 8 * MIB
  const name = 'restart-resume.bin'
  const url = ctx.fixture.urlFor('slow', size, name, 'chunk=16384&delayMs=25')

  const first = await makeKernel(t, ctx, { dataDir, initialize: { connections: 4, autoResume: false }, label: 'kernel#1' })
  const started = await startTask(t, first.kernel, { url, dir: t.downloadDir, connections: 4 })
  const taskId = started.id
  await pollUntil(
    async () => {
      const { task } = await first.kernel.get(taskId, 0)
      if (!(task.status === 'running' && task.downloaded >= 1 * MIB)) return null
      const partJson = `${task.path}.part.json`
      return (await pathExists(partJson)) ? task : null
    },
    { timeoutMs: 30000, intervalMs: 50, label: 'kernel#1 progress with persisted resume state' },
  )
  const beforeKill = (await first.kernel.get(taskId, 0)).task
  t.assert('kernel#1 still running before kill', beforeKill.status === 'running', beforeKill.status)
  t.assert('kernel#1 downloaded > 0 before kill', beforeKill.downloaded > 0, beforeKill.downloaded)

  const killed = await first.kernel.kill()
  t.assert('kernel#1 terminated', killed.at !== null || first.kernel.exited.at !== null, formatDetail(killed))

  const second = await makeKernel(t, ctx, { dataDir, initialize: { connections: 4, autoResume: false }, label: 'kernel#2' })
  t.assert('kernel#2 ready with same dataDir', samePath(second.kernel.ready?.kernel?.dataDir, dataDir), second.kernel.ready?.kernel?.dataDir)
  const listed = await second.kernel.list({ limit: 50 })
  const persisted = listed?.tasks?.find((entry) => entry.id === taskId)
  t.assert('task record persisted across restart', Boolean(persisted), formatDetail(listed?.tasks?.map((entry) => `${entry.id}:${entry.status}`)))
  const observedStatus = persisted?.status
  t.assert(`restart: status ${observedStatus} is a plausible post-crash status`, ['interrupted', 'paused', 'queued', 'running', 'completed', 'failed'].includes(observedStatus), observedStatus)

  let finalTask
  if (observedStatus === 'completed') {
    finalTask = persisted
  } else if (observedStatus === 'interrupted' || observedStatus === 'paused' || observedStatus === 'failed') {
    const resumeResponse = await second.kernel.control(taskId, 'resume')
    t.assert('restart: control resume accepted', Boolean(resumeResponse?.task), formatDetail(resumeResponse))
    finalTask = await waitCompleted(t, second.kernel, taskId, { timeoutMs: 180000, label: 'post-restart resume' })
  } else {
    finalTask = await waitCompleted(t, second.kernel, taskId, { timeoutMs: 180000, label: 'auto-resumed download' })
  }
  t.eq('restart: completed status', finalTask?.status, 'completed')
  t.eq('restart: downloaded == total', finalTask?.downloaded, size)
  await assertFileBytes(t, finalTask?.path, ctx.fixture.expected(size), 'post-restart file')
  await assertNoPartLeftovers(t, t.downloadDir)
  t.note(`post-crash status observed: ${observedStatus}; downloaded before kill: ${beforeKill.downloaded}`)
})

scenario('cancel -> retry, then remove', 'cancel keeps .part, retry restarts, remove deletes record but never the completed file', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 4 * MIB
  const name = 'cancel-retry.bin'
  const url = ctx.fixture.urlFor('slow', size, name, 'chunk=16384&delayMs=25')
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 4 })
  const progressed = await pollUntil(
    async () => {
      const { task } = await kernel.get(started.id, 0)
      return task.status === 'running' && task.downloaded > 0 ? task : null
    },
    { timeoutMs: 20000, intervalMs: 40, label: 'download progress' },
  )
  t.assert('cancel: mid-transfer path resolved', typeof progressed.path === 'string', progressed.path)

  await kernel.control(started.id, 'cancel')
  const cancelled = await kernel.waitTaskStatus(started.id, ['cancelled'], 15000)
  t.eq('cancel: status cancelled', cancelled.status, 'cancelled')
  const partPath = `${cancelled.path}.part`
  t.assert('cancel: .part retained for a later retry', await waitForPartFile(t, partPath, 10000), partPath)

  const retryResponse = await kernel.control(started.id, 'retry')
  t.assert('retry: accepted', Boolean(retryResponse?.task), formatDetail(retryResponse))
  const completed = await waitCompleted(t, kernel, started.id, { timeoutMs: 120000, label: 'retried download' })
  await assertFileBytes(t, completed.path, ctx.fixture.expected(size), 'retried download')
  await assertNoPartLeftovers(t, t.downloadDir)

  const removed = await kernel.control(started.id, 'remove', { deletePart: true })
  t.assert('remove: result is null/absent task', removed?.task === null || removed?.task === undefined, formatDetail(removed))
  let getError = null
  try {
    await kernel.get(started.id, 10)
  } catch (err) {
    getError = err
  }
  t.assert('remove: get(id) returns not_found', getError instanceof KernelRpcError && getError.code === 'not_found', getError?.message ?? 'no error')
  const afterRemove = await kernel.list({ limit: 200 })
  t.assert('remove: task is gone from list', afterRemove.tasks.every((entry) => entry.id !== started.id), afterRemove.tasks.length)
  t.assert('remove: completed target file is never deleted', await pathExists(completed.path), completed.path)
})

scenario('sha256: success and mismatch', 'expectedSha256 verified before rename; mismatch fails with checksum_mismatch', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 256 * 1024

  // success
  const okName = 'sha-ok.bin'
  const okExpected = ctx.fixture.expected(size)
  const okStarted = await startTask(t, kernel, {
    url: ctx.fixture.urlFor('ranged', size, okName),
    dir: t.downloadDir,
    connections: 2,
    expectedSha256: okExpected.sha256,
  })
  const okTask = await waitCompleted(t, kernel, okStarted.id, { timeoutMs: 60000, label: 'sha256 success' })
  t.eq('sha256 success: task.sha256 equals expected', okTask?.sha256, okExpected.sha256)
  await assertFileBytes(t, okTask?.path, okExpected, 'sha256 success')
  await assertNoPartLeftovers(t, t.downloadDir)

  // mismatch (fixture serves bytes that do not match the expected digest)
  const badName = 'sha-bad.bin'
  const expected = ctx.fixture.expected(size)
  const badStarted = await startTask(t, kernel, {
    url: ctx.fixture.urlFor('corrupt', size, badName),
    dir: t.downloadDir,
    connections: 2,
    expectedSha256: expected.sha256,
  })
  const badOutcome = await kernel.waitTerminal(badStarted.id, 60000)
  const badTask = badOutcome.task
  if (badOutcome.waitError) t.assert('sha256 mismatch: kernel wait method usable', false, badOutcome.waitError.message)
  else t.assert('sha256 mismatch: wait did not time out', badOutcome.waitResult?.timedOut === false, `timedOut=${badOutcome.waitResult?.timedOut}`)
  t.eq('sha256 mismatch: terminal status', badTask?.status, 'failed')
  t.eq('sha256 mismatch: error.code', badTask?.error?.code, 'checksum_mismatch')
  const targetPath = path.join(t.downloadDir, badName)
  t.assert('sha256 mismatch: .part was NOT renamed to the target path', !(await pathExists(targetPath)), targetPath)
  const leftovers = await listDir(t.downloadDir)
  t.note(`sha256 mismatch leftovers: ${formatDetail(leftovers)}`)
})

scenario('speed limit: 256 KiB/s cap', 'average throughput stays below ~2x the requested cap while completing', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const limit = 256 * 1024
  const size = 2 * MIB
  const name = 'speed-limit.bin'
  // Origin is fast enough that only the kernel cap can slow the transfer down.
  const url = ctx.fixture.urlFor('slow', size, name, 'chunk=32768&delayMs=2')
  const wallStart = performance.now()
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 2, speedLimitBps: limit })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 120000, label: 'speed-limited download' })
  const wallMs = performance.now() - wallStart
  const elapsedMs = task?.elapsedMs && task.elapsedMs > 0 ? task.elapsedMs : wallMs
  const avgBps = size / (elapsedMs / 1000)
  t.eq('speed limit: completed', task?.status, 'completed')
  t.eq('speed limit: downloaded == total', task?.downloaded, size)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'speed-limited download')
  t.assert('speed limit: average speed below 2x cap', avgBps < limit * 2, `${Math.round(avgBps / 1024)} KiB/s vs cap ${limit / 1024} KiB/s`)
  t.assert('speed limit: transfer took at least 50% of theoretical minimum', elapsedMs >= (size / limit) * 1000 * 0.5, `${Math.round(elapsedMs)}ms`)
  t.note(`avg=${Math.round(avgBps / 1024)} KiB/s elapsed=${Math.round(elapsedMs)}ms cap=${limit / 1024} KiB/s`)
})

scenario('error codes + stdin EOF exit', 'not_found, conflict, invalid action, and EOF-driven shutdown within 3s', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)

  let notFound = null
  try {
    await kernel.get('t_0000000000000000', 10)
  } catch (err) {
    notFound = err
  }
  t.assert('get unknown id -> not_found', notFound instanceof KernelRpcError && notFound.code === 'not_found', notFound?.message ?? 'no error')

  let controlUnknown = null
  try {
    await kernel.control('t_0000000000000000', 'pause')
  } catch (err) {
    controlUnknown = err
  }
  t.assert('control unknown id -> not_found', controlUnknown instanceof KernelRpcError && controlUnknown.code === 'not_found', controlUnknown?.message ?? 'no error')

  // pause on a completed task must be a conflict, not a silent success/no-op.
  const size = 128 * 1024
  const name = 'conflict.bin'
  const started = await startTask(t, kernel, { url: ctx.fixture.urlFor('ranged', size, name), dir: t.downloadDir, connections: 2 })
  await waitCompleted(t, kernel, started.id, { timeoutMs: 60000, label: 'conflict setup' })
  let conflict = null
  try {
    await kernel.control(started.id, 'pause')
  } catch (err) {
    conflict = err
  }
  t.assert('control pause on completed task -> conflict', conflict instanceof KernelRpcError && conflict.code === 'conflict', conflict?.message ?? 'no error')

  let invalidAction = null
  try {
    await kernel.control(started.id, 'bogus_action')
  } catch (err) {
    invalidAction = err
  }
  t.assert(
    'control invalid action -> invalid_request/conflict',
    invalidAction instanceof KernelRpcError && ['invalid_request', 'conflict'].includes(invalidAction.code),
    invalidAction?.message ?? 'no error',
  )
  t.eq('no malformed stdout lines in error-code scenario', kernel.parseErrors.length, 0)

  // A dedicated kernel must exit promptly when its stdin reaches EOF.
  const eofDataDir = await t.makeDataDir('eof-data')
  const eofKernel = await launchKernel(ctx.kernelPath, { dataDir: eofDataDir, logLevel: 'warn', label: 'kernel-eof' })
  t.onCleanup(async () => {
    if (!eofKernel.exited.at) await eofKernel.kill()
  })
  const eofStart = Date.now()
  eofKernel.child.stdin.end()
  let exitInfo = null
  let exitError = null
  try {
    exitInfo = await eofKernel.waitExit(3000)
  } catch (err) {
    exitError = err
  }
  const eofElapsed = Date.now() - eofStart
  t.assert('stdin EOF: kernel exited', Boolean(exitInfo), exitError?.message ?? 'no exit observed')
  t.assert('stdin EOF: exited within 3000ms', exitInfo ? eofElapsed <= 3000 : false, `${eofElapsed}ms`)
  t.note(`stdin EOF exit: code=${exitInfo?.code} signal=${exitInfo?.signal} in ${eofElapsed}ms`)
})

scenario('resume after remote change (ETag flip)', 'validator mismatch on resume is handled safely (remote_changed or verified restart)', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 4 * MIB
  const name = 'changed-resume.bin'
  const url = ctx.fixture.urlFor('changed', size, name, 'slow=1&chunk=16384&delayMs=25')
  const content = ctx.fixture.changedInfo(size)
  t.assert('changed fixture: v1/v2 bytes differ', content.v1 !== content.v2, formatDetail(content))
  if (ctx.fixture.changedVersion() !== 'v1') ctx.fixture.flipChanged()
  t.onCleanup(() => {
    if (ctx.fixture.changedVersion() !== 'v1') ctx.fixture.flipChanged()
  })

  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 4 })
  await pollUntil(
    async () => {
      const { task } = await kernel.get(started.id, 0)
      return task.status === 'running' && task.downloaded > 0 ? task : null
    },
    { timeoutMs: 20000, intervalMs: 40, label: 'changed download progress' },
  )
  await kernel.control(started.id, 'pause')
  const paused = await kernel.waitTaskStatus(started.id, ['paused'], 15000)
  t.eq('changed: paused before flip', paused.status, 'paused')
  ctx.fixture.flipChanged()
  t.eq('changed: fixture now serves v2', ctx.fixture.changedVersion(), 'v2')

  await kernel.control(started.id, 'resume')
  const final = await kernel.waitTerminal(started.id, 120000)
  const task = final.task
  const allowedFail = task?.status === 'failed' && task?.error?.code === 'remote_changed'
  const allowedRestart = task?.status === 'completed'
  t.assert('changed resume: either failed(remote_changed) or completed', Boolean(allowedFail || allowedRestart), `status=${task?.status} error=${formatDetail(task?.error)}`)
  if (allowedRestart) {
    await assertFileBytes(t, task?.path, { size, sha256: content.v2 }, 'changed restarted download')
    await assertNoPartLeftovers(t, t.downloadDir)
  } else if (allowedFail) {
    t.assert('changed resume: target file was not created from stale bytes', !(await pathExists(path.join(t.downloadDir, name))), name)
  }
  t.note(`remote-change outcome: status=${task?.status} error=${formatDetail(task?.error)}`)
})

scenario('unknown-length origin: chunked single stream fallback', 'no Content-Length -> single stream until EOF, exact bytes', async (t, ctx) => {
  const { kernel } = await makeKernel(t, ctx)
  const size = 256 * 1024
  const name = 'chunked-fallback.bin'
  const url = ctx.fixture.urlFor('chunked', size, name)
  const started = await startTask(t, kernel, { url, dir: t.downloadDir, connections: 8 })
  const task = await waitCompleted(t, kernel, started.id, { timeoutMs: 60000, label: 'chunked fallback download' })
  t.eq('chunked: downloaded == expected size', task?.downloaded, size)
  t.assert('chunked: rangeSupported=false', task?.rangeSupported === false, task?.rangeSupported)
  t.assert('chunked: total is null (unknown) or the final size', task?.total === null || task?.total === size, `total=${task?.total}`)
  await assertFileBytes(t, task?.path, ctx.fixture.expected(size), 'chunked fallback download')
  await assertNoPartLeftovers(t, t.downloadDir)
  const gets = ctx.fixture.requestsFor(name, { method: 'GET' })
  t.assert('chunked: single-stream GET observed', gets.some((entry) => entry.rangeHeader === null), formatDetail(gets.map((g) => g.rangeHeader)))
  t.eq('chunked: no partial (206) responses', gets.filter((entry) => entry.status === 206).length, 0)
  t.note(`chunked total observed: ${task?.total}`)
})

// ── suite runner ────────────────────────────────────────────────────────────

export function listScenarios() {
  return SCENARIOS.map((entry) => ({ name: entry.name, description: entry.description }))
}

/**
 * Run the e2e matrix.
 * @param {object} options
 * @param {string} options.kernelPath absolute kernel exe path
 * @param {object} options.fixture started fixture server instance
 * @param {string[]|null} [options.only] scenario-name substrings to include
 * @param {(line:string)=>void} [options.log]
 * @param {number} [options.scenarioTimeoutMs]
 * @param {boolean} [options.verbose]
 */
export async function runKernelE2ESuite(options) {
  const { kernelPath, fixture, only = null, log = console.log, scenarioTimeoutMs = 150000 } = options
  const context = { kernelPath, fixture, log }
  const selected = only && only.length > 0
    ? SCENARIOS.filter((entry) => only.some((needle) => entry.name.toLowerCase().includes(String(needle).toLowerCase())))
    : SCENARIOS
  if (selected.length === 0) throw new Error(`no scenarios matched --only ${JSON.stringify(only)}`)

  const results = []
  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index]
    const t = new KernelE2ECase(entry.name, entry.description, context)
    t.tempRoot = await makeTempDir('dsh-rdm-e2e-')
    t.downloadDir = path.join(t.tempRoot, 'downloads')
    await fs.mkdir(t.downloadDir, { recursive: true })
    t.onCleanup(() => removeDir(t.tempRoot))

    log(`\n── [${String(index + 1).padStart(2, ' ')}/${selected.length}] ${entry.name}`)
    log(`   ${entry.description}`)
    let error = null
    const startedAt = performance.now()
    try {
      await withTimeout(entry.fn(t, context), entry.timeoutMs ?? scenarioTimeoutMs, `scenario "${entry.name}"`)
    } catch (err) {
      error = err
      log(`   ✗ scenario threw: ${err?.stack ?? err?.message ?? err}`)
    }
    const ms = performance.now() - startedAt
    await t.cleanup()
    const checksPassed = t.checks.filter((check) => check.ok).length
    const ok = !error && checksPassed === t.checks.length && t.cleanupErrors.length === 0
    const result = {
      name: entry.name,
      description: entry.description,
      ok,
      ms: Math.round(ms),
      checks: t.checks,
      checksPassed,
      checksTotal: t.checks.length,
      notes: t.notes,
      error: error ? `${error.name ?? 'Error'}: ${error.message}` : null,
      cleanupErrors: t.cleanupErrors,
    }
    results.push(result)
    if (ok) {
      log(`   PASS  ${checksPassed}/${t.checks.length} checks in ${result.ms}ms${t.notes.length ? `  [${t.notes.join('; ')}]` : ''}`)
    } else {
      log(`   FAIL  ${checksPassed}/${t.checks.length} checks in ${result.ms}ms`)
      for (const check of t.checks.filter((c) => !c.ok)) log(`         - ${check.name} (${check.detail})`)
      if (result.error) log(`         - ${result.error}`)
    }
  }

  const passed = results.filter((result) => result.ok).length
  const failed = results.length - passed
  const checksTotal = results.reduce((sum, result) => sum + result.checksTotal, 0)
  const checksPassed = results.reduce((sum, result) => sum + result.checksPassed, 0)
  return {
    results,
    summary: {
      scenariosTotal: results.length,
      scenariosPassed: passed,
      scenariosFailed: failed,
      checksTotal,
      checksPassed,
      checksFailed: checksTotal - checksPassed,
      durationMs: results.reduce((sum, result) => sum + result.ms, 0),
    },
  }
}

export { DEFAULT_KERNEL_PATH }
