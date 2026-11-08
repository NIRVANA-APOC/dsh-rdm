// Receipt + tool-surface self-check for the dsh-rdm host bundle.
//
// Run with: node tests/tools-receipts.test.mjs
//
// The model reads `render` output, so these assertions pin the receipt
// contract from docs/design/0.2.0-agent-native.md §3.4: line-oriented
// key=value records, stable field order, `-` for null, compact binary units,
// no JSON wrapper, no repeated policy prose. They also pin protocol v2
// (PROTOCOL.md) and the bounded first-turn schema cost.
import assert from 'node:assert/strict'

import {
  PROMPT_SECTION_TEXT,
  PROTOCOL_VERSION,
  createRdmTools,
  formatBytes,
  formatClock,
  formatDurationMs,
  formatDurationSecs,
  formatPercent,
  formatProgressPair,
  formatRate,
  normalizeAggregate,
  normalizeServerFacts,
  normalizeTaskDetail,
  normalizeTaskView,
  protocolMismatchMessage,
  renderControlReceipt,
  renderDownloadReceipt,
  renderProbeReceipt,
  renderTaskDetailReceipt,
  renderTaskRecord,
  renderTasksListReceipt,
  renderWaitReceipt,
  sessionIdFromExec,
} from '../lib/index.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Every receipt line is one record: no JSON punctuation wrapper. */
function assertReceiptLines(text) {
  const lines = text.split('\n')
  assert.ok(lines.length > 0, 'receipt must not be empty')
  for (const line of lines) {
    assert.ok(line.length > 0, 'receipt must not contain empty lines')
    assert.ok(!line.startsWith('{') && !line.startsWith('['), `line looks like JSON: ${line}`)
    assert.ok(!line.includes('":"'), `line has JSON punctuation: ${line}`)
    assert.ok(!line.includes('\t'), `line contains a tab: ${line}`)
    assert.equal(line, line.trimEnd(), `line has trailing whitespace: ${line}`)
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function taskFixture(overrides = {}) {
  return {
    id: 't_9f3a1c2d5e6b7a80',
    sessionId: 'sess_abc',
    url: 'https://cdn.example.com/app.zip?sig=abc',
    host: 'cdn.example.com',
    finalUrl: 'https://cdn.example.com/app.zip?sig=abc',
    fileName: 'app.zip',
    dir: 'C:\\Downloads',
    path: null,
    status: 'probing',
    downloaded: 21184000,
    total: 50406400,
    percent: 42,
    speedBps: 1468006,
    speed1sBps: 1625292,
    speed5sBps: 1400000,
    speed30sBps: 1310000,
    speed300sBps: null,
    avgBps: 1200000,
    peakBps: 2306867,
    etaSecs: 20,
    etaConfidence: 'high',
    stalledMs: 0,
    activeWorkers: 8,
    peakWorkers: 8,
    connections: 8,
    chunkSize: 1572864,
    resumedChunks: 0,
    rangeSupported: true,
    resumable: true,
    resumeSafety: 'strong',
    expectedSha256: null,
    sha256: null,
    verified: null,
    error: null,
    retries: 0,
    createdAt: 1762990000000,
    startedAt: 1762990000100,
    finishedAt: null,
    elapsedMs: 17500,
    signedUrlExpiresAt: 1763000123000,
    tlsNotAfter: 1767000000000,
    ...overrides,
  }
}

function serverFixture(overrides = {}) {
  return {
    url: 'https://cdn.example.com/app.zip?sig=abc',
    finalUrl: 'https://cdn.example.com/app.zip?sig=abc',
    host: 'cdn.example.com',
    httpVersion: 'HTTP/2.0',
    status: 200,
    fileName: 'app.zip',
    fileNameSource: 'content-disposition',
    totalBytes: 50406400,
    contentType: 'application/zip',
    contentEncoding: null,
    contentDisposition: 'attachment; filename="app.zip"',
    range: { supported: true, acceptRanges: 'bytes', ifRange: true, probedBy: 'head', probeStatus: 206, probeBytes: 0 },
    validators: { etag: '"9b2cf5"', strongEtag: true, lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
    resume: { possible: true, safety: 'strong', reason: 'strong-etag' },
    signedUrl: { signed: true, expiresAt: 1763000123000, expiresInSecs: 1180, source: 'aws-sigv4', state: 'valid' },
    tls: {
      https: true,
      notAfter: 1767000000000,
      expiresInSecs: 3456000,
      issuer: 'R11',
      subject: 'cdn.example.com',
      state: 'valid',
    },
    redirects: [{ status: 301, url: 'https://cdn2.example.com/app.zip' }],
    headers: { server: 'nginx', date: 'Wed, 21 Oct 2026 07:28:00 GMT', cacheControl: 'max-age=3600', expires: null, vary: 'Accept-Encoding' },
    rateLimit: { retryAfterSecs: null, limit: null, remaining: null },
    timing: { probeMs: 84, ttfbMs: 61, sampleBps: null },
    checksum: { contentDigest: null, contentMd5: null, sha256: null, crc32c: null },
    warnings: ['weak-validators'],
    recommendation: {
      start: 'now',
      connections: 8,
      chunkSizeBytes: 1572864,
      singleStream: false,
      reason: 'ranges+strong-etag',
      verify: 'recommended',
    },
    origin: {
      known: true,
      attempts: 3,
      completed: 2,
      medianBps: 14680064,
      bestBps: 23068672,
      lastError: 'network',
      lastAt: 1762990000000,
    },
    ...overrides,
  }
}

function detailFixture(overrides = {}) {
  return {
    telemetry: {
      windows: { '1s': 1625292, '5s': 1400000, '30s': 1310000, '300s': null },
      peakBps: 2306867,
      avgBps: 1200000,
      stalledMs: 0,
      trend: 'rising',
      etaConfidence: 'high',
      samples: 78,
      lastSampleAt: 1762990000123,
    },
    server: serverFixture(),
    target: {
      dir: 'C:\\Downloads',
      path: 'C:\\Downloads\\app.zip',
      part: 'C:\\Downloads\\app.zip.part',
      resumeState: 'C:\\Downloads\\app.zip.part.json',
    },
    verification: {
      expectedSha256: null,
      sha256: null,
      verified: null,
      serverChecksums: { contentDigest: null, contentMd5: null, sha256: null, crc32c: null },
    },
    resumeState: { chunksDone: 0, bytesDone: 0, resumedChunks: 0, resumedBytes: 0, validatorsMatched: true },
    timing: { queuedMs: 100, probeMs: 84, transferMs: 17400, finalizeMs: 0 },
    diagnosis: [{ code: 'on-track', advice: 'wait', message: 'ETA 20s at 5s rate' }],
    ...overrides,
  }
}

const kernelStatus = { running: true, starting: false, version: '1.1.0', pid: 1234, dataDir: 'C:\\data', error: null }

// ── Protocol pin ────────────────────────────────────────────────────────────

check('protocol version is 2', () => assert.equal(PROTOCOL_VERSION, 2))
check('protocol mismatch error is actionable', () => {
  const message = protocolMismatchMessage(1, 'C:\\bin\\rdm-kernel.exe', '1.0.0')
  assert.match(message, /protocol 1/)
  assert.match(message, /requires protocol 2/)
  assert.match(message, /build-kernel/)
})

// ── Tool surface ────────────────────────────────────────────────────────────

const tools = createRdmTools({})
check('five tools with the expected names', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['rdm_download', 'rdm_probe', 'rdm_tasks', 'rdm_wait', 'rdm_control'],
  )
})
check('policy is stated only in the system-prompt section', () => {
  for (const tool of tools) {
    assert.ok(!/EVERY file download/i.test(tool.description), `policy repeated in ${tool.name}`)
    assert.ok(!/instead of bash/i.test(tool.description), `fallback policy repeated in ${tool.name}`)
    assert.ok(!/instead of shell/i.test(tool.description), `fallback policy repeated in ${tool.name}`)
  }
  assert.match(PROMPT_SECTION_TEXT, /every HTTP\(S\) file download/)
  assert.match(PROMPT_SECTION_TEXT, /rdm_probe first/)
  assert.match(PROMPT_SECTION_TEXT, /structured key=value/)
})
check('first-turn schema cost stays under 6000 characters', () => {
  const surface = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  const chars = JSON.stringify(surface).length
  assert.ok(chars <= 6000, `schema cost is ${chars} characters`)
})
check('prompt section is about 90 words', () => {
  const words = PROMPT_SECTION_TEXT.split(/\s+/).filter(Boolean).length
  assert.ok(words >= 70 && words <= 120, `prompt section is ${words} words`)
})

// ── Formatting primitives ───────────────────────────────────────────────────

check('compact binary byte units', () => {
  assert.equal(formatBytes(50406400), '48.1MiB')
  assert.equal(formatBytes(1572864), '1.5MiB')
  assert.equal(formatBytes(512), '512B')
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(null), '-')
})
check('rates', () => {
  assert.equal(formatRate(1468006), '1.4MiB/s')
  assert.equal(formatRate(0), '0B/s')
  assert.equal(formatRate(null), '-')
})
check('single-unit durations', () => {
  assert.equal(formatDurationSecs(1180), '19m40s')
  assert.equal(formatDurationSecs(3456000), '40d')
  assert.equal(formatDurationSecs(20), '20s')
  assert.equal(formatDurationMs(84), '84ms')
  assert.equal(formatDurationMs(null), '-')
})
check('percent and clock', () => {
  assert.equal(formatPercent(42), '42%')
  assert.equal(formatPercent(null), '-')
  assert.equal(formatClock(1762990000123), '23:26:40')
})
check('progress pair shares one binary unit', () => {
  assert.equal(formatProgressPair(21184000, 50406400), '20.2/48.1MiB')
  assert.equal(formatProgressPair(918273645, null), '876MiB')
  assert.equal(formatProgressPair(0, 0), '0B')
})

