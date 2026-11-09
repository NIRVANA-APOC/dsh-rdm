// Host API v3 route contract tests for `POST /api/dsh-rdm/api`.
//
// Run with: node tests/host-api.test.mjs
//
// The route is exercised through its exported HTTP handler with a fake
// KernelService and a fake SessionCatalog, so no kernel child process and no
// live Harness services are needed. The production fetch registration is the
// only caller that supplies the real catalog.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'

import { apply, KernelError, SessionCatalog, createSessionCatalog, handleRdmApiRequest, resolveTaskOpenPath } from '../lib/index.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

const kernelStatus = {
  running: true,
  starting: false,
  version: '0.3.0',
  pid: 4321,
  dataDir: 'C:\\data',
  error: null,
}

function aggregateFixture(overrides = {}) {
  return {
    total: 2,
    active: 1,
    paused: 0,
    failed: 0,
    completed: 1,
    bytesDownloaded: 1024,
    nowBps: 0,
    w5Bps: 0,
    w30Bps: 0,
    w300Bps: null,
    riskCount: 0,
    ...overrides,
  }
}

/** Minimal task view: only the fields the host route reads. */
function task(overrides = {}) {
  return {
    id: 't_a',
    sessionId: 'sess_one',
    fileName: 'file.zip',
    status: 'running',
    path: null,
    dir: 'C:\\Downloads',
    ...overrides,
  }
}

const SESSIONS = {
  sess_one: {
    id: 'sess_one',
    title: 'Build fixtures',
    live: true,
    cwd: 'C:\\ws',
    workspaceId: 'ws1',
    workspaceTitle: 'dsh-rdm',
    workspacePath: 'C:\\ws',
  },
  sess_two: {
    id: 'sess_two',
    title: 'Docs sweep',
    live: false,
    cwd: null,
    workspaceId: null,
    workspaceTitle: null,
    workspacePath: null,
  },
}

const WORKSPACES = [{ id: 'ws1', title: 'dsh-rdm', path: 'C:\\ws' }]

/**
 * Fake kernel. Behavior is overridable per test while the call log always
 * records the real invocation order (needed for the remove-notify snapshot).
 */
function makeKernel(options = {}) {
  const log = []
  const tasks = options.tasks ?? [task(), task({ id: 't_b', sessionId: 'sess_two', status: 'completed' })]
  const failControlIds = options.failControlIds ?? new Set()
  return {
    log,
    kernelStatus: () => kernelStatus,
    async list(params) {
      log.push({ method: 'list', params })
      if (options.listError !== undefined) throw options.listError
      return { tasks, aggregate: options.aggregate ?? aggregateFixture() }
    },
    async get(id, events) {
      log.push({ method: 'get', id, events })
      const found = tasks.find((entry) => entry.id === id)
      if (found === undefined) throw new KernelError('not_found', `No RDM task with id "${id}" exists.`)
      return { task: found, detail: null, events: [] }
    },
    async control(id, action, deletePart) {
      log.push({ method: 'control', id, action, deletePart })
      if (failControlIds.has(id)) {
        throw new KernelError('conflict', `"${id}" cannot "${action}" in its current status`)
      }
      if (action === 'remove') return null
      const found = tasks.find((entry) => entry.id === id)
      if (found === undefined) throw new KernelError('not_found', `No RDM task with id "${id}" exists.`)
      return found
    },
    async start() {
      throw new Error('start must not be called by these tests')
    },
    async stats() {
      return { protocol: 2, kernel: { version: '0.3.0' } }
    },
  }
}

/** Fake catalog that records every describe/notify/openPath invocation. */
function makeCatalog(options = {}) {
  const described = []
  const notified = []
  const opened = []
  return {
    described,
    notified,
    opened,
    async describe(ids) {
      described.push([...ids])
      if (options.describeError !== undefined) throw options.describeError
      return options.describeResult ?? { sessions: SESSIONS, workspaces: WORKSPACES }
    },
    async notify(sessionId, text) {
      notified.push({ sessionId, text })
      return options.notifyResult !== false
    },
    async openPath(path, target) {
      opened.push({ path, target })
      return options.openResult ?? { opened: true }
    },
  }
}

