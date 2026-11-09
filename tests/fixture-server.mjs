// Dependency-free HTTP fixture server for the dsh-rdm kernel e2e suite.
//
// One server exposes every scenario the kernel must handle. Route shape:
//
//   /<mode>/<sizeBytes>/<fileName>[?query]
//
// Modes:
//   ranged    deterministic file, Accept-Ranges: bytes, honours one byte range,
//             rejects multipart ranges with 416, correct Content-Length.
//   norange   ignores Range, always 200 + full body, no Accept-Ranges.
//   redirect  /redirect/... 302 -> /redirect-2/... 302 -> /ranged/... (2 hops).
//   slow      trickled body (chunk + delay query params) to exercise pause/resume
//             and the kernel bandwidth limiter. Supports ranges.
//   changed   ranged with ETag "v1"; flipChanged() switches to "v2" + new bytes
//             so a resume validator check must fail.
//   flaky     HEAD is normal; the first N GETs answer 429 + Retry-After: 1.
//   corrupt   serves bytes that do not match the deterministic pattern's sha256.
//   chunked   no Content-Length / Transfer-Encoding: chunked, no ranges, so the
//             kernel must fall back to a single unknown-length stream.
//   volatile  0.3.0 resume fixture: every request for the bare path answers 302
//             to the SAME path with a fresh `?sig=<random>` query token; the
//             final path serves ranged content with stable size/etag/bytes. The
//             final URL therefore changes on every probe while the object
//             identity does not (real ModelScope `auth_key` behaviour).
//             `?slow=1` serves the final body through the trickling slow path.
//   authkey   0.3.0 redaction fixture: every request for the bare path answers
//             302 to the SAME path with a ModelScope-style `auth_key=<secret>`
//             (plus `Expires`); the final path serves ranged content. Assertions
//             use GET /__fixture/health for the secret and /__fixture/state for
//             redirect/served counters and minted volatile tokens.
//
// The server records per-request facts (method, url, Range header, status,
// timing) plus live connection / range-concurrency counters. Tests filter the
// log by URL to assert e.g. "exactly one GET with no Range".
import http from 'node:http'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'

const MIB = 1024 * 1024
const MAX_SIZE = 256 * MIB
const MAX_LOG = 40000

const SEED_MAIN = 7
const SEED_CHANGED_V2 = 99

// Stable validators for the 0.3.0 resume fixtures: the redirect target query
// token is volatile, but path/size/etag/content/Last-Modified never change.
const VOLATILE_ETAG = '"volatile-v1"'
const AUTH_KEY_ETAG = '"authkey-v1"'
const FIXTURE_LAST_MODIFIED = 'Wed, 21 Oct 2026 07:28:00 GMT'
/** ModelScope-style `auth_key` bearer token used by the redaction scenarios. */
const AUTH_KEY_SECRET = '1794154377-c6fc216ba8e4466d89b9af721eb2cf8d-0-cb444b28d3878bfbb67e715a719a58f5'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ── deterministic file generation (same bytes for a given seed+size) ─────────
const contentCache = new Map()

/** @returns {Buffer} */
function patternBuffer(seed, size) {
  const key = `${seed}:${size}`
  const cached = contentCache.get(key)
  if (cached) return cached
  const buf = Buffer.allocUnsafe(size)
  let x = ((seed >>> 0) * 0x9e3779b1) >>> 0 || 0x9e3779b9
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    buf[i] = x & 0xff
  }
  contentCache.set(key, buf)
  return buf
}

const shaCache = new Map()
function shaOf(seed, size) {
  const key = `${seed}:${size}`
  let digest = shaCache.get(key)
  if (!digest) {
    digest = sha256(patternBuffer(seed, size))
    shaCache.set(key, digest)
  }
  return digest
}

/** The corrupt body is the main pattern with first+last byte flipped. */
function corruptBuffer(size) {
  const key = `corrupt:${size}`
  const cached = contentCache.get(key)
  if (cached) return cached
  const buf = Buffer.from(patternBuffer(SEED_MAIN, size))
  if (size > 0) {
    buf[0] ^= 0xff
    buf[size - 1] ^= 0xff
  }
  contentCache.set(key, buf)
  return buf
}