// ── Download receipt ────────────────────────────────────────────────────────

const downloadValue = { task: taskFixture(), server: serverFixture(), preflightTimedOut: false, terminal: false, hint: 'x' }

check('download receipt matches the §3.4 shape and order', () => {
  const lines = renderDownloadReceipt(downloadValue)
  assert.equal(lines[0], 'task t_9f3a1c2d5e6b7a80 state=probing session=sess_abc preflight=ok')
  assert.equal(lines[1], 'url https://cdn.example.com/app.zip?sig=abc')
  assert.equal(lines[2], 'server host=cdn.example.com status=200 size=48.1MiB http=HTTP/2.0')
  assert.equal(lines[3], 'range=bytes resume=strong signed=valid(19m40s) tls=valid(40d) checksum=none')
  assert.equal(lines[4], 'plan connections=8 chunk=1.5MiB verify=recommended reason=ranges+strong-etag')
  assert.match(lines.at(-1), /^next rdm_tasks taskId=t_9f3a1c2d5e6b7a80 \| rdm_wait taskIds=\["t_9f3a1c2d5e6b7a80"\] timeoutSec=60$/)
  assert.ok(!lines.some((line) => line.startsWith('preflight=')), 'preflight lives on the task line')
  assertReceiptLines(lines.join('\n'))
})
check('download receipt renders preflight timeout without server facts', () => {
  const lines = renderDownloadReceipt({
    task: taskFixture({ status: 'queued', percent: null, downloaded: 0, speedBps: 0, speed5sBps: null, etaSecs: null }),
    server: null,
    preflightTimedOut: true,
    terminal: false,
    hint: 'x',
  })
  assert.match(lines[0], /^task t_9f3a1c2d5e6b7a80 state=queued session=sess_abc preflight=timeout$/)
  assert.ok(!lines.some((line) => line.startsWith('server ')), 'no server block without facts')
  assertReceiptLines(lines.join('\n'))
})
check('download receipt renders called-by-waitSec completion with verification', () => {
  const expected = 'a'.repeat(64)
  const actual = 'b'.repeat(64)
  const lines = renderDownloadReceipt({
    task: taskFixture({
      status: 'completed',
      path: 'C:\\Downloads\\app.zip',
      expectedSha256: expected,
      sha256: actual,
      verified: true,
      percent: 100,
      downloaded: 50406400,
      finishedAt: 1762990017600,
    }),
    server: serverFixture(),
    preflightTimedOut: false,
    terminal: true,
    hint: 'x',
  })
  assert.ok(lines.includes('file C:\\Downloads\\app.zip'))
  assert.match(lines[0], /state=completed .*preflight=ok$/)
  assert.ok(lines.includes('verify state=verified sha=verified:bbbbbbbb'))
  assertReceiptLines(lines.join('\n'))
})

