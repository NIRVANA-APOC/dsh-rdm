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
  KernelError,
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
  normalizeTaskHistory,
  normalizeTaskView,
  protocolMismatchMessage,
  renderControlReceipt,
  renderDownloadReceipt,
  renderHistoryReceipt,
  renderProbeReceipt,
  renderSearchReceipt,
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
    transferredBytes: 21184000,
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
    requestedConnections: 16,
    maxConnections: 128,
    targetWorkers: 16,
    chunkSize: 1572864,
    resumedChunks: 0,
    resumedBytes: 0,
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
    resumeState: {
      chunksDone: 0,
      bytesDone: 0,
      resumedChunks: 0,
      resumedBytes: 0,
      validatorsMatched: true,
      resumeDecision: 'accepted',
      resumeReason: 'etag',
    },
    timing: { queuedMs: 100, probeMs: 84, transferMs: 17400, finalizeMs: 0 },
    diagnosis: [{ code: 'on-track', advice: 'wait', message: 'ETA 20s at 5s rate' }],
    ...overrides,
  }
}

const kernelStatus = { running: true, starting: false, version: '0.2.2', pid: 1234, dataDir: 'C:\\data', error: null }

/** One `rdm_search` match fixture (design §6 canonical shape). */
function searchMatchFixture(overrides = {}) {
  return {
    id: 't_9f3a1c2d5e6b7a80',
    status: 'running',
    fileName: 'app.zip',
    url: 'https://cdn.example.com/app.zip',
    host: 'cdn.example.com',
    sessionId: 'sess_abc',
    sessionTitle: 'Build fixtures',
    workspaceTitle: 'dsh-rdm',
    title: 'Build fixtures',
    percent: 42,
    downloaded: 21184000,
    total: 50406400,
    speedBps: 1468006,
    targetWorkers: 24,
    activeWorkers: 12,
    createdAt: 1762990000000,
    finishedAt: null,
    updatedAt: 1762990017500,
    ...overrides,
  }
}

// ── Protocol pin ────────────────────────────────────────────────────────────

check('protocol version is 2', () => assert.equal(PROTOCOL_VERSION, 2))
check('protocol mismatch error is actionable', () => {
  const message = protocolMismatchMessage(1, 'C:\\bin\\rdm-kernel.exe', '1.0.0')
  assert.match(message, /protocol 1/)
  assert.match(message, /requires protocol 2/)
  assert.match(message, /build-kernel/)
  // 0.2.2 versioning: the plugin/kernel versions named in the hint are current.
  assert.match(message, /dsh-rdm 0\.3\.0/)
  assert.match(message, /0\.3\.0 kernel/)
})

// ── Tool surface ────────────────────────────────────────────────────────────

