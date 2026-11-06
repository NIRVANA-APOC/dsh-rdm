// Kernel performance harness: isolates where a download spends its time.
//
// Measures, against the in-process fixture server:
//   * kernel transfers across a parameter matrix (connections, chunk size,
//     single stream) with wall time, task-reported elapsed time, range-request
//     count / overlap, kernel CPU time and byte-exact verification;
//   * baselines that separate origin capacity from client capacity:
//       - curl single-stream to NUL (loopback + server, no disk write)
//       - curl single-stream to a real file (adds the disk write)
//       - N parallel curl range requests to NUL (server under N connections)
//       - node fs.writeSync of the same payload (disk write only)
//   * optional varied fixture `rangedDelayMs` so a scheduler that queues on a
//     slow origin is visible separately from raw throughput.
//
// Usage:
//   node tests/perf.mjs --kernel kernel/target/release/rdm-kernel.exe \
//       --size 64 --runs 3 --out tests/.bench/baseline.json
//
//   node tests/perf.mjs --help
//
// Every measurement is JSON: { id, label, config, runs, median, p95, ... }.
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import { startFixtureServer } from './fixture-server.mjs'
import {
  launchKernel,
  makeTempDir,
  removeDir,
  sha256File,
  RDM_ROOT,
  TEST_TMP_ROOT,
} from './kernel-client.mjs'

const MIB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs(argv) {
  const args = { kernel: '', size: 64, runs: 3, out: '', matrix: 'default', delay: 0, origin: '', baselines: true, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--kernel': args.kernel = value; i += 1; break
      case '--size': args.size = Number(value); i += 1; break
      case '--runs': args.runs = Number(value); i += 1; break
      case '--out': args.out = value; i += 1; break
      case '--matrix': args.matrix = value; i += 1; break
      case '--delay': args.delay = Number(value); i += 1; break
      case '--origin': args.origin = value; i += 1; break
      case '--no-baselines': args.baselines = false; break
      case '--help': args.help = true; break
      default:
        if (key.startsWith('--')) throw new Error(`unknown argument ${key}`)
    }
  }
  return args
}

/** Start the zero-dependency native range origin; returns { url, close }. */
function startNativeOrigin(exe, size) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve(exe), ['--size', String(size)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = /PORT (\d+)/.exec(buffer)
      if (match) {
        resolve({
          url: `http://127.0.0.1:${match[1]}/big.bin`,
          close: () => new Promise((done) => {
            child.once('exit', () => done())
            child.kill()
          }),
        })
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`origin exited early (code ${code})`)))
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('exit', () => resolve(out.trim()))
  })
}