// ── Probe receipt ───────────────────────────────────────────────────────────

check('probe receipt carries server facts, plan and follow-up', () => {
  const text = renderProbeReceipt({ server: serverFixture(), hint: 'x' }).join('\n')
  assert.match(text, /^probe host=cdn\.example\.com status=200 http=HTTP\/2\.0$/m)
  assert.match(text, /^url https:\/\/cdn\.example\.com\/app\.zip\?sig=abc$/m)
  assert.match(text, /^hop status=301 url=https:\/\/cdn2\.example\.com\/app\.zip$/m)
  assert.match(text, /^file name=app\.zip source=content-disposition size=48\.1MiB type=application\/zip encoding=-$/m)
  assert.match(text, /^plan start=now connections=8 chunk=1\.5MiB singleStream=false verify=recommended reason=ranges\+strong-etag$/m)
  assert.match(text, /^warnings=weak-validators redirects=1$/m)
  assert.match(text, /^timing probe=84ms ttfb=61ms sample=- origin=known attempts=3 completed=2 median=14MiB\/s best=22MiB\/s lastError=network$/m)
  assert.match(text, /^next rdm_download url=https:\/\/cdn\.example\.com\/app\.zip\?sig=abc$/m)
  assert.ok(!text.includes('resume=safe'), 'resume safety renders the protocol vocabulary')
  assertReceiptLines(text)
})

