// Real-network multi-source benchmark for the dsh-rdm kernel.
//
// Downloads the SAME public Alpine ISO (219,152,384 B, known SHA-256) from
// real HTTP mirrors and compares:
//   1. single source, slow official CDN
//   2. single source, fast nearby mirror
//   3. sourcePolicy=select with both candidates (automatic selection)
//   4. sourcePolicy=race with three fast mirrors (per-chunk aggregation)
//
// Each scenario gets its own data dir and download dir; the file is verified
// against the published SHA-256 and removed after the measurement.
//
// Run: node tests/real-multi-source-bench.mjs
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  DEFAULT_KERNEL_PATH,
  ensureTestTmpRoot,
  fileSize,
  launchKernel,
  makeTempDir,
  removeDir,
  sha256File,
} from './kernel-client.mjs'

const ISO = 'alpine-standard-3.20.3-x86_64.iso'
const ISO_SIZE = 219152384
const ISO_SHA256 = 'c66fc1e0470781f8ecbab8eb9cc8d906066171a5e0c6c1ab20aedc7061836d27'
const MIRROR_PATH = `v3.20/releases/x86_64/${ISO}`

const MIRRORS = {
  official: `https://dl-cdn.alpinelinux.org/${MIRROR_PATH}`,
  bfsu: `https://mirrors.bfsu.edu.cn/alpine/${MIRROR_PATH}`,
  cernet: `https://mirrors.cernet.edu.cn/alpine/${MIRROR_PATH}`,
  nju: `https://mirror.nju.edu.cn/alpine/${MIRROR_PATH}`,
}

const SCENARIOS = [
  {
    id: 'single:official',
    label: 'single official CDN',
    url: MIRRORS.official,
    sources: [],
    policy: 'single',
    expectSelected: null,
  },
  {
    id: 'single:bfsu',
    label: 'single BFSU mirror',
    url: MIRRORS.bfsu,
    sources: [],
    policy: 'single',
    expectSelected: null,
  },
  {
    id: 'select:official+bfsu',
    label: 'select official + BFSU',
    url: MIRRORS.official,
    sources: [{ url: MIRRORS.bfsu, priority: 1 }],
    policy: 'select',
    expectSelected: 1,
  },
  {
    id: 'race:bfsu+cernet',
    label: 'race BFSU + CERNET',
    url: MIRRORS.bfsu,
    sources: [{ url: MIRRORS.cernet, priority: 1 }],
    policy: 'race',
    expectSelected: null,
  },
  {
    id: 'race:bfsu+cernet+nju',
    label: 'race BFSU + CERNET + NJU',
    url: MIRRORS.bfsu,
    sources: [
      { url: MIRRORS.cernet, priority: 1 },
      { url: MIRRORS.nju, priority: 2 },
    ],
    policy: 'race',
    expectSelected: null,
  },
]

const MB = 1024 * 1024

async function runScenario(scenario) {
  const dataDir = await makeTempDir(`bench-data-${scenario.id.replace(/[^a-z0-9]+/gi, '-')}`)
  const downloadDir = await makeTempDir(`bench-dl-${scenario.id.replace(/[^a-z0-9]+/gi, '-')}`)
  const kernel = await launchKernel(DEFAULT_KERNEL_PATH, { dataDir, logLevel: 'warn', label: scenario.id })
  let task = null
  let detail = null
  let wallMs = 0
  let startedAt = 0
  try {
    await kernel.initialize({ defaultDir: downloadDir, connections: 8, maxConnections: 32, autoResume: false, maxAttempts: 6 })
    startedAt = performance.now()
    const start = await kernel.start({
      url: scenario.url,
      sources: scenario.sources,
      sourcePolicy: scenario.policy,
      expectedSha256: ISO_SHA256,
      dir: downloadDir,
      fileName: ISO,
      connections: 8,
      maxConnections: 32,
    })
    const startTask = start?.task
    if (!startTask?.id) throw new Error(`start returned no task: ${JSON.stringify(start)}`)
    const settled = await kernel.waitTerminal(startTask.id, 300_000)
    task = settled.task ?? (await kernel.get(startTask.id, 0))?.task
    wallMs = performance.now() - startedAt
    detail = task ? (await kernel.get(task.id, 0))?.detail ?? null : null
    if (task?.status !== 'completed') {
      throw new Error(`task ${task?.status}: ${JSON.stringify(task?.error ?? null)}`)
    }
    const target = path.join(downloadDir, ISO)
    const size = await fileSize(target)
    if (size !== ISO_SIZE) throw new Error(`size ${size} != ${ISO_SIZE}`)
    const digest = await sha256File(target)
    if (digest !== ISO_SHA256) throw new Error(`sha256 ${digest} != ${ISO_SHA256}`)
    const transferMs = detail?.timing?.transferMs ?? null
    const effectiveMbps = transferMs && transferMs > 0 ? (ISO_SIZE / MB) / (transferMs / 1000) : null
    return {
      id: scenario.id,
      label: scenario.label,
      status: task.status,
      wallMs: Math.round(wallMs),
      transferMs,
      finalizeMs: detail?.timing?.finalizeMs ?? null,
      avgMbps: task.avgBps ? task.avgBps / MB : null,
      effectiveMbps,
      downloaded: task.downloaded,
      total: task.total,
      policy: task.sourcePolicy,
      selectedSource: task.selectedSource,
      sourceSwitches: task.sourceSwitches,
      sources: (task.sources ?? []).map((source) => ({
        id: source.id,
        host: source.host,
        state: source.state,
        role: source.role,
        bytes: source.bytes,
        bps: source.bps,
      })),
      sha256: digest,
      expectedSelected: scenario.expectSelected,
    }
  } finally {
    try {
      await kernel.shutdown()
    } catch {
      await kernel.kill()
    }
    await removeDir(downloadDir)
    await removeDir(dataDir)
  }
}