// ── range header parsing ────────────────────────────────────────────────────
function parseRangeHeader(header, size) {
  if (!header) return { kind: 'none' }
  const raw = String(header).trim()
  if (!raw.toLowerCase().startsWith('bytes=')) return { kind: 'invalid' }
  const spec = raw.slice(6).trim()
  if (spec.includes(',')) return { kind: 'multipart' }
  const m = /^(\d*)-(\d*)$/.exec(spec)
  if (!m) return { kind: 'invalid' }
  const [, a, b] = m
  if (a === '' && b === '') return { kind: 'invalid' }
  if (a === '') {
    const suffix = Number(b)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'invalid' }
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(a)
  const end = b === '' ? size - 1 : Number(b)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'invalid' }
  if (b !== '' && end < start) return { kind: 'invalid' }
  if (start >= size) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end: Math.min(end, size - 1) }
}

function parseRoute(urlString) {
  const parsed = new URL(urlString, 'http://placeholder')
  const segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  if (segments.length < 3) return null
  const [mode, sizeRaw, ...rest] = segments
  const size = Number(sizeRaw)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) return null
  const fileName = rest.join('/') || 'file.bin'
  return { mode, size, fileName, query: parsed.searchParams, pathname: parsed.pathname }
}

const COMMON_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
}

/**
 * Start the fixture server.
 *
 * @param {object} [options]
 * @param {number} [options.rangedDelayMs] artificial delay before a ranged body
 *   is flushed, so concurrent range requests are observable (default 2).
 * @param {number} [options.slowChunkBytes] slow-mode chunk size (default 16384).
 * @param {number} [options.slowDelayMs] slow-mode delay between chunks (default 25).
 * @param {number} [options.flakyFailures] GETs to reject with 429 before serving
 *   normally, reset by armFlaky() (default 2).
 * @param {string} [options.retryAfter] Retry-After header value (default '1').
 * @param {string} [options.host] bind address (default 127.0.0.1).
 */