// ── Task records / list ─────────────────────────────────────────────────────

check('task record matches the §3.4 list line', () => {
  assert.equal(
    renderTaskRecord(taskFixture()),
    't_9f3a1c2d5e6b7a80 probing 42% 20.2/48.1MiB 1.4MiB/s w5=1.3MiB/s eta=20s(high) workers=8/8 range=bytes resume=strong name=app.zip',
  )
  assert.equal(
    renderTaskRecord(taskFixture({ resumeSafety: 'weak' })),
    't_9f3a1c2d5e6b7a80 probing 42% 20.2/48.1MiB 1.4MiB/s w5=1.3MiB/s eta=20s(high) workers=8/8 range=bytes resume=weak name=app.zip',
  )
})
check('list receipt: kernel, scope, aggregate, task lines', () => {
  const aggregate = {
    total: 12,
    active: 2,
    paused: 1,
    failed: 1,
    completed: 8,
    bytesDownloaded: 918273645,
    nowBps: 4404019,
    w5Bps: 3984588,
    w30Bps: 3523215,
    w300Bps: null,
    riskCount: 1,
  }
  const text = renderTasksListReceipt({
    kernel: kernelStatus,
    tasks: [taskFixture()],
    aggregate,
    scope: 'session',
  }).join('\n')
  assert.match(text, /^kernel state=running version=1\.1\.0 pid=1234$/m)
  assert.match(text, /^scope=session count=1$/m)
  assert.match(
    text,
    /^aggregate total=12 active=2 paused=1 failed=1 completed=8 bytes=876MiB now=4\.2MiB\/s w5=3\.8MiB\/s w30=3\.4MiB\/s w300=- risk=1$/m,
  )
  assert.match(text, /^t_9f3a1c2d5e6b7a80 probing 42% 20\.2\/48\.1MiB 1\.4MiB\/s w5=1\.3MiB\/s eta=20s\(high\) workers=8\/8 range=bytes resume=strong name=app\.zip$/m)
  assertReceiptLines(text)
})