async function main() {
  await ensureTestTmpRoot()
  const results = []
  console.log(`ISO ${ISO}  ${ISO_SIZE} B  sha256 ${ISO_SHA256}`)
  for (const scenario of SCENARIOS) {
    process.stdout.write(`\n=== ${scenario.id} (${scenario.label}) ===\n`)
    try {
      const result = await runScenario(scenario)
      results.push(result)
      console.log(
        `policy=${result.policy} selected=${result.selectedSource} switches=${result.sourceSwitches} ` +
          `transfer=${(result.transferMs / 1000).toFixed(2)}s ` +
          `effective=${result.effectiveMbps?.toFixed(2)} MiB/s ` +
          `avg=${result.avgMbps?.toFixed(2)} MiB/s ` +
          `sha256=ok`,
      )
      for (const source of result.sources) {
        console.log(`  src ${source.id} ${source.role}/${source.state} ${source.host} bytes=${(source.bytes / MB).toFixed(1)}MiB bps=${source.bps ? (source.bps / MB).toFixed(2) : '-'}MiB/s`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`FAILED: ${message}`)
      results.push({ id: scenario.id, error: message })
    }
  }
  const summaryPath = path.join(await ensureTestTmpRoot(), 'real-multi-source-bench.json')
  await fs.writeFile(summaryPath, `${JSON.stringify({ iso: ISO, size: ISO_SIZE, sha256: ISO_SHA256, mirrors: MIRRORS, results }, null, 2)}\n`)
  console.log(`\nresults: ${summaryPath}`)

  const byId = new Map(results.map((result) => [result.id, result]))
  const official = byId.get('single:official')
  const bfsu = byId.get('single:bfsu')
  const select = byId.get('select:official+bfsu')
  const race = byId.get('race:bfsu+cernet+nju')
  const raceTwo = byId.get('race:bfsu+cernet')
  const ratio = (fast, slow) => (fast?.transferMs && slow?.transferMs ? slow.transferMs / fast.transferMs : null)
  console.log('\n=== summary ===')
  if (official && bfsu && select) {
    console.log(`selection gain vs official: ${ratio(select, official)?.toFixed(2)}x (${official.transferMs} ms -> ${select.transferMs} ms)`)
    console.log(`selection selected source: ${select.selectedSource} (expected 1 = BFSU)`)
  }
  if (bfsu && select) {
    console.log(`select vs single BFSU: ${ratio(select, bfsu)?.toFixed(2)}x (${bfsu.transferMs} ms -> ${select.transferMs} ms)`)
  }
  if (bfsu && race && race.transferMs) {
    console.log(`race (3 sources) vs single BFSU: ${ratio(race, bfsu)?.toFixed(2)}x (${bfsu.transferMs} ms -> ${race.transferMs} ms)`)
  }
  if (bfsu && raceTwo && raceTwo.transferMs) {
    console.log(`race (2 fast sources) vs single BFSU: ${ratio(raceTwo, bfsu)?.toFixed(2)}x (${bfsu.transferMs} ms -> ${raceTwo.transferMs} ms)`)
  }
}

await main()
