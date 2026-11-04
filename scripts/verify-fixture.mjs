// Self-test for the dependency-free HTTP fixture server.
//
// The kernel e2e suite trusts this fixture to model ranged/no-range/redirect/
// slow/changed/flaky/corrupt/chunked origins, so the fixture itself is verified
// here before/independently of the kernel binary.
//
// Usage: node scripts/verify-fixture.mjs
import http from 'node:http'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { startFixtureServer, fetchText } from '../tests/fixture-server.mjs'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const results = []
let failures = 0
let checks = 0

function record(name, ok, detail) {
  checks += 1
  results.push({ name, ok, detail })
  if (!ok) failures += 1
}

function assert(name, cond, detail) {
  record(name, Boolean(cond), typeof detail === 'function' ? detail() : detail)
}

function eq(name, actual, expected) {
  record(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

function abortAfter(url, ms) {
  return new Promise((resolve) => {
    const req = http.get(url)
    req.on('response', (res) => {
      res.on('data', () => {})
      res.on('error', () => {})
    })
    req.on('error', () => {})
    setTimeout(() => {
      req.destroy()
      resolve()
    }, ms)
  })
}

const timing = []
async function timed(name, fn) {
  const t0 = performance.now()
  try {
    await fn()
  } finally {
    timing.push({ name, ms: Math.round(performance.now() - t0) })
  }
}

async function main() {
  const fixture = await startFixtureServer({ rangedDelayMs: 3, slowChunkBytes: 8192, slowDelayMs: 5, flakyFailures: 2 })
  const size = 65536
  const full = (await fetchText(fixture.urlFor('ranged', size, 'full.bin'))).body
  const expectedSha = sha256(full)

  await timed('ranged semantics', async () => {
    const res = await fetchText(fixture.urlFor('ranged', size, 'ranged.bin'))
    eq('ranged full: 200', res.status, 200)
    eq('ranged full: content-length', res.headers['content-length'], String(size))
    eq('ranged full: accept-ranges', res.headers['accept-ranges'], 'bytes')
    eq('ranged full: deterministic sha256', sha256(res.body), expectedSha)

    const part = await fetchText(fixture.urlFor('ranged', size, 'part.bin'), { headers: { Range: 'bytes=1000-2000' } })
    eq('ranged 1000-2000: 206', part.status, 206)
    eq('ranged 1000-2000: content-range', part.headers['content-range'], `bytes 1000-2000/${size}`)
    eq('ranged 1000-2000: length', part.body.length, 1001)
    eq('ranged 1000-2000: bytes equal slice', sha256(part.body), sha256(full.subarray(1000, 2001)))

    const openEnded = await fetchText(fixture.urlFor('ranged', size, 'tail.bin'), { headers: { Range: 'bytes=65000-' } })
    eq('ranged open-ended: 206', openEnded.status, 206)
    eq('ranged open-ended: content-range', openEnded.headers['content-range'], `bytes 65000-65535/${size}`)

    const suffix = await fetchText(fixture.urlFor('ranged', size, 'suffix.bin'), { headers: { Range: 'bytes=-512' } })
    eq('ranged suffix: 206', suffix.status, 206)
    eq('ranged suffix: content-range', suffix.headers['content-range'], `bytes 65024-65535/${size}`)

    const multipart = await fetchText(fixture.urlFor('ranged', size, 'multi.bin'), { headers: { Range: 'bytes=0-1,4-5' } })
    eq('ranged multipart rejected: 416', multipart.status, 416)

    const outside = await fetchText(fixture.urlFor('ranged', size, 'outside.bin'), { headers: { Range: 'bytes=70000-' } })
    eq('ranged unsatisfiable: 416', outside.status, 416)

    const head = await fetchText(fixture.urlFor('ranged', size, 'head.bin'), { method: 'HEAD' })
    eq('ranged head: 200', head.status, 200)
    eq('ranged head: length', head.headers['content-length'], String(size))
    eq('ranged head: accept-ranges', head.headers['accept-ranges'], 'bytes')
  })

  await timed('no-range semantics', async () => {
    const res = await fetchText(fixture.urlFor('norange', size, 'norange.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('norange: 200 despite Range', res.status, 200)
    eq('norange: full length', res.body.length, size)
    eq('norange: no accept-ranges', res.headers['accept-ranges'], undefined)
    eq('norange: bytes correct', sha256(res.body), expectedSha)
    const head = await fetchText(fixture.urlFor('norange', size, 'norange.bin'), { method: 'HEAD' })
    eq('norange head: 200', head.status, 200)
    eq('norange head: no accept-ranges', head.headers['accept-ranges'], undefined)
  })

  await timed('redirect chain', async () => {
    const hop1 = await fetchText(fixture.urlFor('redirect', size, 'redir.bin'))
    eq('redirect hop1: 302', hop1.status, 302)
    assert('redirect hop1: location', typeof hop1.headers.location === 'string' && hop1.headers.location.includes('redirect-2'))
    const hop2 = await fetchText(new URL(hop1.headers.location, fixture.origin))
    eq('redirect hop2: 302', hop2.status, 302)
    assert('redirect hop2: location final ranged', String(hop2.headers.location).includes('/ranged/'))
    const final = await fetchText(new URL(hop2.headers.location, fixture.origin))
    eq('redirect final: 200', final.status, 200)
    eq('redirect final: bytes correct', sha256(final.body), expectedSha)
    // HEAD must follow too.
    const headHop1 = await fetchText(fixture.urlFor('redirect', size, 'redir-head.bin'), { method: 'HEAD' })
    eq('redirect HEAD hop1: 302', headHop1.status, 302)
  })

  await timed('slow trickle', async () => {
    const t0 = performance.now()
    const res = await fetchText(fixture.urlFor('slow', 65536, 'slow.bin', 'chunk=8192&delayMs=5'))
    const elapsed = performance.now() - t0
    eq('slow: 200', res.status, 200)
    eq('slow: bytes correct', sha256(res.body), expectedSha)
    assert('slow: took at least 30ms', elapsed >= 30, `elapsed=${Math.round(elapsed)}ms`)
    // Range mode is slow too.
    const ranged = await fetchText(fixture.urlFor('slow', 65536, 'slow-range.bin', 'chunk=8192&delayMs=2'), {
      headers: { Range: 'bytes=0-8191' },
    })
    eq('slow ranged: 206', ranged.status, 206)
    eq('slow ranged: bytes correct', sha256(ranged.body), sha256(full.subarray(0, 8192)))
    // Abort mid-body -> server must observe the disconnect and keep serving.
    await abortAfter(fixture.urlFor('slow', 65536, 'slow-abort.bin', 'chunk=4096&delayMs=10'), 30)
    await new Promise((r) => setTimeout(r, 100))
    const after = await fetchText(fixture.urlFor('ranged', 1024, 'after-abort.bin'))
    eq('slow abort: server still healthy', sha256(after.body), sha256(full.subarray(0, 1024)))
    assert('slow abort: aborted response counted', fixture.counters.abortedResponses >= 1, fixture.counters.abortedResponses)
  })

  await timed('changed etag flip', async () => {
    const v1 = await fixture.changedInfo(size)
    assert('changed: v1 sha differs from v2 sha', v1.v1 !== v1.v2)
    const first = await fetchText(fixture.urlFor('changed', size, 'changed.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('changed: initial etag', first.headers.etag, '"changed-v1"')
    fixture.flipChanged()
    const second = await fetchText(fixture.urlFor('changed', size, 'changed.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('changed: flipped etag', second.headers.etag, '"changed-v2"')
    assert('changed: bytes changed after flip', sha256(second.body) !== sha256(first.body))
    fixture.flipChanged()
    eq('changed: flip back', fixture.changedVersion(), 'v1')
  })

  await timed('flaky retry-after', async () => {
    fixture.armFlaky(2)
    const before = fixture.flakyState().rejectedTotal
    const r1 = await fetchText(fixture.urlFor('flaky', size, 'flaky.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('flaky: first GET 429', r1.status, 429)
    eq('flaky: retry-after header', r1.headers['retry-after'], '1')
    const r2 = await fetchText(fixture.urlFor('flaky', size, 'flaky.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('flaky: second GET 429', r2.status, 429)
    const r3 = await fetchText(fixture.urlFor('flaky', size, 'flaky.bin'), { headers: { Range: 'bytes=0-1023' } })
    eq('flaky: third GET 206', r3.status, 206)
    eq('flaky: third GET bytes correct', sha256(r3.body), sha256(full.subarray(0, 1024)))
    eq('flaky: rejected count', fixture.flakyState().rejectedTotal - before, 2)
    const head = await fetchText(fixture.urlFor('flaky', size, 'flaky.bin'), { method: 'HEAD' })
    eq('flaky: HEAD always 200', head.status, 200)
  })

  await timed('corrupt bytes', async () => {
    const info = fixture.corruptInfo(size)
    assert('corrupt: served sha differs from expected', info.sha256 !== info.expectedSha256)
    const res = await fetchText(fixture.urlFor('corrupt', size, 'corrupt.bin'))
    eq('corrupt: 200', res.status, 200)
    eq('corrupt: served bytes are the corrupt body', sha256(res.body), info.sha256)
    eq('corrupt: size kept', res.body.length, size)
  })

  await timed('chunked encoding', async () => {
    const res = await fetchText(fixture.urlFor('chunked', size, 'stream.bin'))
    eq('chunked: 200', res.status, 200)
    eq('chunked: no content-length', res.headers['content-length'], undefined)
    eq('chunked: transfer-encoding', res.headers['transfer-encoding'], 'chunked')
    eq('chunked: bytes correct', sha256(res.body), expectedSha)
    const head = await fetchText(fixture.urlFor('chunked', size, 'stream.bin'), { method: 'HEAD' })
    eq('chunked head: 200', head.status, 200)
    eq('chunked head: no content-length', head.headers['content-length'], undefined)
  })

  await timed('range concurrency tracking', async () => {
    const url = fixture.urlFor('ranged', 65536, 'concurrency.bin')
    const before = fixture.stats().counters.rangeRequests
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        fetchText(url, { headers: { Range: `bytes=${i * 8192}-${(i + 1) * 8192 - 1}` } }),
      ),
    )
    const overlap = fixture.overlapFor('concurrency.bin')
    assert('concurrency: 4 range requests logged', fixture.stats().counters.rangeRequests - before === 4, fixture.stats().counters.rangeRequests - before)
    assert('concurrency: max overlap >= 2', overlap.maxOverlap >= 2, overlap.maxOverlap)
    assert('concurrency: active back to 0', fixture.counters.activeRangeRequests === 0, fixture.counters.activeRangeRequests)
  })

  await timed('graceful close', async () => {
    const res = await fetchText(fixture.urlFor('ranged', 1024, 'close.bin'))
    eq('close: healthy before close', res.status, 200)
    await fixture.close()
    let failed = false
    try {
      await fetchText(fixture.urlFor('ranged', 1024, 'close.bin'), { timeoutMs: 2000 })
    } catch {
      failed = true
    }
    record('close: server no longer reachable', failed, 'request after close should fail')
  })

  const total = results.length
  const passed = total - failures
  console.log('\nFixture server self-test')
  console.log('='.repeat(60))
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL'
    console.log(`${mark}  ${r.name}${r.detail !== undefined && (!r.ok || process.env.VERBOSE) ? `  (${r.detail})` : ''}`)
  }
  console.log('-'.repeat(60))
  console.log(`checks: ${passed}/${total} passed, ${failures} failed`)
  console.log(`timing: ${timing.map((t) => `${t.name}=${t.ms}ms`).join(', ')}`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('fixture self-test crashed:', err)
  process.exitCode = 1
})