// ── Task detail ─────────────────────────────────────────────────────────────

check('detail receipt has header, telemetry, server, target, verify, timing, diagnosis, events', () => {
  const text = renderTaskDetailReceipt({
    kernel: kernelStatus,
    task: taskFixture(),
    detail: detailFixture(),
    events: [
      { seq: 1, at: 1762990000123, kind: 'plan', message: '8 connections', chunk: null, attempt: null, delayMs: null },
    ],
    hint: 'x',
  }).join('\n')
  assert.match(text, /^task t_9f3a1c2d5e6b7a80 state=probing session=sess_abc$/m)
  assert.match(text, /^telemetry trend=rising samples=78 peak=2\.2MiB\/s avg=1\.1MiB\/s stalled=0ms w1=1\.5MiB\/s w5=1\.3MiB\/s w30=1\.2MiB\/s w300=-$/m)
  assert.match(text, /^server host=cdn\.example\.com status=200 size=48\.1MiB http=HTTP\/2\.0$/m)
  assert.match(text, /^target part=C:\\Downloads\\app\.zip\.part resume=C:\\Downloads\\app\.zip\.part\.json$/m)
  assert.match(text, /^verify state=not-compared checksums=-$/m)
  assert.match(text, /^timing queued=100ms probe=84ms transfer=17s finalize=0ms$/m)
  assert.match(text, /^diagnosis code=on-track advice=wait msg="ETA 20s at 5s rate"$/m)
  assert.match(text, /^event seq=1 at=23:26:40 kind=plan msg="8 connections"$/m)
  assertReceiptLines(text)
})

// ── Wait / control ──────────────────────────────────────────────────────────

check('wait receipt', () => {
  const lines = renderWaitReceipt({
    tasks: [taskFixture(), taskFixture({ id: 't_2', status: 'completed' })],
    timedOut: false,
    error: null,
    hint: 'x',
  })
  assert.equal(lines[0], 'wait timedOut=false count=2')
  assert.equal(lines[1], renderTaskRecord(taskFixture()))
  assertReceiptLines(lines.join('\n'))
})
check('wait failure renders as an error receipt (not a throw)', () => {
  const lines = renderWaitReceipt({
    tasks: [],
    timedOut: false,
    error: { code: 'not_found', message: 'no task t_missing' },
    hint: 'rdm_tasks without taskId lists the existing ids; re-check the taskIds and retry rdm_wait.',
  })
  assert.equal(lines[0], 'wait timedOut=false count=0')
  assert.equal(lines[1], 'error code=not_found message=no task t_missing')
  assert.match(lines[2], /^next rdm_tasks without taskId lists the existing ids; re-check the taskIds/)
  assertReceiptLines(lines.join('\n'))
})
check('control receipts', () => {
  assert.deepEqual(renderControlReceipt({ action: 'remove', task: null, removedId: 't_1', deletePart: true, hint: 'x' }), [
    'control action=remove removedId=t_1 deletePart=true',
  ])
  const lines = renderControlReceipt({ action: 'pause', task: taskFixture({ status: 'paused' }), removedId: null, deletePart: false, hint: 'x' })
  assert.equal(lines[0], 'control action=pause task=t_9f3a1c2d5e6b7a80')
  assert.equal(lines[1], renderTaskRecord(taskFixture({ status: 'paused' })))
  assertReceiptLines(lines.join('\n'))
})

