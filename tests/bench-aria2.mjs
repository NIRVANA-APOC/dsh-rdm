// Benchmark: dsh-rdm's Rust kernel vs aria2c, on one native loopback origin.
//
// Both clients pull the same deterministic byte range origin (tests/perf-origin.rs,
// compiled with rustc -O) so the measurement is client-bound, not Node-bound.
//
// Scenes
//   1. throughput     size MiB at 1/4/8/16/32 kernel connections vs aria2 -x/-s 1/4/8/16
//   2. batch          N x size MiB back-to-back in ONE aria2 process (-Z) vs N kernel tasks
//                     (CPU per MiB is accurate here: one long-lived process on both sides)
//   3. small files    20 x 1 MiB: kernel reuses its warm process, aria2 pays a spawn each
//   4. idle           resident memory of the kernel vs aria2 in RPC mode (its only resident form)
//
// Every number is measured, not assumed. Peak working set is *sampled* through
// PowerShell (~1 sample / 140 ms); for short runs the sampled peak is a floor,
// which is stated in the report.
//
// Usage:
//   node tests/bench-aria2.mjs --aria2 .tmp/bench/aria2/.../aria2c.exe
//   node tests/bench-aria2.mjs --help
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import { launchKernel, makeTempDir, removeDir, sha256File, RDM_ROOT } from './kernel-client.mjs'