const tools = createRdmTools({})
check('seven tools with the expected names', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['rdm_download', 'rdm_probe', 'rdm_tasks', 'rdm_wait', 'rdm_control', 'rdm_history', 'rdm_search'],
  )
})
check('download parameters expose the 0.3.0 concurrency surface', () => {
  const download = tools.find((tool) => tool.name === 'rdm_download')
  assert.ok(download !== undefined, 'missing rdm_download')
  const properties = download.parameters.properties
  assert.equal(properties.connections.type, 'number')
  assert.match(properties.connections.description, /1\.\.128/)
  assert.equal(properties.maxConnections.type, 'number')
  assert.match(properties.maxConnections.description, /1\.\.128/)
  assert.match(properties.maxConnections.description, /controller may grow/)
})
check('history parameters match the 0.3.0 tool contract', () => {
  const history = tools.find((tool) => tool.name === 'rdm_history')
  assert.ok(history !== undefined, 'missing rdm_history')
  const properties = history.parameters.properties
  assert.equal(properties.taskId.type, 'string')
  assert.ok((history.parameters.required ?? []).includes('taskId'))
  assert.equal(properties.limit.type, 'number')
  assert.match(properties.limit.description, /1\.\.2000, default 300/)
  assert.equal(properties.offset.type, 'number')
  assert.equal(properties.includeEvents.type, 'boolean')
  assert.ok(!('eventsLimit' in properties), 'eventsLimit is host-side, not a tool parameter')
  assert.match(history.description, /persisted per-sample telemetry/)
  assert.match(history.description, /file paths/)
})
check('search parameters match the 0.3.0 tool contract', () => {
  const search = tools.find((tool) => tool.name === 'rdm_search')
  assert.ok(search !== undefined, 'missing rdm_search')
  const properties = search.parameters.properties
  assert.equal(properties.query.type, 'string')
  assert.equal(properties.taskId.type, 'string')
  assert.equal(properties.status.type, 'string')
  assert.equal(properties.limit.type, 'number')
  assert.match(properties.limit.description, /1\.\.50, default 10/)
  assert.equal(properties.scope.type, 'string')
  assert.deepEqual(properties.scope.enum, ['all', 'session'])
  // Task ids are an exact shortcut, never a required parameter.
  assert.deepEqual(search.parameters.required ?? [], [])
  assert.match(search.description, /Find download records across sessions/)
  assert.match(search.description, /session\/workspace labels/)
  assert.match(search.description, /rdm_tasks.*rdm_wait.*rdm_control/)
})
check('policy is stated only in the system-prompt section', () => {
  for (const tool of tools) {
    assert.ok(!/EVERY file download/i.test(tool.description), `policy repeated in ${tool.name}`)
    assert.ok(!/instead of bash/i.test(tool.description), `fallback policy repeated in ${tool.name}`)
    assert.ok(!/instead of shell/i.test(tool.description), `fallback policy repeated in ${tool.name}`)
  }
  assert.match(PROMPT_SECTION_TEXT, /every HTTP\(S\) file download/)
  assert.match(PROMPT_SECTION_TEXT, /rdm_probe first/)
  assert.match(PROMPT_SECTION_TEXT, /rdm_history/)
  assert.match(PROMPT_SECTION_TEXT, /structured key=value/)
})
check('first-turn schema cost stays under the 0.1.2 baseline', () => {
  const surface = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  const chars = JSON.stringify(surface).length
  // 0.3.0 adds the seventh tool (`rdm_search`). The design contract bounds the
  // first-turn cost against the 0.1.2 baseline (7241 chars), and the richer
  // 0.3.0 surface still fits: ~6.9k chars rather than the old six-tool 6000 guard.
  assert.ok(chars <= 7241, `schema cost is ${chars} characters`)
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

function historyFixture(overrides = {}) {
  return {
    kernel: kernelStatus,
    taskId: 't_9f3a1c2d5e6b7a80',
    samplesPath: 'C:\\data\\history\\t_9f3a1c2d5e6b7a80.samples.jsonl',
    eventsPath: 'C:\\data\\history\\t_9f3a1c2d5e6b7a80.events.jsonl',
    samples: [
      {
        t: 1762990000000,
        bytes: 11596411699,
        bps: 1048576,
        w1Bps: 1048576,
        w5Bps: 900000,
        w30Bps: 800000,
        w300Bps: 700000,
        workers: 16,
        peakWorkers: 16,
        stalledMs: 0,
      },
    ],
    events: [
      { t: 1762990000000, seq: 3, kind: 'plan', message: '8 connections', chunk: null, attempt: null, delayMs: null },
    ],
    builds: ['0.2.1@53520', '0.2.2@59852'],
    totalSamples: 1907,
    totalEvents: 42,
    truncated: false,
    error: null,
    hint: 'x',
    ...overrides,
  }
}

function historyMetaFixture(overrides = {}) {
  return {
    kind: 'meta',
    t: 1762990000000,
    kernelVersion: '0.2.2',
    pid: 59852,
    taskId: 't_h',
    run: 2,
    phase: 'plan',
    url: 'https://cdn.example.com/app.zip?sig=abc',
    fileName: 'app.zip',
    totalBytes: 50406400,
    chunkSize: 1572864,
    chunks: 32,
    requestedConnections: 16,
    initialWorkers: 8,
    maxConnections: 128,
    resumedBytes: 0,
    resumeDecision: 'not-attempted',
    resumeReason: null,
    ...overrides,
  }
}

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
  assert.match(text, /^kernel state=running version=0\.2\.2 pid=1234$/m)
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
  // 0.3.0 headline evidence: the resume verdict follows telemetry, before the
  // server/target blocks, and names the reason code.
  assert.match(text, /^resume decision=accepted reason=etag$/m)
  assert.ok(text.indexOf('resume decision=') > text.indexOf('telemetry trend='), 'resume line follows telemetry')
  assert.ok(text.indexOf('resume decision=') < text.indexOf('server host='), 'resume line precedes server block')
  assert.match(text, /^server host=cdn\.example\.com status=200 size=48\.1MiB http=HTTP\/2\.0$/m)
  assert.match(text, /^target part=C:\\Downloads\\app\.zip\.part resume=C:\\Downloads\\app\.zip\.part\.json$/m)
  assert.match(text, /^verify state=not-compared checksums=-$/m)
  assert.match(text, /^timing queued=100ms probe=84ms transfer=17s finalize=0ms$/m)
  assert.match(text, /^diagnosis code=on-track advice=wait msg="ETA 20s at 5s rate"$/m)
  assert.match(text, /^event seq=1 at=23:26:40 kind=plan msg="8 connections"$/m)
  assertReceiptLines(text)
})
check('detail receipt renders a rejected resume verdict with a null reason', () => {
  const text = renderTaskDetailReceipt({
    kernel: kernelStatus,
    task: taskFixture({ status: 'interrupted' }),
    detail: detailFixture({
      resumeState: {
        chunksDone: 0,
        bytesDone: 0,
        resumedChunks: 0,
        resumedBytes: 0,
        validatorsMatched: false,
        resumeDecision: 'rejected',
        resumeReason: null,
      },
    }),
    events: [],
    hint: 'x',
  }).join('\n')
  assert.match(text, /^resume decision=rejected reason=-$/m)
  assertReceiptLines(text)
})
check('detail receipt omits the resume line when not attempted', () => {
  const text = renderTaskDetailReceipt({
    kernel: kernelStatus,
    task: taskFixture({ status: 'running' }),
    detail: detailFixture({
      resumeState: {
        chunksDone: 0,
        bytesDone: 0,
        resumedChunks: 0,
        resumedBytes: 0,
        validatorsMatched: null,
        resumeDecision: 'not-attempted',
        resumeReason: null,
      },
    }),
    events: [],
    hint: 'x',
  }).join('\n')
  assert.ok(!text.includes('resume decision='), 'not-attempted must not add a resume line')
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

// ── Search (0.3.0 cross-session record lookup) ──────────────────────────────

check('search receipt: header then one bounded match line', () => {
  const lines = renderSearchReceipt({
    kernel: kernelStatus,
    matches: [searchMatchFixture()],
    total: 14,
    scope: 'all',
    error: null,
    hint: 'x',
  })
  assert.equal(lines[0], 'search scope=all matches=1 total=14')
  assert.equal(
    lines[1],
    'task t_9f3a1c2d5e6b7a80 state=running progress=42% session="Build fixtures" workspace="dsh-rdm" file="app.zip" connections=12/24',
  )
  // The URL is never dumped into the receipt (signed URLs are long and secret).
  assert.ok(!lines.join('\n').includes('cdn.example.com'), 'receipt must not dump URLs')
  assert.ok(lines.length <= 2)
  assertReceiptLines(lines.join('\n'))
})
check('search receipt bounds long file names and session labels', () => {
  const longName = `${'x'.repeat(400)}.zip`
  const lines = renderSearchReceipt({
    kernel: kernelStatus,
    matches: [searchMatchFixture({ fileName: longName, sessionTitle: 'S'.repeat(200), workspaceTitle: 'W'.repeat(200) })],
    total: 1,
    scope: 'session',
    error: null,
    hint: 'x',
  })
  assert.equal(lines[0], 'search scope=session matches=1 total=1')
  assert.ok(lines[1].length < 420, `match line is ${lines[1].length} characters`)
  assert.ok(lines[1].includes('...'), 'long values are ellipsized')
  assertReceiptLines(lines.join('\n'))
})
check('search receipt caps the rendered record count', () => {
  const matches = Array.from({ length: 50 }, (_, index) => searchMatchFixture({ id: `t_${index}` }))
  const lines = renderSearchReceipt({
    kernel: kernelStatus,
    matches,
    total: 120,
    scope: 'all',
    error: null,
    hint: 'x',
  })
  assert.equal(lines[0], 'search scope=all matches=50 total=120')
  assert.equal(lines.length, 51)
  assertReceiptLines(lines.join('\n'))
})
check('search not_found envelope renders as an error receipt (not a throw)', () => {
  const lines = renderSearchReceipt({
    kernel: kernelStatus,
    matches: [],
    total: 0,
    scope: 'session',
    error: { code: 'not_found', message: 'No RDM task with id "t_x" exists.' },
    hint: 'rdm_tasks without taskId lists the existing ids.',
  })
  assert.equal(lines[0], 'search scope=session matches=0 total=0')
  assert.equal(lines[1], 'error code=not_found message=No RDM task with id "t_x" exists.')
  assert.match(lines[2], /^next rdm_tasks without taskId lists the existing ids\.$/)
  assert.ok(lines.length <= 3, 'error receipt stays bounded to 3 lines')
  assertReceiptLines(lines.join('\n'))
})

// ── History (0.3.0 recording reader, 0.2.2 build tags) ──────────────────────

check('history receipt: summary, paths, range and build tags', () => {
  const lines = renderHistoryReceipt(historyFixture(), 0)
  assert.equal(
    lines[0],
    'history task=t_9f3a1c2d5e6b7a80 samples=1907 peak=1MiB/s avg=1MiB/s',
  )
  assert.equal(lines[1], 'samples C:\\data\\history\\t_9f3a1c2d5e6b7a80.samples.jsonl')
  assert.equal(lines[2], 'events C:\\data\\history\\t_9f3a1c2d5e6b7a80.events.jsonl')
  assert.equal(lines[3], 'range 0..1 of 1907')
  // 0.2.2: one build= segment line when the recording spans kernel builds.
  assert.equal(lines[4], 'build=0.2.1@53520,0.2.2@59852')
  assert.equal(lines.length, 5)
  assertReceiptLines(lines.join('\n'))
})
check('history receipt omits the build line when no meta exists', () => {
  const lines = renderHistoryReceipt(historyFixture({ builds: [] }), 0)
  assert.equal(lines.length, 4)
  assert.ok(!lines.some((line) => line.startsWith('build=')), 'no build line without meta')
  assertReceiptLines(lines.join('\n'))
})
check('history receipt renders a later page and unknown paths', () => {
  const lines = renderHistoryReceipt(historyFixture({ samplesPath: null, eventsPath: null }), 900)
  assert.equal(lines[1], 'samples -')
  assert.equal(lines[2], 'events -')
  assert.equal(lines[3], 'range 900..901 of 1907')
  assert.equal(lines[4], 'build=0.2.1@53520,0.2.2@59852')
  assertReceiptLines(lines.join('\n'))
})
check('history failure renders as an error receipt (not a throw)', () => {
  const lines = renderHistoryReceipt({
    ...historyFixture(),
    samplesPath: null,
    eventsPath: null,
    samples: [],
    events: [],
    builds: [],
    totalSamples: 0,
    totalEvents: 0,
    truncated: false,
    error: { code: 'not_found', message: 'No RDM task with id "t_x" exists.' },
    hint: 'rdm_tasks without taskId lists the existing ids.',
  })
  assert.equal(lines[0], 'history task=t_9f3a1c2d5e6b7a80 samples=0 peak=- avg=-')
  assert.equal(lines[4], 'error code=not_found message=No RDM task with id "t_x" exists.')
  assert.match(lines[5], /^next rdm_tasks without taskId lists the existing ids\.$/)
  assert.ok(lines.length >= 3 && lines.length <= 6, `history receipt has ${lines.length} lines`)
  assertReceiptLines(lines.join('\n'))
})
check('history tool render passes the requested page offset', () => {
  const tool = tools.find((entry) => entry.name === 'rdm_history')
  const text = tool.output
    .render({ taskId: 't_9f3a1c2d5e6b7a80', offset: 600 }, historyFixture())
    .map((block) => block.text)
    .join('\n')
  assert.match(text, /^range 600\.\.601 of 1907$/m)
  assert.match(text, /^build=0\.2\.1@53520,0\.2\.2@59852$/m)
  assertReceiptLines(text)
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
  // 0.3.0 view fields are always present with bounded defaults.
  assert.equal(task.maxConnections, 128)
  assert.equal(task.targetWorkers, 0)
  assert.equal(task.resumedBytes, 0)
  assert.equal(normalizeTaskView({ id: 't_2', maxConnections: 999 }).maxConnections, 128)
  assert.equal(normalizeTaskView({ id: 't_3', maxConnections: 0 }).maxConnections, 1)
  // 0.2.2 view fields: this-run bytes and requested connections.
  assert.equal(task.transferredBytes, 10, 'completed fallback derives downloaded - resumedBytes')
  assert.equal(task.requestedConnections, 0)
  const resumed = normalizeTaskView({ id: 't_4', downloaded: 100, resumedBytes: 40, connections: 8 })
  assert.equal(resumed.transferredBytes, 60)
  assert.equal(resumed.requestedConnections, 8)
  const explicit = normalizeTaskView({
    id: 't_5',
    transferredBytes: 50,
    resumedBytes: 40,
    requestedConnections: 16,
  })
  assert.equal(explicit.transferredBytes, 50)
  assert.equal(explicit.requestedConnections, 16)
  const detail = normalizeTaskDetail({})
  assert.equal(detail.server, null)
  assert.deepEqual(detail.diagnosis, [])
  // 0.3.0 resume verdict defaults: not-attempted with no reason.
  assert.equal(detail.resumeState.resumeDecision, 'not-attempted')
  assert.equal(detail.resumeState.resumeReason, null)
  assert.equal(normalizeTaskDetail({ resumeState: { resumeDecision: 'accepted', resumeReason: 'etag' } }).resumeState.resumeDecision, 'accepted')
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
check('history normalizer always returns bounded arrays and null paths', () => {
  const empty = normalizeTaskHistory(null, 't_fallback')
  assert.equal(empty.taskId, 't_fallback')
  assert.equal(empty.samplesPath, null)
  assert.equal(empty.eventsPath, null)
  assert.deepEqual(empty.samples, [])
  assert.deepEqual(empty.events, [])
  assert.deepEqual(empty.meta, [])
  assert.deepEqual(empty.builds, [])
  assert.equal(empty.totalSamples, 0)
  assert.equal(empty.totalEvents, 0)
  assert.equal(empty.truncated, false)
  const history = normalizeTaskHistory(
    {
      taskId: 't_h',
      samplesPath: 'C:\\d\\t_h.samples.jsonl',
      samples: [
        { t: 1762990000000, bytes: 2, bps: 3 },
        // The writer's cap marker is not a telemetry sample.
        { t: 1762990001000, truncated: true },
      ],
      events: [{ t: 1762990000000, kind: 'controller', message: 'active workers -> 24', seq: 3 }],
      meta: [
        historyMetaFixture({ kernelVersion: '0.2.1', pid: 53520, run: 1 }),
        historyMetaFixture({ kernelVersion: '0.2.2', pid: 59852, run: 2 }),
        // A third run on the same build must not duplicate the build tag.
        historyMetaFixture({ kernelVersion: '0.2.2', pid: 59852, run: 3 }),
      ],
      totalSamples: 1907,
      totalEvents: 42,
      truncated: true,
    },
    't_ignored',
  )
  assert.equal(history.taskId, 't_h')
  assert.equal(history.samples.length, 1)
  assert.equal(history.samples[0].w5Bps, 0)
  assert.equal(history.events.length, 1)
  assert.equal(history.events[0].kind, 'controller')
  assert.equal(history.events[0].seq, 3)
  assert.equal(history.meta.length, 3)
  assert.equal(history.meta[0].kernelVersion, '0.2.1')
  assert.equal(history.meta[0].kind, 'meta')
  assert.deepEqual(history.builds, ['0.2.1@53520', '0.2.2@59852'])
  assert.equal(history.totalSamples, 1907)
  assert.equal(history.truncated, true)
  // Meta records are bounded to the last 20 (kernel-side bound mirrored).
  const many = normalizeTaskHistory({
    meta: Array.from({ length: 22 }, (_, index) =>
      historyMetaFixture({ pid: index + 1, run: index + 1 }),
    ),
  })
  assert.equal(many.meta.length, 20)
  assert.equal(many.meta[0].pid, 3)
  assert.equal(many.builds.length, 20)
  // A 0.2.1-format recording (no meta) stays readable: empty meta/builds.
  const old = normalizeTaskHistory({ taskId: 't_old', samples: [{ t: 1762990000000, bytes: 1 }] })
  assert.deepEqual(old.meta, [])
  assert.deepEqual(old.builds, [])
  assert.equal(old.samples.length, 1)
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
    rdm_history: historyFixture(),
    rdm_search: {
      kernel: kernelStatus,
      matches: [searchMatchFixture()],
      total: 1,
      scope: 'all',
      error: null,
      hint: 'x',
    },
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
  assertCanonical('rdm_search', {
    kernel: kernelStatus,
    matches: [searchMatchFixture()],
    total: 14,
    scope: 'all',
    error: null,
    hint: 'x',
  })
  assertCanonical('rdm_search', {
    kernel: kernelStatus,
    matches: [],
    total: 0,
    scope: 'session',
    error: { code: 'not_found', message: 'missing' },
    hint: 'x',
  })
  assertCanonical('rdm_history', historyFixture())
  assertCanonical('rdm_history', {
    ...historyFixture(),
    samplesPath: null,
    eventsPath: null,
    samples: [],
    events: [],
    totalSamples: 0,
    totalEvents: 0,
    truncated: false,
    error: { code: 'not_found', message: 'missing' },
    hint: 'x',
  })
})

// ── rdm_history execution (stub kernel, no child process) ───────────────────

{
  const calls = []
  const stubKernel = {
    kernelStatus: () => kernelStatus,
    history: async (id, params) => {
      calls.push({ id, params })
      return historyFixture({ taskId: id })
    },
  }
  const stubTools = createRdmTools(stubKernel)
  const tool = stubTools.find((entry) => entry.name === 'rdm_history')
  try {
    const explicit = await tool.execute(
      { taskId: 't_9f3a1c2d5e6b7a80', limit: 500, offset: 100, includeEvents: false },
      { signal: new AbortController().signal },
    )
    assertCanonical('rdm_history', explicit)
    assert.deepEqual(explicit.builds, ['0.2.1@53520', '0.2.2@59852'])
    assert.equal(calls[0].id, 't_9f3a1c2d5e6b7a80')
    assert.equal(calls[0].params.limit, 500)
    assert.equal(calls[0].params.offset, 100)
    assert.equal(calls[0].params.includeEvents, false)
    assert.equal(calls[0].params.eventsLimit, 200)
    const defaults = await tool.execute(
      { taskId: 't_9f3a1c2d5e6b7a80' },
      { signal: new AbortController().signal },
    )
    assertCanonical('rdm_history', defaults)
    assert.equal(calls[1].params.limit, 300)
    // No model-supplied offset: omit it so KernelService keeps the kernel's
    // default evenly-downsampled review series (raw paging only on request).
    assert.equal('offset' in calls[1].params, false)
    assert.equal(calls[1].params.includeEvents, true)
    // An explicit offset — including 0 — is forwarded; KernelService turns it
    // into `raw: true`, which makes offset/limit page the literal recording.
    const explicitZero = await tool.execute(
      { taskId: 't_9f3a1c2d5e6b7a80', offset: 0 },
      { signal: new AbortController().signal },
    )
    assertCanonical('rdm_history', explicitZero)
    assert.equal(calls[2].params.offset, 0)
    passed += 1
  } catch (error) {
    failures.push(`rdm_history execute: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── rdm_search execution (stub kernel + fake catalog labels) ────────────────

{
  const tasks = [
    taskFixture({ id: 't_alpha', sessionId: 'sess_abc', status: 'running', fileName: 'app.zip', host: 'cdn.example.com' }),
    taskFixture({
      id: 't_beta',
      sessionId: 'sess_def',
      status: 'completed',
      fileName: 'report.pdf',
      host: 'files.example.com',
      path: 'C:\\Downloads\\report.pdf',
    }),
    taskFixture({
      id: 't_gamma',
      sessionId: 'sess_abc',
      status: 'failed',
      fileName: 'notes.txt',
      host: 'notes.example.com',
      error: { code: 'network', message: 'reset' },
    }),
  ]
  const catalogCalls = []
  const fakeCatalog = {
    describe: async (ids) => {
      catalogCalls.push(ids)
      return {
        sessions: {
          sess_abc: {
            id: 'sess_abc',
            title: 'Fixture builds',
            live: true,
            cwd: 'C:\\ws',
            workspaceId: 'ws1',
            workspaceTitle: 'dsh-rdm',
            workspacePath: 'C:\\ws',
          },
          sess_def: {
            id: 'sess_def',
            title: 'Docs sweep',
            live: false,
            cwd: null,
            workspaceId: null,
            workspaceTitle: null,
            workspacePath: null,
          },
        },
        workspaces: [{ id: 'ws1', title: 'dsh-rdm', path: 'C:\\ws' }],
      }
    },
  }
  const listCalls = []
  const getCalls = []
  const stubKernel = {
    kernelStatus: () => kernelStatus,
    list: async (params) => {
      listCalls.push(params)
      return { tasks, aggregate: {} }
    },
    get: async (id) => {
      getCalls.push(id)
      const task = tasks.find((entry) => entry.id === id)
      if (task === undefined) throw new KernelError('not_found', `No RDM task with id "${id}" exists.`)
      return { task, detail: null, events: [] }
    },
  }
  const searchTools = createRdmTools(stubKernel, fakeCatalog)
  const search = searchTools.find((entry) => entry.name === 'rdm_search')
  const context = { signal: new AbortController().signal, agent: { session: { id: 'sess_abc' } } }
  try {
    // Query terms match file/URL/host/path and labels case-insensitively.
    const byFile = await search.execute({ query: 'REPORT' }, context)
    assertCanonical('rdm_search', byFile)
    assert.deepEqual(byFile.matches.map((match) => match.id), ['t_beta'])
    assert.equal(byFile.total, 1)
    assert.equal(byFile.matches[0].sessionTitle, 'Docs sweep')
    assert.equal(byFile.matches[0].workspaceTitle, null)
    // Session-title terms select every record of that session.
    const bySessionTitle = await search.execute({ query: 'fixture builds' }, context)
    assert.deepEqual(bySessionTitle.matches.map((match) => match.id), ['t_alpha', 't_gamma'])
    assert.equal(bySessionTitle.matches[0].workspaceTitle, 'dsh-rdm')
    // Status and scope filters compose.
    const failed = await search.execute({ status: 'failed' }, context)
    assert.deepEqual(failed.matches.map((match) => match.id), ['t_gamma'])
    const scoped = await search.execute({ scope: 'session' }, context)
    assert.deepEqual(scoped.matches.map((match) => match.id), ['t_alpha', 't_gamma'])
    assert.equal(scoped.scope, 'session')
    // `limit` bounds the records; `total` keeps the full match count.
    const limited = await search.execute({ limit: 1 }, context)
    assert.equal(limited.matches.length, 1)
    assert.equal(limited.total, 3)
    // taskId is the exact shortcut; a missing id is a recoverable envelope.
    const exact = await search.execute({ taskId: 't_beta' }, context)
    assert.equal(exact.matches.length, 1)
    assert.equal(exact.matches[0].id, 't_beta')
    assert.equal(exact.scope, 'all')
    const missing = await search.execute({ taskId: 't_missing' }, context)
    assertCanonical('rdm_search', missing)
    assert.equal(missing.error.code, 'not_found')
    assert.equal(missing.total, 0)
    assert.deepEqual(missing.matches, [])
    // Explicit session scope with no calling session reports how to widen it.
    const noSession = await search.execute({ scope: 'session' }, { signal: new AbortController().signal })
    assert.equal(noSession.matches.length, 0)
    assert.match(noSession.hint, /scope="all"/)
    // createRdmTools stays callable with one argument: labels are null.
    const bare = createRdmTools(stubKernel).find((entry) => entry.name === 'rdm_search')
    const unlabelled = await bare.execute({ query: 'app' }, context)
    assert.equal(unlabelled.matches[0].sessionTitle, null)
    assert.equal(unlabelled.matches[0].workspaceTitle, null)
    // The renderer is wired into the tool output.
    const text = search.output.render({}, byFile).map((block) => block.text).join('\n')
    assert.match(text, /^search scope=all matches=1 total=1$/m)
    assert.match(text, /^task t_beta state=completed /m)
    // The kernel scan is bounded and the catalog is batched once per call.
    assert.equal(listCalls[0].limit, 100)
    assert.deepEqual(catalogCalls[0], ['sess_abc', 'sess_def'])
    assert.ok(getCalls.includes('t_missing'))
    passed += 1
  } catch (error) {
    failures.push(`rdm_search execute: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 0.2.2 §1.7: old-kernel unknown method is a recoverable value ────────────

{
  const oldKernel = {
    kernelStatus: () => ({ ...kernelStatus, version: '1.1.0', pid: 53520 }),
    history: async () => {
      throw new KernelError(
        'unsupported_method',
        'kernel 1.1.0 does not implement `history`; upgrade the kernel binary (dsh-rdm 0.2.2+)',
      )
    },
  }
  const tool = createRdmTools(oldKernel).find((entry) => entry.name === 'rdm_history')
  try {
    const value = await tool.execute(
      { taskId: 't_9f3a1c2d5e6b7a80' },
      { signal: new AbortController().signal },
    )
    assertCanonical('rdm_history', value)
    assert.equal(value.error.code, 'unsupported_method')
    assert.equal(value.samplesPath, null)
    assert.deepEqual(value.builds, [])
    const text = tool.output
      .render({ taskId: 't_9f3a1c2d5e6b7a80' }, value)
      .map((block) => block.text)
      .join('\n')
    assert.match(text, /^error code=unsupported_method message=/m)
    assert.match(text, /^next upgrade the kernel binary to 0\.3\.0 \(dsh-rdm 0\.3\.0\+\)/m)
    assert.ok(text.split('\n').length <= 6, 'error receipt stays bounded to 6 lines')
    assertReceiptLines(text)
    passed += 1
  } catch (error) {
    failures.push(`rdm_history unsupported_method: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} check(s), ${passed} passed`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`PASS ${passed} checks (tools-receipts)`)
}