// ── Session attribution ─────────────────────────────────────────────────────

check('session id comes from exec.agent.session.id', () => {
  assert.equal(sessionIdFromExec({ signal: new AbortController().signal, agent: { session: { id: 'sess_abc' } } }), 'sess_abc')
})
check('session id is read from a realistic ToolExecution second argument', () => {
  // The harness calls execute(args, exec) with a ToolExecution; `agent` is a
  // nested ref, so only agent.session.id is the owning session.
  const exec = {
    signal: new AbortController().signal,
    toolCallId: 'call_1',
    agent: { id: 'agent_1', name: 'lead', session: { id: 'sess_real-1', title: 'x' } },
    session: { id: 'NOT_THE_OWNER' },
  }
  assert.equal(sessionIdFromExec(exec), 'sess_real-1')
})
check('session id is null when the context is absent or malformed', () => {
  assert.equal(sessionIdFromExec({ signal: new AbortController().signal }), null)
  assert.equal(sessionIdFromExec({ signal: new AbortController().signal, agent: null }), null)
  assert.equal(sessionIdFromExec({ signal: new AbortController().signal, agent: { session: {} } }), null)
  assert.equal(sessionIdFromExec({ signal: new AbortController().signal, agent: { session: { id: 'bad id!' } } }), null)
})

// ── Normalizers (kernel JSON -> canonical value) ────────────────────────────

check('normalizers are defensive', () => {
  assert.equal(normalizeTaskView(null), null)
  assert.equal(normalizeTaskView({}), null)
  assert.equal(normalizeServerFacts(null), null)
  const task = normalizeTaskView({ id: 't_1', url: 'https://x.example/y', status: 'completed', downloaded: 0, total: 10 })
  assert.equal(task.percent, 100)
  assert.equal(task.host, 'x.example')
  assert.equal(task.sessionId, null)
  const detail = normalizeTaskDetail({})
  assert.equal(detail.server, null)
  assert.deepEqual(detail.diagnosis, [])
  assert.deepEqual(normalizeAggregate({ total: 3 }), {
    total: 3,
    active: 0,
    paused: 0,
    failed: 0,
    completed: 0,
    bytesDownloaded: 0,
    nowBps: 0,
    w5Bps: 0,
    w30Bps: 0,
    w300Bps: null,
    riskCount: 0,
  })
})

// ── Recoverable failures are canonical values (design §3.5) ─────────────────

check('probe failure renders as an error receipt, not a throw', () => {
  const lines = renderProbeReceipt({
    server: null,
    error: { code: 'network', message: 'connection reset by peer' },
    hint: 'retry rdm_probe url=https://x.example/y once | verify the URL, network and any auth headers.',
  })
  assert.equal(lines[0], 'error code=network message=connection reset by peer')
  assert.match(lines[1], /^next retry rdm_probe url=https:\/\/x\.example\/y once/)
  assertReceiptLines(lines.join('\n'))
})
check('tasks detail failure renders as an error receipt', () => {
  const lines = renderTaskDetailReceipt({
    kernel: kernelStatus,
    task: null,
    detail: null,
    events: [],
    error: { code: 'not_found', message: 'No RDM task with id "t_x" exists.' },
    hint: 'rdm_tasks without taskId lists the existing ids.',
  })
  assert.match(lines[0], /^kernel state=running /)
  assert.equal(lines[1], 'error code=not_found message=No RDM task with id "t_x" exists.')
  assert.match(lines[2], /^next rdm_tasks without taskId lists the existing ids\.$/)
  assertReceiptLines(lines.join('\n'))
})
check('tasks list failure renders as an error receipt', () => {
  const lines = renderTasksListReceipt(
    {
      kernel: kernelStatus,
      tasks: [],
      aggregate: {
        total: 0,
        active: 0,
        paused: 0,
        failed: 0,
        completed: 0,
        bytesDownloaded: 0,
        nowBps: 0,
        w5Bps: 0,
        w30Bps: 0,
        w300Bps: null,
        riskCount: 0,
      },
      counts: { total: 0, active: 0, paused: 0, failed: 0, completed: 0 },
      scope: 'all',
      error: { code: 'internal', message: 'list failed' },
      hint: 'retry rdm_tasks; if it persists, report the kernel error to the user.',
    },
  )
  assert.match(lines[0], /^kernel state=running /)
  assert.equal(lines[1], 'scope=all count=0')
  assert.match(lines[2], /^aggregate total=0 /)
  assert.equal(lines[3], 'error code=internal message=list failed')
  assert.match(lines[4], /^next retry rdm_tasks/)
  assertReceiptLines(lines.join('\n'))
})
check('control failure renders as an error receipt', () => {
  const lines = renderControlReceipt({
    action: 'pause',
    task: null,
    removedId: null,
    deletePart: false,
    error: { code: 'conflict', message: 'task t_9f3a1c2d5e6b7a80 is completed' },
    hint: 'rdm_tasks taskId=t_9f3a1c2d5e6b7a80 then retry rdm_control action=pause once the status permits.',
  })
  assert.equal(lines[0], 'control action=pause task=-')
  assert.equal(lines[1], 'error code=conflict message=task t_9f3a1c2d5e6b7a80 is completed')
  assert.match(lines[2], /^next rdm_tasks taskId=t_9f3a1c2d5e6b7a80 then retry rdm_control action=pause/)
  assertReceiptLines(lines.join('\n'))
})