const MIB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs(argv) {
  const args = {
    kernel: '',
    aria2: '',
    origin: '',
    size: 256,
    runs: 3,
    batch: 4,
    small: 20,
    out: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--kernel': args.kernel = value; i += 1; break
      case '--aria2': args.aria2 = value; i += 1; break
      case '--origin': args.origin = value; i += 1; break
      case '--size': args.size = Number(value); i += 1; break
      case '--runs': args.runs = Number(value); i += 1; break
      case '--batch': args.batch = Number(value); i += 1; break
      case '--small': args.small = Number(value); i += 1; break
      case '--out': args.out = value; i += 1; break
      case '--help': args.help = true; break
      default:
        if (key.startsWith('--')) throw new Error(`unknown argument ${key}`)
    }
  }
  return args
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
const round = (value, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ── process sampling ────────────────────────────────────────────────────────

function psSample(pid) {
  return new Promise((resolve) => {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($p) { "$($p.WorkingSet64) $($p.PeakWorkingSet64) $([math]::Round($p.TotalProcessorTime.TotalMilliseconds))" }`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      const parts = out.trim().split(/\s+/).map(Number)
      resolve(parts.length === 3 && parts.every(Number.isFinite)
        ? { ws: parts[0], peak: parts[1], cpuMs: parts[2] }
        : null)
    })
  })
}

/** Sample one pid until stop() is called; keeps last CPU and largest working set. */
function startWatch(pid) {
  const state = { peak: 0, lastWs: 0, lastCpuMs: 0, samples: 0, stopped: false }
  const loop = (async () => {
    while (!state.stopped) {
      const sample = await psSample(pid)
      if (sample) {
        state.peak = Math.max(state.peak, sample.peak)
        state.lastWs = sample.ws
        state.lastCpuMs = Math.max(state.lastCpuMs, sample.cpuMs)
        state.samples += 1
      }
      await sleep(20)
    }
  })()
  return {
    state,
    stop: async () => {
      state.stopped = true
      await loop
      return {
        peakMiB: state.peak > 0 ? round(state.peak / MIB, 2) : null,
        lastWsMiB: state.lastWs > 0 ? round(state.lastWs / MIB, 2) : null,
        cpuMs: state.lastCpuMs > 0 ? Math.round(state.lastCpuMs) : null,
        samples: state.samples,
      }
    },
  }
}

// ── clients ─────────────────────────────────────────────────────────────────

function startOrigin(exe, size) {
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
          url: (name) => `http://127.0.0.1:${match[1]}/${name}`,
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

async function withOrigin(exe, size, fn) {
  const origin = await startOrigin(exe, size)
  try {
    return await fn(origin)
  } finally {
  }
}

const ARIA2_SUMMARY = /([\d.]+)\s*([KMG])iB\/s/

function parseAria2Speed(stdout) {
  const matches = [...stdout.matchAll(new RegExp(ARIA2_SUMMARY, 'g'))]
  if (matches.length === 0) return null
  const [, number, unit] = matches.at(-1)
  const scale = unit === 'G' ? 1024 : unit === 'M' ? 1 : 1 / 1024
  const value = Number(number) * scale
  return Number.isFinite(value) ? value : null
}

/** One aria2c invocation. Resolves with wall time, its own reported speed, sampled memory. */
function runAria2(exe, { urls, dir, connections, sample = false, extra = [] }) {
  const args = [
    ...urls,
    '-x', String(connections),
    '-s', String(connections),
    '-k', '4M',
    '--min-split-size=4M',
    '--file-allocation=none',
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--console-log-level=warn',
    '--summary-interval=0',
    '-d', dir,
    ...extra,
  ]
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(path.resolve(exe), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const watcher = sample && child.pid ? startWatch(child.pid) : null
    child.on('error', (error) => resolve({ ok: false, error: error.message, wallMs: performance.now() - started }))
    child.on('exit', async (code) => {
      const wallMs = performance.now() - started
      const memory = watcher ? await watcher.stop() : null
      resolve({
        ok: code === 0,
        code,
        wallMs,
        engineMibps: parseAria2Speed(stdout),
        memory,
        stderr: stderr.slice(-600),
      })
    })
  })
}

async function runKernelTask(kernel, { url, dir, connections, sample = false }) {
  const watcher = sample && kernel.pid ? startWatch(kernel.pid) : null
  const started = performance.now()
  const { task } = await kernel.start({ url, dir, connections, chunkSizeBytes: 0 })
  const { task: final } = await kernel.waitTerminal(task.id, 600000)
  const wallMs = performance.now() - started
  const memory = watcher ? await watcher.stop() : null
  const elapsedMs = final?.elapsedMs && final.elapsedMs > 0 ? final.elapsedMs : null
  return {
    ok: final?.status === 'completed',
    status: final?.status,
    wallMs,
    engineMibps: elapsedMs ? null : null,
    elapsedMs,
    peakWorkers: final?.peakWorkers ?? null,
    connections: final?.connections ?? null,
    memory,
    path: final?.path ?? null,
    downloaded: final?.downloaded ?? 0,
  }
}

// ── scenes ──────────────────────────────────────────────────────────────────

async function sceneThroughput({ kernel, aria2, originPath, size, runs, dir, log }) {
  const rows = []
  const matrix = [
    { id: 'connect-1', kernel: 1, aria2: 1 },
    { id: 'connect-4', kernel: 4, aria2: 4 },
    { id: 'connect-8', kernel: 8, aria2: 8 },
    { id: 'connect-16', kernel: 16, aria2: 16 },
    { id: 'connect-32', kernel: 32, aria2: null },
  ]
  for (const config of matrix) {
    const row = { id: config.id, connections: config.kernel, kernel: null, aria2: null }

    const kernelSamples = await withOrigin(originPath, size, async (origin) => {
      const samples = []
      for (let run = 0; run < runs; run += 1) {
        const name = `tput-${config.id}-k-${run}.bin`
        const result = await runKernelTask(kernel, { url: origin.url(name), dir, connections: config.kernel, sample: run === 0 })
        const file = path.join(dir, name)
        const bytes = fsp.existsSync(file) ? fsp.statSync(file).size : 0
        if (!result.ok || bytes !== size) {
          throw new Error(`kernel run failed at ${config.id} run ${run} (${result.status}, ${bytes}/${size})`)
        }
        samples.push({
          mibps: size / MIB / ((result.elapsedMs ?? result.wallMs) / 1000),
          wallMs: result.wallMs,
          memory: result.memory,
          peakWorkers: result.peakWorkers,
        })
        await fs.rm(file, { force: true })
      }
      return samples
    })
    row.kernel = {
      mibps: round(median(kernelSamples.map((s) => s.mibps)), 1),
      wallMs: Math.round(median(kernelSamples.map((s) => s.wallMs))),
      peakWorkers: median(kernelSamples.map((s) => s.peakWorkers ?? 0)),
      memory: kernelSamples[0].memory,
    }

    if (config.aria2 !== null) {
      const aria2Samples = await withOrigin(originPath, size, async (origin) => {
        const samples = []
        for (let run = 0; run < runs; run += 1) {
          const name = `tput-${config.id}-a-${run}.bin`
          const result = await runAria2(aria2, { urls: [origin.url(name)], dir, connections: config.aria2, sample: run === 0 })
          const file = path.join(dir, name)
          const bytes = fsp.existsSync(file) ? fsp.statSync(file).size : 0
          if (!result.ok || bytes !== size) {
            throw new Error(`aria2 run failed at ${config.id} run ${run} (code ${result.code}, ${bytes}/${size}) ${result.stderr ?? ''}`)
          }
          samples.push({
            mibps: result.engineMibps ?? size / MIB / (result.wallMs / 1000),
            wallMs: result.wallMs,
            memory: result.memory,
          })
          await fs.rm(file, { force: true })
        }
        return samples
      })
      row.aria2 = {
        mibps: round(median(aria2Samples.map((s) => s.mibps)), 1),
        wallMs: Math.round(median(aria2Samples.map((s) => s.wallMs))),
        memory: aria2Samples[0].memory,
      }
    }
    rows.push(row)
    log(
      `${row.id.padEnd(11)} kernel ${String(row.kernel.mibps).padStart(7)} MiB/s  ` +
        `aria2 ${String(row.aria2?.mibps ?? '-').padStart(7)} MiB/s`,
    )
  }
  return rows
}

async function sceneBatch({ kernel, aria2, originPath, size, batch, dir, log }) {
  const names = Array.from({ length: batch }, (_, i) => `batch-${i}.bin`)
  const total = size * batch

  const kernelCpuBefore = (await psSample(kernel.pid))?.cpuMs ?? null
  const kernelStarted = performance.now()
  await withOrigin(originPath, size, async (origin) => {
    for (const name of names) {
      const result = await runKernelTask(kernel, { url: origin.url(name), dir, connections: 8 })
      if (!result.ok) throw new Error(`kernel batch task failed: ${result.status}`)
    }
  })
  const kernelWall = performance.now() - kernelStarted
  const kernelCpuAfter = (await psSample(kernel.pid))?.cpuMs ?? null
  const kernelResult = {
    mibps: round(total / MIB / (kernelWall / 1000), 1),
    wallMs: Math.round(kernelWall),
    cpuMs: kernelCpuBefore !== null && kernelCpuAfter !== null ? Math.round(kernelCpuAfter - kernelCpuBefore) : null,
    cpuPerMiB: kernelCpuBefore !== null && kernelCpuAfter !== null
      ? round((kernelCpuAfter - kernelCpuBefore) / (total / MIB), 2)
      : null,
  }
  for (const name of names) await fs.rm(path.join(dir, name), { force: true })

  const aria2Started = performance.now()
  const batchRun = await withOrigin(originPath, size, (origin) => runAria2(aria2, {
    urls: names.map((name) => origin.url(name)),
    dir,
    connections: 8,
    sample: true,
    extra: ['--force-sequential=true'],
  }))
  const aria2Wall = performance.now() - aria2Started
  const aria2Result = {
    mibps: round(total / MIB / (aria2Wall / 1000), 1),
    wallMs: Math.round(aria2Wall),
    cpuMs: batchRun.memory?.cpuMs ?? null,
    cpuPerMiB: batchRun.memory?.cpuMs ? round(batchRun.memory.cpuMs / (total / MIB), 2) : null,
    ok: batchRun.ok,
  }
  for (const name of names) await fs.rm(path.join(dir, name), { force: true })

  log(`batch ${batch}x${size / MIB}MiB  kernel ${kernelResult.mibps} MiB/s (cpu ${kernelResult.cpuPerMiB} ms/MiB)  ` +
      `aria2 ${aria2Result.mibps} MiB/s (cpu ${aria2Result.cpuPerMiB} ms/MiB)`)
  return { kernel: kernelResult, aria2: aria2Result }
}

async function sceneSmallFiles({ kernel, aria2, originPath, count, dir, log }) {
  const make = (i) => `small-${i}.bin`

  const kernelStarted = performance.now()
  await withOrigin(originPath, 1024 * 1024, async (origin) => {
    for (let i = 0; i < count; i += 1) {
      const result = await runKernelTask(kernel, { url: origin.url(make(i)), dir, connections: 4 })
      if (!result.ok) throw new Error(`kernel small file ${i} failed: ${result.status}`)
    }
  })
  const kernelWall = performance.now() - kernelStarted
  for (let i = 0; i < count; i += 1) await fs.rm(path.join(dir, make(i)), { force: true })

  const aria2Started = performance.now()
  await withOrigin(originPath, 1024 * 1024, async (origin) => {
    for (let i = 0; i < count; i += 1) {
      const result = await runAria2(aria2, { urls: [origin.url(make(i))], dir, connections: 4 })
      if (!result.ok) throw new Error(`aria2 small file ${i} failed (code ${result.code})`)
    }
  })
  const aria2Wall = performance.now() - aria2Started
  for (let i = 0; i < count; i += 1) await fs.rm(path.join(dir, make(i)), { force: true })

  const result = {
    files: count,
    kernel: { totalMs: Math.round(kernelWall), perFileMs: round(kernelWall / count, 1) },
    aria2: { totalMs: Math.round(aria2Wall), perFileMs: round(aria2Wall / count, 1) },
  }
  log(`small ${count}x1MiB  kernel ${result.kernel.perFileMs} ms/file  aria2 ${result.aria2.perFileMs} ms/file`)
  return result
}

async function sceneIdle({ kernelPath, aria2, dir, log }) {
  // Fresh process: an idle number must not inherit working set from earlier transfers.
  const idleRoot = await makeTempDir('dsh-rdm-bench-idle-')
  const freshKernel = await launchKernel(kernelPath, {
    dataDir: path.join(idleRoot, 'data'),
    logLevel: 'warn',
    label: 'bench-idle',
  })
  await freshKernel.initialize({ defaultDir: path.join(idleRoot, 'downloads') })
  await sleep(3000)
  const kernelIdle = await psSample(freshKernel.pid)
  if (!freshKernel.exited.at) {
    try {
      await freshKernel.shutdown({ timeoutMs: 8000 })
    } catch {
      await freshKernel.kill()
    }
  }
  await removeDir(idleRoot)

  const port = await new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port: found } = server.address()
      server.close(() => resolve(found))
    })
  })
  const rpc = spawn(path.resolve(aria2), [
    '--enable-rpc',
    `--rpc-listen-port=${port}`,
    '--rpc-secret=bench',
    `--dir=${dir}`,
    '--console-log-level=warn',
    '--summary-interval=0',
    '--file-allocation=none',
    '--auto-file-renaming=false',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  await sleep(3000)
  const aria2Idle = rpc.pid ? await psSample(rpc.pid) : null
  if (rpc.pid) {
    await new Promise((resolve) => {
      const kill = spawn('taskkill', ['/PID', String(rpc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      kill.on('exit', () => resolve())
      kill.on('error', () => resolve())
    })
  }

  const result = {
    kernel: kernelIdle ? { rssMiB: round(kernelIdle.ws / MIB, 2), peakMiB: round(kernelIdle.peak / MIB, 2) } : null,
    aria2Rpc: aria2Idle ? { rssMiB: round(aria2Idle.ws / MIB, 2), peakMiB: round(aria2Idle.peak / MIB, 2) } : null,
    aria2Mode: 'RPC server (--enable-rpc), idle 3 s after start',
  }
  log(`idle 3s  kernel ${result.kernel?.rssMiB} MiB rss  aria2-rpc ${result.aria2Rpc?.rssMiB} MiB rss`)
  return result
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node tests/bench-aria2.mjs --aria2 <aria2c.exe> [--kernel <exe>] [--origin <exe>] [--size MiB] [--runs N] [--out file]')
    return
  }
  const kernelPath = path.resolve(args.kernel || path.join(RDM_ROOT, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rdm-kernel.exe' : 'rdm-kernel'))
  const aria2Path = path.resolve(args.aria2)
  const originPath = path.resolve(args.origin || path.join(RDM_ROOT, '.tmp', 'bench', 'perf-origin.exe'))
  for (const [label, file] of [['kernel', kernelPath], ['aria2', aria2Path], ['origin', originPath]]) {
    if (!fsp.existsSync(file)) throw new Error(`${label} binary not found: ${file}`)
  }

  const size = Math.round(args.size * MIB)
  const runs = Math.max(1, args.runs)
  const root = await makeTempDir('dsh-rdm-bench-')
  const dir = path.join(root, 'downloads')
  await fs.mkdir(dir, { recursive: true })

  const log = (line) => console.log(line)
  const results = {
    startedAt: new Date().toISOString(),
    kernelPath,
    aria2Path,
    originPath,
    sizeMiB: args.size,
    runs,
    aria2Version: null,
    kernelVersion: null,
  }
  let kernel = null
  try {
    results.aria2Version = await new Promise((resolve) => {
      const child = spawn(aria2Path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('exit', () => resolve(out.split(/\r?\n/)[0] ?? null))
      child.on('error', () => resolve(null))
    })

    kernel = await launchKernel(kernelPath, { dataDir: path.join(root, 'data'), logLevel: 'warn', label: 'bench' })
    await kernel.initialize({ defaultDir: dir })
    results.kernelVersion = kernel.ready?.kernel?.version ?? null

    // warm both engines once, so page cache / connection pools are not part of run 0
    await withOrigin(originPath, size, async (origin) => {
      await runKernelTask(kernel, { url: origin.url('warm-k.bin'), dir, connections: 8 })
      await runAria2(aria2Path, { urls: [origin.url('warm-a.bin')], dir, connections: 8 })
    })
    await fs.rm(path.join(dir, 'warm-k.bin'), { force: true })
    await fs.rm(path.join(dir, 'warm-a.bin'), { force: true })

    results.throughput = await sceneThroughput({ kernel, aria2: aria2Path, originPath, size, runs, dir, log })
    results.batch = await sceneBatch({ kernel, aria2: aria2Path, originPath, size, batch: args.batch, dir, log })
    results.small = await sceneSmallFiles({ kernel, aria2: aria2Path, originPath, count: args.small, dir, log })
    results.idle = await sceneIdle({ kernelPath, aria2: aria2Path, dir, log })
  } finally {
    if (kernel && !kernel.exited.at) {
      try {
        await kernel.shutdown({ timeoutMs: 8000 })
      } catch {
        await kernel.kill()
      }
    }
    results.finishedAt = new Date().toISOString()
    if (args.out !== '') {
      const out = path.resolve(args.out)
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, `${JSON.stringify(results, null, 2)}\n`)
      log(`\nwrote ${out}`)
    }
    await removeDir(root)
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