/** POST one JSON body through the exported handler and decode the envelope. */
async function call(kernel, body, catalog = null) {
  const request = new Request('http://127.0.0.1/api/dsh-rdm/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await handleRdmApiRequest(kernel, request, catalog)
  assert.equal(response.status, 200, 'the route always answers HTTP 200')
  return response.json()
}

// ── list ────────────────────────────────────────────────────────────────────

test('list returns tasks, aggregate, sessions and workspaces', async () => {
  const kernel = makeKernel()
  const catalog = makeCatalog()
  const payload = await call(kernel, { action: 'list', limit: 100 }, catalog)

  assert.equal(payload.ok, true)
  assert.equal(payload.value.kernel.version, '0.3.0')
  assert.equal(payload.value.tasks.length, 2)
  assert.equal(payload.value.aggregate.total, 2)
  assert.deepEqual(payload.value.sessions, SESSIONS)
  assert.deepEqual(payload.value.workspaces, WORKSPACES)
  // One batch, unique session ids, in task order.
  assert.deepEqual(catalog.described, [['sess_one', 'sess_two']])
  assert.equal(kernel.log[0].method, 'list')
  assert.equal(kernel.log[0].params.limit, 100)
})

test('list still works when catalog.describe rejects', async () => {
  const kernel = makeKernel()
  const catalog = makeCatalog({ describeError: new Error('session log unavailable') })
  const payload = await call(kernel, { action: 'list' }, catalog)

  assert.equal(payload.ok, true)
  assert.equal(payload.value.tasks.length, 2)
  assert.deepEqual(payload.value.sessions, {})
  assert.deepEqual(payload.value.workspaces, [])
})

test('list still works with no catalog and when the kernel list fails', async () => {
  const bare = await call(makeKernel(), { action: 'list' })
  assert.equal(bare.ok, true)
  assert.deepEqual(bare.value.sessions, {})
  assert.deepEqual(bare.value.workspaces, [])

  const failing = makeKernel({ listError: new KernelError('kernel_exited', 'child exited') })
  const payload = await call(failing, { action: 'list' }, makeCatalog())
  assert.equal(payload.ok, true, 'the poll loop always receives an envelope')
  assert.deepEqual(payload.value.tasks, [])
  assert.equal(payload.value.aggregate.total, 0)
  assert.equal(payload.value.kernel.running, true)
})

// ── control ─────────────────────────────────────────────────────────────────

test('batch control returns one result per id and keeps going after a failure', async () => {
  const kernel = makeKernel({
    tasks: [
      task({ id: 't_a' }),
      task({ id: 't_b', sessionId: 'sess_two' }),
      task({ id: 't_c', sessionId: null }),
    ],
    failControlIds: new Set(['t_b']),
  })
  const catalog = makeCatalog()
  const payload = await call(
    kernel,
    { action: 'control', ids: ['t_a', 't_b', 't_c'], control: 'pause', notify: false },
    catalog,
  )

  assert.equal(payload.ok, true)
  assert.equal(payload.value.action, 'pause')
  assert.equal(payload.value.results.length, 3)
  assert.deepEqual(payload.value.results.map((item) => item.id), ['t_a', 't_b', 't_c'])
  assert.equal(payload.value.results[0].ok, true)
  assert.equal(payload.value.results[0].task.id, 't_a')
  assert.equal(payload.value.results[1].ok, false)
  assert.equal(payload.value.results[1].error.code, 'conflict')
  assert.equal(payload.value.results[2].ok, true)
  // Sequential execution: a,b,c each get exactly one control call.
  const controlled = kernel.log.filter((entry) => entry.method === 'control').map((entry) => entry.id)
  assert.deepEqual(controlled, ['t_a', 't_b', 't_c'])
})

test('control notifies only an unfinished task owned by a live-agent session', async () => {
  const kernel = makeKernel({
    tasks: [
      task({ id: 't_running', status: 'running' }),
      task({ id: 't_done', status: 'completed' }),
      task({ id: 't_orphan', status: 'paused', sessionId: null }),
    ],
  })
  const catalog = makeCatalog()
  const payload = await call(
    kernel,
    { action: 'control', ids: ['t_running', 't_done', 't_orphan'], control: 'pause' },
    catalog,
  )

  assert.equal(payload.ok, true)
  assert.equal(catalog.notified.length, 1, 'only the unfinished, session-owned task is announced')
  assert.equal(catalog.notified[0].sessionId, 'sess_one')
  assert.match(catalog.notified[0].text, /^\[dsh-rdm\] The user paused download t_running \("file\.zip"\)/)
  assert.match(catalog.notified[0].text, /user action, not a failure/)
  assert.match(catalog.notified[0].text, /rdm_control action=resume taskId=t_running/)
  assert.deepEqual(
    payload.value.results.map((item) => item.notified),
    [true, false, false],
  )
})

test('notify:false, a cold agent and a failed notification never fail the control result', async () => {
  const kernel = makeKernel({ tasks: [task({ id: 't_a' }), task({ id: 't_b' })] })
  const muted = makeCatalog()
  await call(kernel, { action: 'control', ids: ['t_a'], control: 'pause', notify: false }, muted)
  assert.equal(muted.notified.length, 0, 'notify:false suppresses the notice')
  // notify is only defined for pause/cancel/remove; resume never announces.
  const resumed = makeCatalog()
  await call(kernel, { action: 'control', ids: ['t_a'], control: 'resume', notify: true }, resumed)
  assert.equal(resumed.notified.length, 0, 'resume is not a notifying verb')

  const cold = makeCatalog({ notifyResult: false })
  const coldPayload = await call(kernel, { action: 'control', ids: ['t_b'], control: 'cancel' }, cold)
  assert.equal(coldPayload.ok, true)
  assert.equal(coldPayload.value.results[0].ok, true)
  assert.equal(coldPayload.value.results[0].notified, false)

  const broken = makeCatalog()
  broken.notify = async () => {
    throw new Error('session controller gone')
  }
  const brokenPayload = await call(
    kernel,
    { action: 'control', ids: ['t_a'], control: 'cancel' },
    broken,
  )
  assert.equal(brokenPayload.ok, true)
  assert.equal(brokenPayload.value.results[0].ok, true)
  assert.equal(brokenPayload.value.results[0].notified, false)
})

test('remove reads the task before removing so the notice has the record', async () => {
  const kernel = makeKernel({ tasks: [task({ id: 't_remove', status: 'running' })] })
  const catalog = makeCatalog()
  const payload = await call(
    kernel,
    { action: 'control', ids: ['t_remove'], control: 'remove', deletePart: true },
    catalog,
  )

  assert.equal(payload.ok, true)
  assert.deepEqual(
    kernel.log.map((entry) => entry.method),
    ['get', 'control'],
    'the pre-remove record is read first',
  )
  assert.equal(kernel.log[1].deletePart, true)
  assert.equal(catalog.notified.length, 1)
  assert.match(catalog.notified[0].text, /The user removed download t_remove \("file\.zip"\)/)
  assert.match(catalog.notified[0].text, /task record is gone/)
  assert.deepEqual(payload.value.results[0], {
    id: 't_remove',
    ok: true,
    task: null,
    notified: true,
  })
})

test('legacy single-id control keeps the {action, task, deletePart} envelope', async () => {
  const kernel = makeKernel({ tasks: [task({ id: 't_a' })] })
  const paused = await call(kernel, { action: 'control', id: 't_a', control: 'pause' }, makeCatalog())
  assert.equal(paused.ok, true)
  assert.equal(paused.value.action, 'pause')
  assert.equal(paused.value.task.id, 't_a')
  assert.equal(paused.value.results.length, 1)
  assert.equal('deletePart' in paused.value, false, 'deletePart stays a remove-only legacy field')

  const removed = await call(
    kernel,
    { action: 'control', id: 't_a', control: 'remove', deletePart: true },
    makeCatalog(),
  )
  assert.equal(removed.ok, true)
  assert.equal(removed.value.task, null)
  assert.equal(removed.value.removedId, 't_a')
  assert.equal(removed.value.deletePart, true)

  // `op`/`command` stay accepted as verb aliases.
  const aliased = await call(kernel, { action: 'control', id: 't_a', op: 'pause' }, null)
  assert.equal(aliased.ok, true)
  assert.equal(aliased.value.action, 'pause')
})

test('control rejects missing, empty and oversized id batches', async () => {
  const kernel = makeKernel()
  const empty = await call(kernel, { action: 'control', ids: [], control: 'pause' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'invalid_request')

  const missing = await call(kernel, { action: 'control', control: 'pause' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'invalid_request')

  const oversized = await call(kernel, {
    action: 'control',
    ids: Array.from({ length: 101 }, (_, index) => `t_${index}`),
    control: 'pause',
  })
  assert.equal(oversized.ok, false)
  assert.equal(oversized.error.code, 'invalid_request')
  assert.match(oversized.error.message, /at most 100/)
})

// ── open ────────────────────────────────────────────────────────────────────

test('open resolves the task file path and delegates to the catalog opener', async () => {
  const filePath = 'C:\\Downloads\\done.zip'
  const kernel = makeKernel({
    tasks: [task({ id: 't_done', status: 'completed', path: filePath })],
  })
  const catalog = makeCatalog()
  const payload = await call(kernel, { action: 'open', id: 't_done', target: 'file' }, catalog)

  assert.equal(payload.ok, true)
  assert.deepEqual(payload.value, { opened: true, path: filePath })
  assert.deepEqual(catalog.opened, [{ path: filePath, target: 'file' }])
})

test('open resolves the containing folder from the saved file', async () => {
  const filePath = 'C:\\Downloads\\done.zip'
  const kernel = makeKernel({
    tasks: [task({ id: 't_done', status: 'completed', path: filePath })],
  })
  const catalog = makeCatalog()
  const payload = await call(kernel, { action: 'open', id: 't_done', target: 'folder' }, catalog)

  assert.equal(payload.ok, true)
  assert.deepEqual(catalog.opened, [{ path: dirname(filePath), target: 'folder' }])
  assert.equal(payload.value.path, dirname(filePath))
})

test('open falls back to the task directory before a file exists', async () => {
  const kernel = makeKernel({
    tasks: [task({ id: 't_live', status: 'running', path: null, dir: 'C:\\Downloads' })],
  })
  const catalog = makeCatalog()
  const payload = await call(kernel, { action: 'open', id: 't_live', target: 'folder' }, catalog)
  assert.equal(payload.ok, true)
  assert.deepEqual(catalog.opened, [{ path: 'C:\\Downloads', target: 'folder' }])
})

test('open rejects unknown tasks, missing paths, bad targets and opener failures', async () => {
  const kernel = makeKernel({
    tasks: [task({ id: 't_live', status: 'running', path: null, dir: '' })],
  })
  const unknown = await call(kernel, { action: 'open', id: 't_missing', target: 'file' }, makeCatalog())
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'not_found')

  const noPath = await call(kernel, { action: 'open', id: 't_live', target: 'file' }, makeCatalog())
  assert.equal(noPath.ok, false)
  assert.equal(noPath.error.code, 'not_found')

  const badTarget = await call(kernel, { action: 'open', id: 't_live', target: 'desktop' }, makeCatalog())
  assert.equal(badTarget.ok, false)
  assert.equal(badTarget.error.code, 'invalid_request')

  const failingOpener = makeCatalog({ openResult: { opened: false, code: 'not_found', error: 'gone' } })
  const failed = await call(
    kernel,
    { action: 'open', id: 't_live', target: 'folder' },
    failingOpener,
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'not_found')
})

// ── envelope ────────────────────────────────────────────────────────────────

test('the dispatcher keeps its existing envelope and action surface', async () => {
  const kernel = makeKernel()
  const badJson = await handleRdmApiRequest(
    kernel,
    new Request('http://127.0.0.1/api/dsh-rdm/api', { method: 'POST', body: '{not json' }),
    null,
  )
  const badJsonPayload = await badJson.json()
  assert.equal(badJsonPayload.ok, false)
  assert.equal(badJsonPayload.error.code, 'bad_request')

  const unknown = await call(kernel, { action: 'nope' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'bad_request')

  const stats = await call(kernel, { action: 'stats' })
  assert.equal(stats.ok, true)
  assert.equal(stats.value.protocol, 2)
})

// ── SessionCatalog (unit: fake Host context, no live Harness services) ──────

/** Build a fake HostContext exposing only `ctx.get(name)` (all catalog needs). */
function makeContext(services = {}) {
  return {
    tools: {},
    effect: () => () => {},
    get: (name) => services[name],
  }
}

/** One fulfilled `readTitleSnapshots` element. */
function titleSnapshot(sessionId, title, cwd = 'C:\\ws') {
  return { sessionId, status: 'fulfilled', value: { session: { cwd }, title: { title } } }
}

test('catalog resolves titles, live flags and sessionIds workspace grouping', async () => {
  const reads = []
  const services = {
    sessionQuery: {
      readTitleSnapshots: async (ids) => {
        reads.push([...ids])
        return ids.map((id) => titleSnapshot(id, `Title ${id}`))
      },
    },
    workspaceRegistry: {
      list: () => [
        { id: 'ws1', title: 'dsh-rdm', path: 'C:\\ws', sessionIds: ['s1'] },
        { id: 'ws2', title: 'Other', path: 'D:\\other', sessionIds: [] },
      ],
    },
    sessions: {
      get: (id) => (id === 's1' ? { header: { cwd: 'C:\\ws\\sub' } } : undefined),
    },
  }
  const catalog = createSessionCatalog(makeContext(services))
  const result = await catalog.describe(['s1', 's2', 's1', '', '  '])

  assert.deepEqual(reads, [['s1', 's2']], 'unique, trimmed, one batch')
  assert.deepEqual(result.workspaces, [
    { id: 'ws1', title: 'dsh-rdm', path: 'C:\\ws' },
    { id: 'ws2', title: 'Other', path: 'D:\\other' },
  ])
  assert.equal(result.sessions.s1.title, 'Title s1')
  assert.equal(result.sessions.s1.live, true)
  assert.equal(result.sessions.s1.workspaceId, 'ws1')
  // s2 is not attached to ws1 in the registry; the canonical cwd prefix maps it.
  assert.equal(result.sessions.s2.workspaceId, 'ws1')
  assert.equal(result.sessions.s2.live, false)
})

test('catalog caches titles for 15s, negative entries included', async () => {
  let now = 1_000_000
  const reads = []
  const services = {
    sessionQuery: {
      readTitleSnapshots: async (ids) => {
        reads.push([...ids])
        return ids.map((id) =>
          id === 'gone'
            ? { sessionId: id, status: 'rejected', reason: new Error('missing') }
            : titleSnapshot(id, 'Cached'),
        )
      },
    },
  }
  const catalog = new SessionCatalog(makeContext(services), () => now)
  const first = await catalog.describe(['s1', 'gone'])
  assert.equal(first.sessions.s1.title, 'Cached')
  assert.equal(first.sessions.gone.title, null, 'a rejected snapshot is a null title')
  assert.equal(reads.length, 1)
  await catalog.describe(['s1', 'gone'])
  assert.equal(reads.length, 1, 'fresh cache entries avoid a second read')
  now += 15_001
  await catalog.describe(['s1', 'gone'])
  assert.equal(reads.length, 2, 'entries expire after the 15s TTL')
})

test('catalog single-flights concurrent describe batches and never throws', async () => {
  let reads = 0
  let release
  const services = {
    sessionQuery: {
      readTitleSnapshots: () => {
        reads += 1
        return new Promise((resolve) => {
          release = resolve
        })
      },
    },
  }
  const catalog = createSessionCatalog(makeContext(services))
  const first = catalog.describe(['s1'])
  const second = catalog.describe(['s1'])
  assert.equal(reads, 1, 'concurrent calls join one batch')
  release([titleSnapshot('s1', 'Shared')])
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.sessions.s1.title, 'Shared')
  assert.equal(b.sessions.s1.title, 'Shared')

  // No services at all (partial deployment): empty labels, no throw.
  const bare = createSessionCatalog(makeContext({}))
  const empty = await bare.describe(['s1'])
  assert.equal(empty.sessions.s1.title, null)
  assert.equal(empty.sessions.s1.live, false)
  assert.deepEqual(empty.workspaces, [])

  // A throwing workspace registry and title service degrade instead of failing.
  const broken = createSessionCatalog(
    makeContext({
      sessionQuery: {
        readTitleSnapshots: () => {
          throw new Error('boom')
        },
      },
      workspaceRegistry: {
        list: () => {
          throw new Error('boom')
        },
      },
    }),
  )
  const degraded = await broken.describe(['s1'])
  assert.equal(degraded.sessions.s1.title, null)
  assert.deepEqual(degraded.workspaces, [])
})

test('catalog notify only reaches a live agent through sessionController.prompt', async () => {
  const prompts = []
  const liveServices = {
    agents: { get: (id) => (id === 's1' ? { id } : undefined) },
    sessionController: {
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  const live = createSessionCatalog(makeContext(liveServices))
  assert.equal(await live.notify('s1', 'hello agent'), true)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's1')
  assert.equal(prompts[0].mode, 'queue')
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: 'hello agent' }])
  assert.match(prompts[0].requestId, /^rdm-s1-\d+-\d+$/)
  assert.ok(typeof prompts[0].clientTimeZone === 'string' && prompts[0].clientTimeZone !== '')

  // A cold session is never resumed for a notice.
  const cold = createSessionCatalog(
    makeContext({ agents: { get: () => undefined }, sessionController: liveServices.sessionController }),
  )
  assert.equal(await cold.notify('s1', 'hello agent'), false)
  assert.equal(prompts.length, 1, 'no prompt for a cold agent')

  // A failing controller is reported as "not notified", never thrown.
  const failing = createSessionCatalog(
    makeContext({
      agents: { get: () => ({ id: 's1' }) },
      sessionController: {
        prompt: async () => {
          throw new Error('controller disposed')
        },
      },
    }),
  )
  assert.equal(await failing.notify('s1', 'hello agent'), false)
  assert.equal(await failing.notify('', 'hello agent'), false)
  assert.equal(await failing.notify('s1', '   '), false)
})