// ── Receipts must never echo request auth inputs ───────────────────────────

check('receipts never print headers/cookie/referer values', () => {
  const authArgs = {
    url: 'https://cdn.example.com/app.zip',
    headers: { Authorization: 'Bearer SECRET_TOKEN', 'X-Api-Key': 'SECRET_API_KEY' },
    cookie: 'session=SECRET_COOKIE',
    referer: 'https://secret.example/',
    userAgent: 'SECRET_AGENT',
    dir: 'C:\\Downloads',
    expectedSha256: 'c'.repeat(64),
    taskIds: ['t_9f3a1c2d5e6b7a80'],
    taskId: 't_9f3a1c2d5e6b7a80',
    action: 'pause',
    deletePart: false,
    timeoutSec: 1,
    waitSec: 0,
  }
  const aggregate = {
    total: 1,
    active: 1,
    paused: 0,
    failed: 0,
    completed: 0,
    bytesDownloaded: 10,
    nowBps: 0,
    w5Bps: 0,
    w30Bps: 0,
    w300Bps: null,
    riskCount: 0,
  }
  const canonical = {
    rdm_download: downloadValue,
    rdm_probe: { server: serverFixture(), error: null, hint: 'x' },
    rdm_tasks: {
      kernel: kernelStatus,
      tasks: [taskFixture()],
      aggregate,
      counts: { total: 1, active: 1, paused: 0, failed: 0, completed: 0 },
      scope: 'session',
      error: null,
      hint: 'x',
    },
    rdm_wait: { tasks: [taskFixture()], timedOut: false, error: null, hint: 'x' },
    rdm_control: { action: 'pause', task: taskFixture(), removedId: null, deletePart: false, error: null, hint: 'x' },
  }
  for (const tool of tools) {
    const text = tool.output
      .render(authArgs, canonical[tool.name])
      .map((block) => block.text)
      .join('\n')
    for (const secret of ['SECRET_TOKEN', 'SECRET_API_KEY', 'SECRET_COOKIE', 'SECRET_AGENT', 'secret.example']) {
      assert.ok(!text.includes(secret), `${tool.name} receipt leaked ${secret}`)
    }
    assert.ok(!/authorization/i.test(text), `${tool.name} receipt mentions authorization`)
  }
})

// ── Canonical values validate against the declared output schemas ──────────