export async function startFixtureServer(options = {}) {
  const config = {
    rangedDelayMs: options.rangedDelayMs ?? 2,
    slowChunkBytes: options.slowChunkBytes ?? 16 * 1024,
    slowDelayMs: options.slowDelayMs ?? 25,
    flakyFailures: options.flakyFailures ?? 2,
    retryAfter: options.retryAfter ?? '1',
    host: options.host ?? '127.0.0.1',
  }

  const counters = {
    connections: 0,
    activeConnections: 0,
    maxActiveConnections: 0,
    requests: 0,
    getRequests: 0,
    headRequests: 0,
    rangeRequests: 0,
    activeRangeRequests: 0,
    maxActiveRangeRequests: 0,
    rangeBytes: 0,
    bytesWritten: 0,
    flakyRejected: 0,
    abortedResponses: 0,
    slowResponses: 0,
    redirects: 0,
    volatileRedirects: 0,
    volatileServed: 0,
    authKeyRedirects: 0,
    authKeyServed: 0,
    status4xx: 0,
    status5xx: 0,
  }

  /** @type {Array<{n:number, method:string, url:string, pathname:string, mode:string,
   *   fileName:string, range:null|{start:number,end:number}, status:number,
   *   startedAt:number, finishedAt:number|null}>} */
  const requestLog = []
  /** @type {Array<{url:string, start:number, end:number, t0:number, t1:number|null}>} */
  const rangeIntervals = []

  const state = {
    changedVersion: 'v1',
    flakyRemaining: config.flakyFailures,
    flakyRejectedTotal: 0,
    /** Every random `sig` token minted by the volatile redirect route. */
    volatileTokens: [],
  }

  const sockets = new Set()
  let requestSeq = 0
  let closing = null

  function recordStart(req, mode) {
    requestSeq += 1
    counters.requests += 1
    if (req.method === 'GET') counters.getRequests += 1
    if (req.method === 'HEAD') counters.headRequests += 1
    const route = parseRoute(req.url)
    const entry = {
      n: requestSeq,
      method: req.method,
      url: req.url,
      pathname: route?.pathname ?? req.url,
      mode: mode ?? route?.mode ?? 'unknown',
      fileName: route?.fileName ?? '',
      rangeHeader: typeof req.headers.range === 'string' ? req.headers.range : null,
      range: null,
      status: 0,
      startedAt: performance.now(),
      finishedAt: null,
    }
    if (requestLog.length >= MAX_LOG) requestLog.splice(0, requestLog.length - MAX_LOG + 1)
    requestLog.push(entry)
    return entry
  }

  function recordEnd(entry, res) {
    if (!entry) return
    entry.finishedAt = performance.now()
    entry.status = res.statusCode
    if (res.statusCode >= 400 && res.statusCode < 500) counters.status4xx += 1
    if (res.statusCode >= 500) counters.status5xx += 1
  }

  function trackRange(url, range) {
    counters.rangeRequests += 1
    counters.activeRangeRequests += 1
    if (counters.activeRangeRequests > counters.maxActiveRangeRequests) {
      counters.maxActiveRangeRequests = counters.activeRangeRequests
    }
    const interval = {
      url,
      start: range.start,
      end: range.end,
      t0: performance.now(),
      t1: null,
    }
    rangeIntervals.push(interval)
    let done = false
    return () => {
      if (done) return
      done = true
      interval.t1 = performance.now()
      counters.activeRangeRequests -= 1
    }
  }

  function attachResGuards(req, res) {
    res.on('error', () => {})
    req.on('error', () => {})
    res.socket?.on?.('error', () => {})
  }

  function send416(res, size, entry) {
    const finish = res.end.bind(res)
    res.writeHead(416, {
      ...COMMON_HEADERS,
      'Content-Range': `bytes */${size}`,
      'Content-Length': '0',
    })
    recordEnd(entry, res)
    finish()
  }

  /** Recorded 302 hop shared by the 0.3.0 volatile/auth_key fixtures. */
  function sendRedirect(req, res, mode, location) {
    const entry = recordStart(req, mode)
    attachResGuards(req, res)
    counters.redirects += 1
    res.writeHead(302, { ...COMMON_HEADERS, Location: location, 'Content-Length': '0' })
    entry.status = 302
    recordEnd(entry, res)
    res.end()
  }

  /**
   * 0.3.0 volatile-final-URL bridge route. The bare path always answers 302 to
   * the same path with a *fresh* `sig` token, so `finalUrl` differs on every
   * probe while one stable identity (path/size/etag/Last-Modified/bytes) does
   * not. A kernel that keys resume on `finalUrl` restarts from zero here.
   */
  async function serveVolatile(req, res, { size, url, query, pathname }) {
    if (!query.has('sig')) {
      const token = crypto.randomBytes(16).toString('hex')
      state.volatileTokens.push(token)
      counters.volatileRedirects += 1
      const params = new URLSearchParams(query)
      params.set('sig', token)
      sendRedirect(req, res, 'volatile', `${pathname}?${params.toString()}`)
      return
    }
    counters.volatileServed += 1
    const buffer = patternBuffer(SEED_MAIN, size)
    if (query.get('slow') === '1') {
      await serveSlow(req, res, { size, buffer, url, params: query, etag: VOLATILE_ETAG, lastModified: FIXTURE_LAST_MODIFIED })
      return
    }
    await serveRanged(req, res, { size, buffer, etag: VOLATILE_ETAG, lastModified: FIXTURE_LAST_MODIFIED, url })
  }

  /**
   * 0.3.0 redaction route: bare path 302s to the same path carrying a
   * ModelScope-style `auth_key` (real token material) and `Expires`. The final
   * path serves ranged content so downloads still complete.
   */
  async function serveAuthKey(req, res, { size, url, query, pathname }) {
    if (!query.has('auth_key')) {
      counters.authKeyRedirects += 1
      const params = new URLSearchParams(query)
      params.set('auth_key', AUTH_KEY_SECRET)
      sendRedirect(req, res, 'authkey', `${pathname}?${params.toString()}`)
      return
    }
    counters.authKeyServed += 1
    const buffer = patternBuffer(SEED_MAIN, size)
    if (query.get('slow') === '1') {
      await serveSlow(req, res, { size, buffer, url, params: query, etag: AUTH_KEY_ETAG, lastModified: FIXTURE_LAST_MODIFIED })
      return
    }
    await serveRanged(req, res, { size, buffer, etag: AUTH_KEY_ETAG, lastModified: FIXTURE_LAST_MODIFIED, url })
  }

  async function serveRanged(req, res, { size, buffer, etag, lastModified, url }) {
    const route = parseRoute(req.url) ?? {}
    const rangeHeader = req.headers.range
    const parsed = parseRangeHeader(rangeHeader, size)
    const entry = recordStart(req, route.mode)
    attachResGuards(req, res)

    if (parsed.kind === 'multipart' || parsed.kind === 'invalid' || parsed.kind === 'unsatisfiable') {
      entry.range = parsed.kind === 'range' ? { start: parsed.start, end: parsed.end } : null
      entry.status = 416
      send416(res, size, entry)
      return
    }

    const baseHeaders = {
      ...COMMON_HEADERS,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    }

    if (parsed.kind === 'none') {
      // Full-body ranged-capable response.
      entry.status = 200
      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(size) })
      counters.bytesWritten += size
      recordEnd(entry, res)
      try {
        res.end(buffer)
      } catch {
        /* client vanished */
      }
      return
    }

    entry.range = { start: parsed.start, end: parsed.end }
    const body = buffer.subarray(parsed.start, parsed.end + 1)
    counters.rangeBytes += body.length
    counters.bytesWritten += body.length
    const done = trackRange(url, { start: parsed.start, end: parsed.end })
    const finalize = () => done()
    res.on('close', finalize)
    res.on('finish', finalize)
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'Content-Length': String(body.length),
    })
    if (config.rangedDelayMs > 0) await sleep(config.rangedDelayMs)
    if (res.destroyed || res.writableEnded) {
      recordEnd(entry, res)
      return
    }
    try {
      res.end(body)
    } catch {
      /* client vanished while flushing */
    }
    recordEnd(entry, res)
  }

  async function serveSlow(req, res, { size, buffer, url, params, etag = '"slow-v1"', lastModified = 'Wed, 21 Oct 2026 07:28:00 GMT' }) {
    const route = parseRoute(req.url) ?? {}
    const chunkBytes = Math.max(1024, Number(params.get('chunk')) || config.slowChunkBytes)
    const delayMs = Math.max(0, Number(params.get('delayMs') ?? config.slowDelayMs))
    const rangeHeader = req.headers.range
    const parsed = parseRangeHeader(rangeHeader, size)
    const entry = recordStart(req, 'slow')
    attachResGuards(req, res)
    counters.slowResponses += 1

    const base = {
      ...COMMON_HEADERS,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    }

    let status = 200
    let slice = buffer
    let range = null
    if (parsed.kind === 'range') {
      status = 206
      slice = buffer.subarray(parsed.start, parsed.end + 1)
      range = { start: parsed.start, end: parsed.end }
    } else if (parsed.kind === 'multipart' || parsed.kind === 'invalid' || parsed.kind === 'unsatisfiable') {
      entry.status = 416
      send416(res, size, entry)
      return
    }
    entry.range = range
    entry.status = status
    const headers = { ...base, 'Content-Length': String(slice.length) }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    res.writeHead(status, headers)
    const rangeDone = range ? trackRange(url, range) : null
    let aborted = false
    let finished = false
    res.on('close', () => {
      if (!finished) {
        aborted = true
        counters.abortedResponses += 1
        rangeDone?.()
      }
    })
    recordEnd(entry, res)

    let offset = 0
    while (offset < slice.length) {
      if (aborted || res.destroyed || res.writableEnded) return
      const end = Math.min(offset + chunkBytes, slice.length)
      const chunk = slice.subarray(offset, end)
      let ok = false
      try {
        ok = res.write(chunk)
      } catch {
        aborted = true
        counters.abortedResponses += 1
        rangeDone?.()
        return
      }
      counters.bytesWritten += chunk.length
      offset = end
      if (!ok) {
        await new Promise((resolve) => {
          const onDrain = () => {
            cleanup()
            resolve()
          }
          const onClose = () => {
            cleanup()
            aborted = true
            resolve()
          }
          const cleanup = () => {
            res.off('drain', onDrain)
            res.off('close', onClose)
          }
          res.on('drain', onDrain)
          res.on('close', onClose)
        })
      }
      if (delayMs > 0) await sleep(delayMs)
    }
    if (!aborted && !res.destroyed) {
      finished = true
      try {
        res.end()
      } catch {
        /* ignore */
      }
      rangeDone?.()
    }
  }

  async function serveChunked(req, res, { size, url }) {
    const entry = recordStart(req, 'chunked')
    attachResGuards(req, res)
    const buffer = patternBuffer(SEED_MAIN, size)
    // No Content-Length, no Accept-Ranges: total is unknown to the client.
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    })
    entry.status = 200
    recordEnd(entry, res)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const rangeHeader = req.headers.range
    // A probe may send Range 0-0. This server cannot prove ranges; it ignores
    // Range and streams everything (the kernel must fall back to one stream).
    entry.range = null
    const chunk = 64 * 1024
    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
    })
    for (let offset = 0; offset < buffer.length && !aborted; offset += chunk) {
      const piece = buffer.subarray(offset, Math.min(offset + chunk, buffer.length))
      try {
        if (!res.write(piece)) {
          // write returned false: keep pushing, this fixture is fast; but stop
          // when the peer is gone.
          if (res.destroyed) {
            aborted = true
            break
          }
        }
      } catch {
        aborted = true
        break
      }
      counters.bytesWritten += piece.length
    }
    if (!aborted && !res.destroyed) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    void rangeHeader
    void url
  }

  function serveNoRange(req, res, { size }) {
    const entry = recordStart(req, 'norange')
    attachResGuards(req, res)
    const buffer = patternBuffer(SEED_MAIN, size)
    res.writeHead(200, {
      ...COMMON_HEADERS,
      'Content-Length': String(size),
    })
    entry.status = 200
    recordEnd(entry, res)
    try {
      res.end(buffer)
    } catch {
      /* ignore */
    }
    counters.bytesWritten += size
  }

  function serveRedirect(req, res, { pathname }) {
    const route = parseRoute(req.url)
    if (!route) return false
    const entry = recordStart(req, 'redirect')
    attachResGuards(req, res)
    counters.redirects += 1
    let location
    if (pathname.startsWith('/redirect/')) {
      location = `/redirect-2/${route.size}/${route.fileName}${route.query.toString() ? `?${route.query.toString()}` : ''}`
    } else {
      location = `/ranged/${route.size}/${route.fileName}${route.query.toString() ? `?${route.query.toString()}` : ''}`
    }
    res.writeHead(302, { ...COMMON_HEADERS, Location: location, 'Content-Length': '0' })
    entry.status = 302
    recordEnd(entry, res)
    res.end()
    return true
  }

  async function serveFlaky(req, res, { size, url }) {
    const route = parseRoute(req.url) ?? {}
    if (req.method === 'HEAD') {
      const entry = recordStart(req, 'flaky')
      attachResGuards(req, res)
      res.writeHead(200, {
        ...COMMON_HEADERS,
        'Accept-Ranges': 'bytes',
        ETag: '"flaky-v1"',
        'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'Content-Length': String(size),
      })
      entry.status = 200
      recordEnd(entry, res)
      res.end()
      return
    }
    if (state.flakyRemaining > 0) {
      state.flakyRemaining -= 1
      state.flakyRejectedTotal += 1
      counters.flakyRejected += 1
      const entry = recordStart(req, 'flaky')
      attachResGuards(req, res)
      const retryAfter = config.retryAfter
      res.writeHead(429, {
        ...COMMON_HEADERS,
        'Retry-After': retryAfter,
        'Content-Length': '0',
      })
      entry.status = 429
      recordEnd(entry, res)
      res.end()
      return
    }
    void route
    await serveRanged(req, res, {
      size,
      buffer: patternBuffer(SEED_MAIN, size),
      etag: '"flaky-v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      url,
    })
  }

  // ── 0.3.0 route state exposed over HTTP for out-of-process harnesses ──────
  function volatileState() {
    const tokens = state.volatileTokens.slice()
    return {
      redirects: counters.volatileRedirects,
      served: counters.volatileServed,
      tokens,
      uniqueTokens: new Set(tokens).size,
      etag: VOLATILE_ETAG,
    }
  }

  function authKeyState() {
    return { redirects: counters.authKeyRedirects, served: counters.authKeyServed, etag: AUTH_KEY_ETAG }
  }

  function stateSnapshot() {
    return {
      counters: { ...counters },
      volatile: volatileState(),
      authKey: authKeyState(),
      requestCount: requestLog.length,
      changedVersion: state.changedVersion,
      flakyRemaining: state.flakyRemaining,
    }
  }

  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/__fixture/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, authKeySecret: AUTH_KEY_SECRET, etags: { ranged: '"ranged-v1"', volatile: VOLATILE_ETAG, authkey: AUTH_KEY_ETAG } }))
      return
    }
    if (req.method === 'GET' && req.url === '/__fixture/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(stateSnapshot()))
      return
    }
    const route = parseRoute(req.url)
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const { mode, size, fileName, query, pathname } = route
    const url = `${origin}${req.url}`
    switch (mode) {
      case 'redirect':
      case 'redirect-2':
        serveRedirect(req, res, { pathname })
        return
      case 'ranged':
        await serveRanged(req, res, {
          size,
          buffer: patternBuffer(SEED_MAIN, size),
          etag: '"ranged-v1"',
          lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
          url,
        })
        return
      case 'norange':
        serveNoRange(req, res, { size })
        return
      case 'slow':
        await serveSlow(req, res, { size, buffer: patternBuffer(SEED_MAIN, size), url, params: query })
        return
      case 'changed': {
        const changedBuffer =
          state.changedVersion === 'v1'
            ? patternBuffer(SEED_MAIN, size)
            : patternBuffer(SEED_CHANGED_V2, size)
        const changedEtag = `"changed-${state.changedVersion}"`
        if (query.get('slow') === '1') {
          await serveSlow(req, res, {
            size,
            buffer: changedBuffer,
            url,
            params: query,
            etag: changedEtag,
            lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
          })
        } else {
          await serveRanged(req, res, {
            size,
            buffer: changedBuffer,
            etag: changedEtag,
            lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
            url,
          })
        }
        return
      }
      case 'flaky':
        await serveFlaky(req, res, { size, url })
        return
      case 'volatile':
        await serveVolatile(req, res, { size, url, query, pathname })
        return
      case 'authkey':
        await serveAuthKey(req, res, { size, url, query, pathname })
        return
      case 'corrupt':
        await serveRanged(req, res, {
          size,
          buffer: corruptBuffer(size),
          etag: '"corrupt-v1"',
          lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
          url,
        })
        return
      case 'chunked':
        await serveChunked(req, res, { size, url })
        return
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('unknown mode')
        return
    }
    void fileName
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' })
        res.end()
      } catch {
        /* ignore */
      }
    })
  })
  server.keepAliveTimeout = 5000
  server.headersTimeout = 10000
  server.on('connection', (socket) => {
    sockets.add(socket)
    counters.connections += 1
    counters.activeConnections += 1
    if (counters.activeConnections > counters.maxActiveConnections) {
      counters.maxActiveConnections = counters.activeConnections
    }
    socket.on('close', () => {
      sockets.delete(socket)
      counters.activeConnections -= 1
    })
    socket.on('error', () => {})
  })
  server.on('clientError', (_err, socket) => {
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const origin = `http://${config.host}:${port}`

  // ── interval overlap over the recorded range requests ─────────────────────
  function overlapFor(filter) {
    const matches = rangeIntervals.filter((iv) =>
      typeof filter === 'function' ? filter(iv) : String(iv.url).includes(String(filter)),
    )
    if (matches.length === 0) return { count: 0, maxOverlap: 0 }
    const now = performance.now()
    const events = []
    for (const iv of matches) {
      events.push({ t: iv.t0, delta: 1 })
      events.push({ t: iv.t1 ?? now, delta: -1 })
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta)
    let current = 0
    let maxOverlap = 0
    for (const ev of events) {
      current += ev.delta
      if (current > maxOverlap) maxOverlap = current
    }
    return { count: matches.length, maxOverlap }
  }

  function requestsFor(filter, { method = null } = {}) {
    return requestLog.filter((entry) => {
      if (method && entry.method !== method) return false
      if (typeof filter === 'function') return filter(entry)
      return String(entry.url).includes(String(filter))
    })
  }

  const fixture = {
    url: origin,
    origin,
    port,
    host: config.host,
    options: config,
    counters,
    requestLog,
    rangeIntervals,
    urlFor(mode, size, fileName, query = '') {
      const q = query ? (query.startsWith('?') ? query : `?${query}`) : ''
      return `${origin}/${mode}/${size}/${encodeURIComponent(fileName)}${q}`
    },
    /** deterministic expected file for a size: { size, sha256 } */
    expected(size) {
      return { size, sha256: shaOf(SEED_MAIN, size) }
    },
    /** corrupt route: { size, sha256 (served bytes), expectedSha256 (main pattern) } */
    corruptInfo(size) {
      return {
        size,
        sha256: sha256(corruptBuffer(size)),
        expectedSha256: shaOf(SEED_MAIN, size),
      }
    },
    /** changed route content hashes: { v1: hex, v2: hex } */
    changedInfo(size) {
      return {
        v1: shaOf(SEED_MAIN, size),
        v2: shaOf(SEED_CHANGED_V2, size),
      }
    },
    flipChanged() {
      state.changedVersion = state.changedVersion === 'v1' ? 'v2' : 'v1'
      return state.changedVersion
    },
    changedVersion() {
      return state.changedVersion
    },
    armFlaky(count = config.flakyFailures) {
      state.flakyRemaining = count
      return state.flakyRemaining
    },
    flakyState() {
      return { remaining: state.flakyRemaining, rejectedTotal: state.flakyRejectedTotal }
    },
    stats() {
      return {
        counters: { ...counters },
        requestCount: requestLog.length,
        rangeIntervalCount: rangeIntervals.length,
        changedVersion: state.changedVersion,
        flakyRemaining: state.flakyRemaining,
      }
    },
    resetCounters() {
      for (const key of Object.keys(counters)) counters[key] = 0
      requestLog.length = 0
      rangeIntervals.length = 0
      state.volatileTokens.length = 0
      requestSeq = 0
    },
    /** 0.3.0 resume fixture: minted tokens + redirect/served counters. */
    volatileState,
    /** 0.3.0 redaction fixture: redirect/served counters + stable etag. */
    authKeyState,
    /** Bearer token served by the `/authkey/` redirect (for leak assertions). */
    authKeySecret: AUTH_KEY_SECRET,
    urlForVolatile(size, fileName, query = '') {
      const q = query ? (query.startsWith('?') ? query : `?${query}`) : ''
      return `${origin}/volatile/${size}/${encodeURIComponent(fileName)}${q}`
    },
    urlForAuthKey(size, fileName, query = '') {
      const q = query ? (query.startsWith('?') ? query : `?${query}`) : ''
      return `${origin}/authkey/${size}/${encodeURIComponent(fileName)}${q}`
    },
    overlapFor,
    requestsFor,
    rangeRequestsFor(filter) {
      return requestsFor(filter, { method: 'GET' }).filter((entry) => entry.range !== null)
    },
    async close() {
      if (closing) return closing
      closing = new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
        try {
          server.closeAllConnections?.()
        } catch {
          /* ignore */
        }
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
        }
      })
      return closing
    },
  }

  return fixture
}

/** Minimal fetch-style helper used by the fixture self-test. */
export function fetchText(url, { method = 'GET', headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`fixture request timeout after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    req.end()
  })
}

export const FIXTURE_CONSTANTS = { MIB, SEED_MAIN, SEED_CHANGED_V2, AUTH_KEY_SECRET, VOLATILE_ETAG, AUTH_KEY_ETAG }