test('catalog openPath validates before launching any opener', async () => {
  const catalog = createSessionCatalog(makeContext({}))
  const relative = await catalog.openPath('relative/file.zip', 'file')
  assert.equal(relative.opened, false)
  assert.equal(relative.code, 'invalid_request')

  const nul = await catalog.openPath(`C:\\a\u0000b.zip`, 'file')
  assert.equal(nul.opened, false)
  assert.equal(nul.code, 'invalid_request')

  const missing = await catalog.openPath('C:\\definitely-missing\\dsh-rdm-test.zip', 'file')
  assert.equal(missing.opened, false)
  assert.equal(missing.code, 'not_found')

  const badTarget = await catalog.openPath('C:\\definitely-missing\\x.zip', 'desktop')
  assert.equal(badTarget.code, 'invalid_request')
})

test('resolveTaskOpenPath maps a task to its file, container or destination dir', () => {
  const completed = { id: 't', sessionId: 's', fileName: 'a.zip', status: 'completed', path: 'C:\\Downloads\\a.zip', dir: 'C:\\Downloads' }
  assert.equal(resolveTaskOpenPath(completed, 'file'), 'C:\\Downloads\\a.zip')
  assert.equal(resolveTaskOpenPath(completed, 'folder'), dirname('C:\\Downloads\\a.zip'))
  const running = { ...completed, path: null }
  assert.equal(resolveTaskOpenPath(running, 'file'), null)
  assert.equal(resolveTaskOpenPath(running, 'folder'), 'C:\\Downloads')
  assert.equal(resolveTaskOpenPath({ ...running, dir: '' }, 'folder'), null)
})

// ── Plugin wiring (fake Host context, no kernel spawn) ──────────────────────

test('apply registers seven tools, the v3 route and the prompt section', () => {
  const tools = []
  const routes = []
  const sections = []
  const effects = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    connection: { fetch: { register: (registration) => routes.push(registration) } },
    systemPrompt: { section: (section) => sections.push(section), getSectionOrder: () => 7 },
    effect: (callback) => {
      effects.push(callback)
      return callback()
    },
    get: (name) => (name === 'connection' ? ctx.connection : undefined),
  }

  apply(ctx, {})
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['rdm_download', 'rdm_probe', 'rdm_tasks', 'rdm_wait', 'rdm_control', 'rdm_history', 'rdm_search'],
  )
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/dsh-rdm/api')
  assert.deepEqual(routes[0].methods, ['POST'])
  assert.equal(sections[0].name, 'dsh-rdm:downloads')

  // Disposing every registered effect (the KernelService was never started)
  // must tear down cleanly.
  for (const effect of effects) {
    const disposer = effect()
    if (typeof disposer === 'function') disposer()
  }
})