/** Minimal JSON-Schema validator for the defineTool output-schema subset. */
function validateValue(schema, value, path = 'value', violations = []) {
  if (schema === null || typeof schema !== 'object') return violations
  if (Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf) {
      const branchViolations = validateValue(branch, value, path, [])
      if (branchViolations.length === 0) matches += 1
    }
    if (matches !== 1) violations.push(`${path} must match exactly one branch (matched ${matches})`)
    return violations
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a finite number`)
      break
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${path} must be an integer`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
      break
    case 'null':
      if (value !== null) violations.push(`${path} must be null`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`)
        break
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, violations))
      }
      break
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path} must be an object`)
        break
      }
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) violations.push(`${path}.${key} is required`)
      }
      for (const [key, child] of Object.entries(properties)) {
        if (value[key] !== undefined) validateValue(child, value[key], `${path}.${key}`, violations)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) violations.push(`${path}.${key} is not allowed`)
        }
      }
      break
    }
    default:
      break
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    violations.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }
  return violations
}

function toolOutputSchema(name) {
  const tool = tools.find((entry) => entry.name === name)
  assert.ok(tool !== undefined, `missing tool ${name}`)
  return tool.output.schema
}

function assertCanonical(name, value) {
  const violations = validateValue(toolOutputSchema(name), value)
  assert.deepEqual(violations, [], `${name} canonical value violates its output schema: ${violations.join('; ')}`)
}

check('canonical values validate against their output schemas', () => {
  assertCanonical('rdm_download', downloadValue)
  assertCanonical('rdm_download', {
    task: taskFixture({ status: 'completed', path: 'C:\\Downloads\\app.zip' }),
    server: serverFixture(),
    preflightTimedOut: false,
    terminal: true,
    hint: 'x',
  })
  assertCanonical('rdm_probe', { server: serverFixture(), error: null, hint: 'x' })
  assertCanonical('rdm_probe', { server: null, error: { code: 'network', message: 'reset' }, hint: 'x' })
  const aggregate = {
    total: 1,
    active: 0,
    paused: 0,
    failed: 0,
    completed: 1,
    bytesDownloaded: 10,
    nowBps: 0,
    w5Bps: 0,
    w30Bps: 0,
    w300Bps: null,
    riskCount: 0,
  }
  const counts = { total: 1, active: 0, paused: 0, failed: 0, completed: 1 }
  assertCanonical('rdm_tasks', {
    kernel: kernelStatus,
    tasks: [taskFixture()],
    aggregate,
    counts,
    scope: 'session',
    error: null,
    hint: 'x',
  })
  assertCanonical('rdm_tasks', {
    kernel: kernelStatus,
    tasks: [],
    aggregate,
    counts,
    scope: 'all',
    error: { code: 'internal', message: 'list failed' },
    hint: 'x',
  })
  assertCanonical('rdm_tasks', {
    kernel: kernelStatus,
    task: taskFixture(),
    detail: detailFixture(),
    events: [],
    error: null,
    hint: 'x',
  })
  assertCanonical('rdm_tasks', {
    kernel: kernelStatus,
    task: null,
    detail: null,
    events: [],
    error: { code: 'not_found', message: 'missing' },
    hint: 'x',
  })
  assertCanonical('rdm_wait', {
    tasks: [taskFixture()],
    timedOut: false,
    error: null,
    hint: 'x',
  })
  assertCanonical('rdm_wait', {
    tasks: [],
    timedOut: false,
    error: { code: 'not_found', message: 'missing' },
    hint: 'x',
  })
  assertCanonical('rdm_control', {
    action: 'pause',
    task: taskFixture(),
    removedId: null,
    deletePart: false,
    error: null,
    hint: 'x',
  })
  assertCanonical('rdm_control', {
    action: 'pause',
    task: null,
    removedId: null,
    deletePart: false,
    error: { code: 'conflict', message: 'completed' },
    hint: 'x',
  })
})

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} check(s), ${passed} passed`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`PASS ${passed} checks (tools-receipts)`)
}