/** Total CPU milliseconds of one live process, or null when unavailable. */
async function processCpuMs(pid) {
  if (pid === null || pid === undefined) return null
  if (process.platform === 'win32') {
    const out = await runPowerShell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [math]::Round($p.TotalProcessorTime.TotalMilliseconds) }`,
    )
    const value = Number(out)
    return Number.isFinite(value) ? value : null
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // utime (14) and stime (15) after the command name, in clock ticks.
    const ticks = Number(fields[11]) + Number(fields[12])
    return (ticks / 100) * 1000
  } catch {
    return null
  }
}

function execCurl(args) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn('curl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ ok: false, error: error.message, wallMs: performance.now() - started }))
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr, wallMs: performance.now() - started }))
  })
}

/** Full-body GET to a sink without curl, to see the fixture's own ceiling. */
function nodeGetToNull(url, { concurrency = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
    const started = performance.now()
    let bytes = 0
    let done = 0
    for (let i = 0; i < concurrency; i += 1) {
      const req = http.get(url, { agent }, (res) => {
        res.on('data', (chunk) => { bytes += chunk.length })
        res.on('end', () => {
          done += 1
          if (done === concurrency) {
            agent.destroy()
            resolve({ bytes, wallMs: performance.now() - started })
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
    }
  })
}

function rangeHeader(start, endInclusive) {
  return `bytes=${start}-${endInclusive}`
}

/** N parallel curl range requests with explicit byte slices, to NUL. */
async function parallelCurlRanges(url, size, count) {
  const slice = Math.ceil(size / count)
  const started = performance.now()
  const jobs = []
  for (let i = 0; i < count; i += 1) {
    const start = i * slice
    if (start >= size) break
    const end = Math.min(size - 1, start + slice - 1)
    jobs.push(execCurl(['-sS', '-o', 'NUL', '--noproxy', '*', '-4', '-r', rangeHeader(start, end), url]))
  }
  const results = await Promise.all(jobs)
  return {
    wallMs: performance.now() - started,
    ok: results.every((entry) => entry.ok),
    errors: results.filter((entry) => !entry.ok).map((entry) => entry.error ?? entry.stderr),
  }
}

async function diskWriteBaseline(dir, size) {
  const file = path.join(dir, 'disk-baseline.bin')
  const buffer = Buffer.alloc(4 * MIB, 0x5a)
  const fd = fsp.openSync(file, 'w')
  const started = performance.now()
  let written = 0
  try {
    while (written < size) {
      const chunk = Math.min(buffer.length, size - written)
      fsp.writeSync(fd, buffer, 0, chunk)
      written += chunk
    }
    fsp.fsyncSync(fd)
  } finally {
    fsp.closeSync(fd)
  }
  const wallMs = performance.now() - started
  await fs.rm(file, { force: true })
  return { wallMs, mibPerSec: size / MIB / (wallMs / 1000) }
}

function defaultMatrix() {
  const rows = []
  for (const connections of [1, 2, 4, 8, 16]) {
    rows.push({ id: `conn-${connections}`, connections, chunkSizeBytes: 0 })
  }
  for (const chunkSizeBytes of [1 * MIB, 4 * MIB, 16 * MIB]) {
    rows.push({ id: `conn-8-chunk-${chunkSizeBytes / MIB}MiB`, connections: 8, chunkSizeBytes })
  }
  rows.push({ id: 'single-stream', connections: 1, chunkSizeBytes: 0, singleStream: true })
  return rows
}

async function measureKernelRun(kernel, target, { size, fileName, dir, config }) {
  if (target.fixture !== null) target.fixture.resetCounters()
  const cpuBefore = await processCpuMs(kernel.pid)
  const wallStart = performance.now()
  const requestedAt = Date.now()
  const started = await kernel.start({
    url: target.url,
    dir,
    connections: config.connections,
    chunkSizeBytes: config.chunkSizeBytes,
    singleStream: config.singleStream === true,
  })
  const { task } = await kernel.waitTerminal(started.task.id, 600000)
  const wallMs = performance.now() - wallStart
  const cpuAfter = await processCpuMs(kernel.pid)
  const expectedSha = target.fixture !== null ? target.fixture.expected(size).sha256 : target.expectedSha256
  const filePath = task?.path
  let digestOk = false
  if (filePath && fsp.existsSync(filePath)) {
    digestOk = expectedSha !== null ? (await sha256File(filePath)) === expectedSha : fsp.statSync(filePath).size === size
  }
  // Event phases: probe/IPC, transfer, finalize (fsync + optional hash + rename).
  let phases = null
  try {
    const { events } = await kernel.get(started.task.id, 100)
    const firstProbe = events.find((event) => event.kind === 'probe')
    const plan = events.find((event) => event.kind === 'plan')
    const startedEvent = events.find((event) => event.kind === 'started')
    const finishedEvent = [...events].reverse().find((event) => event.kind === 'info' && /^finished in/.test(event.message ?? ''))
    const last = events.at(-1)
    if (firstProbe && plan && startedEvent && finishedEvent && last) {
      phases = {
        probeMs: plan.at - requestedAt,
        transferMs: finishedEvent.at - startedEvent.at,
        finalizeMs: last.at - finishedEvent.at,
      }
    }
  } catch {
    phases = null
  }
  const overlap = target.fixture !== null ? target.fixture.overlapFor(fileName) : { count: null, maxOverlap: null }
  const rangeRequests = target.fixture !== null
    ? target.fixture.requestsFor(fileName, { method: 'GET' }).filter((entry) => entry.range !== null).length
    : null
  const bytes = task?.downloaded ?? 0
  const elapsedMs = task?.elapsedMs ?? wallMs
  return {
    status: task?.status ?? 'missing',
    ok: task?.status === 'completed' && digestOk,
    digestOk,
    wallMs: round(wallMs, 1),
    elapsedMs,
    mibPerSec: round(size / MIB / (elapsedMs / 1000), 2),
    wallMibPerSec: round(size / MIB / (wallMs / 1000), 2),
    rangeRequests,
    maxOverlap: overlap.maxOverlap,
    peakWorkers: task?.peakWorkers ?? null,
    connections: task?.connections ?? null,
    chunkSize: task?.chunkSize ?? null,
    retries: task?.retries ?? null,
    cpuMs: cpuBefore !== null && cpuAfter !== null ? Math.round(cpuAfter - cpuBefore) : null,
    cpuPerMiB: cpuBefore !== null && cpuAfter !== null ? round((cpuAfter - cpuBefore) / (size / MIB), 2) : null,
    phases,
    bytes,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node tests/perf.mjs --kernel <path> [--size MiB] [--runs N] [--delay MS] [--out file]')
    return
  }
  if (args.kernel === '') {
    args.kernel = path.join(RDM_ROOT, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rdm-kernel.exe' : 'rdm-kernel')
  }
  const kernelPath = path.resolve(args.kernel)
  if (!fsp.existsSync(kernelPath)) throw new Error(`kernel binary not found: ${kernelPath}`)
  const size = Math.max(1, Math.round(args.size * MIB))
  const runs = Math.max(1, Math.round(args.runs))
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true })
  const root = await makeTempDir('dsh-rdm-perf-')
  const dir = path.join(root, 'downloads')
  await fs.mkdir(dir, { recursive: true })
  const fixture = args.origin === '' ? await startFixtureServer({ rangedDelayMs: args.delay, flakyFailures: 0 }) : null
  const nativeOrigin = args.origin === '' ? null : await startNativeOrigin(args.origin, size)
  const target = {
    fixture,
    url: nativeOrigin !== null ? nativeOrigin.url : fixture.urlFor('ranged', size, 'baseline.bin'),
    expectedSha256: fixture !== null ? null : null,
  }
  const startedAt = new Date().toISOString()
  const results = {
    startedAt,
    kernelPath,
    size,
    runs,
    delayMs: args.delay,
    origin: nativeOrigin !== null ? path.resolve(args.origin) : 'fixture',
    kernel: [],
    baselines: [],
  }
  let kernel = null
  try {
    kernel = await launchKernel(kernelPath, { dataDir: path.join(root, 'data'), logLevel: 'warn', label: 'perf' })
    await kernel.initialize({ defaultDir: dir })
    const version = kernel.ready?.kernel?.version ?? 'unknown'
    results.kernelVersion = version

    // Warm up: first transfer pays connection pool + page-cache costs.
    await measureKernelRun(kernel, target, {
      size: Math.min(size, 8 * MIB),
      fileName: 'warmup.bin',
      dir,
      config: { connections: 8, chunkSizeBytes: 0 },
    })

    const matrix = args.matrix === 'default' ? defaultMatrix() : JSON.parse(await fs.readFile(args.matrix, 'utf8'))
    for (const config of matrix) {
      const samples = []
      for (let run = 0; run < runs; run += 1) {
        const sample = await measureKernelRun(kernel, target, {
          size,
          fileName: `${config.id.replace(/[^a-z0-9.-]+/gi, '-')}-${run}.bin`,
          dir,
          config,
        })
        samples.push(sample)
      }
      const ok = samples.every((sample) => sample.ok)
      const phaseMedian = (key) => {
        const values = samples.map((sample) => sample.phases?.[key]).filter((value) => typeof value === 'number')
        return values.length === 0 ? null : Math.round(median(values))
      }
      results.kernel.push({
        id: config.id,
        config,
        ok,
        runs: samples,
        median: {
          mibPerSec: round(median(samples.map((sample) => sample.mibPerSec)), 2),
          wallMibPerSec: round(median(samples.map((sample) => sample.wallMibPerSec)), 2),
          wallMs: round(median(samples.map((sample) => sample.wallMs)), 1),
          elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
          cpuMs: median(samples.map((sample) => sample.cpuMs ?? 0)),
          cpuPerMiB: round(median(samples.map((sample) => sample.cpuPerMiB ?? 0)), 2),
          rangeRequests: samples.every((sample) => sample.rangeRequests === null)
            ? null
            : median(samples.map((sample) => sample.rangeRequests ?? 0)),
          maxOverlap: median(samples.map((sample) => sample.maxOverlap ?? 0)),
          peakWorkers: median(samples.map((sample) => sample.peakWorkers ?? 0)),
          p95MibPerSec: round(p95(samples.map((sample) => sample.mibPerSec)), 2),
          probeMs: phaseMedian('probeMs'),
          transferMs: phaseMedian('transferMs'),
          finalizeMs: phaseMedian('finalizeMs'),
        },
      })
      const row = results.kernel.at(-1)
      console.log(
        `${config.id.padEnd(22)} ${String(row.median.mibPerSec).padStart(8)} MiB/s  ` +
          `wall ${String(row.median.wallMs).padStart(7)} ms  cpu ${String(row.median.cpuPerMiB).padStart(6)} ms/MiB  ` +
          `phases ${row.median.probeMs}/${row.median.transferMs}/${row.median.finalizeMs} ms  ` +
          `req ${String(row.median.rangeRequests ?? '-').padStart(3)}  overlap ${row.median.maxOverlap}  ` +
          `${ok ? 'ok' : 'FAILED'}`,
      )
    }

    const url = target.url
    if (args.baselines) {
    // Baseline 1: curl single stream to NUL (no disk write).
    {
      const curlSamples = []
      for (let run = 0; run < runs; run += 1) {
        const result = await execCurl(['-sS', '-o', 'NUL', '-w', '%{speed_download}', '--noproxy', '*', '-4', url])
        if (result.ok) curlSamples.push(Number(result.stdout.trim()))
      }
      results.baselines.push({
        id: 'curl-single-nul',
        ok: curlSamples.length > 0,
        medianMibPerSec: curlSamples.length > 0 ? round(median(curlSamples) / MIB, 2) : null,
        samples: curlSamples.map((value) => round(value / MIB, 2)),
      })
    }
    // Baseline 2: curl single stream to a real file (adds the disk write).
    {
      const curlSamples = []
      for (let run = 0; run < runs; run += 1) {
        const target = path.join(dir, `curl-${run}.bin`)
        const result = await execCurl(['-sS', '-o', target, '-w', '%{speed_download}', '--noproxy', '*', '-4', url])
        if (result.ok) curlSamples.push(Number(result.stdout.trim()))
        await fs.rm(target, { force: true })
      }
      results.baselines.push({
        id: 'curl-single-file',
        ok: curlSamples.length > 0,
        medianMibPerSec: curlSamples.length > 0 ? round(median(curlSamples) / MIB, 2) : null,
        samples: curlSamples.map((value) => round(value / MIB, 2)),
      })
    }
    // Baseline 3: N parallel curl range requests (server under N clients).
    for (const count of [4, 8]) {
      const samples = []
      for (let run = 0; run < runs; run += 1) {
        const result = await parallelCurlRanges(url, size, count)
        if (result.ok) samples.push(round(size / MIB / (result.wallMs / 1000), 2))
      }
      results.baselines.push({
        id: `curl-ranges-${count}`,
        ok: samples.length > 0,
        medianMibPerSec: samples.length > 0 ? round(median(samples), 2) : null,
        samples,
      })
    }
    // Baseline 4: node client full-body GET (no disk).
    {
      const samples = []
      for (let run = 0; run < runs; run += 1) {
        const result = await nodeGetToNull(url, { concurrency: 1 })
        samples.push(round(size / MIB / (result.wallMs / 1000), 2))
      }
      results.baselines.push({
        id: 'node-single-nul',
        ok: true,
        medianMibPerSec: round(median(samples), 2),
        samples,
      })
    }
    // Baseline 5: the disk alone.
    {
      const samples = []
      for (let run = 0; run < runs; run += 1) samples.push(round((await diskWriteBaseline(dir, size)).mibPerSec, 2))
      results.baselines.push({
        id: 'disk-write',
        ok: true,
        medianMibPerSec: round(median(samples), 2),
        samples,
      })
    }

    for (const baseline of results.baselines) {
      console.log(`${baseline.id.padEnd(22)} ${String(baseline.medianMibPerSec).padStart(8)} MiB/s  ${baseline.ok ? '' : 'FAILED'}`)
    }
    }
  } finally {
    if (kernel !== null && !kernel.exited.at) {
      try {
        await kernel.shutdown({ timeoutMs: 8000 })
      } catch {
        await kernel.kill()
      }
    }
    await fixture?.close()
    if (nativeOrigin !== null) await nativeOrigin.close()
    results.finishedAt = new Date().toISOString()
    if (args.out !== '') {
      const out = path.resolve(args.out)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, `${JSON.stringify(results, null, 2)}\n`)
      console.log(`\nwrote ${out}`)
    }
    await removeDir(root)
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
