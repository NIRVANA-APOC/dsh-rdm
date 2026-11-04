#!/usr/bin/env node
// QA runner for dsh-rdm: kernel e2e matrix + measurements.
//
//   node scripts/verify-kernel.mjs                 # full verification (npm run verify)
//   node scripts/verify-kernel.mjs --list          # list scenarios
//   node scripts/verify-kernel.mjs --only=pause    # run matching scenarios only
//   node scripts/verify-kernel.mjs --no-measure    # e2e only
//   node scripts/verify-kernel.mjs --allow-missing-artifacts  # plugin artifacts optional
//   node scripts/verify-kernel.mjs --json=report.json         # write machine-readable report
//
// Exit codes: 0 all checks passed, 1 verification failure, 2 kernel binary missing.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixtureServer } from '../tests/fixture-server.mjs'
import { runKernelE2ESuite, listScenarios } from '../tests/kernel-e2e.mjs'
import { runMeasurements, formatMeasurementLines } from '../tests/measure.mjs'
import { DEFAULT_KERNEL_PATH, TEST_TMP_ROOT, hasKernelBinary, launchKernel, makeTempDir, removeDir } from '../tests/kernel-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = {
    kernelPath: null,
    only: [],
    jsonPath: null,
    measure: true,
    allowMissingArtifacts: false,
    verbose: false,
    list: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const takeValue = () => {
      const eq = arg.indexOf('=')
      if (eq >= 0) return arg.slice(eq + 1)
      i += 1
      return argv[i]
    }
    if (arg === '--list') args.list = true
    else if (arg === '--no-measure') args.measure = false
    else if (arg === '--verbose') args.verbose = true
    else if (arg === '--allow-missing-artifacts') args.allowMissingArtifacts = true
    else if (arg === '--kernel' || arg.startsWith('--kernel=')) args.kernelPath = takeValue()
    else if (arg === '--json' || arg.startsWith('--json=')) args.jsonPath = takeValue()
    else if (arg === '--only' || arg.startsWith('--only=')) {
      args.only.push(...String(takeValue()).split(',').map((part) => part.trim()).filter(Boolean))
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/verify-kernel.mjs [--kernel=<exe>] [--only=<substring,...>] [--no-measure] [--allow-missing-artifacts] [--json=<path>] [--list]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

/**
 * Start the kernel once and require a `ready` notification before running the
 * matrix; a binary that cannot start is one clear failure, not 14 timeouts.
 */
async function preflightKernel(kernelPath, log) {
  const tempRoot = await makeTempDir('dsh-rdm-preflight-')
  let kernel = null
  try {
    kernel = await launchKernel(kernelPath, {
      dataDir: path.join(tempRoot, 'data'),
      logLevel: 'warn',
      label: 'preflight',
    })
    const ready = kernel.ready
    log(
      `preflight: kernel ready (pid=${ready?.kernel?.pid}, version=${ready?.kernel?.version}, protocol=${ready?.protocol}, dataDir=${ready?.kernel?.dataDir})`,
    )
    await kernel.shutdown({ timeoutMs: 8000 })
    return { ok: true, ready }
  } catch (err) {
    log(`preflight: FAIL — kernel did not become ready: ${err?.message ?? err}`)
    if (kernel?.stderrTail) {
      const tail = kernel.stderrTail(20)
      if (tail.length > 0) log(`preflight stderr:\n${tail.join('\n')}`)
    }
    return { ok: false, error: err?.message ?? String(err) }
  } finally {
    if (kernel && !kernel.exited.at) {
      try {
        await kernel.kill()
      } catch {
        /* ignore */
      }
    }
    await removeDir(tempRoot)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    console.log('dsh-rdm kernel e2e scenarios:')
    for (const entry of listScenarios()) console.log(`  - ${entry.name}\n      ${entry.description}`)
    return 0
  }

  const kernelPath = path.resolve(args.kernelPath ?? DEFAULT_KERNEL_PATH)
  const startedAt = new Date()
  const logLines = []
  const log = (line = '') => {
    logLines.push(line)
    console.log(line)
  }

  log('dsh-rdm kernel verification')
  log('='.repeat(78))
  log(`root:      ${ROOT}`)
  log(`kernel:    ${kernelPath}`)
  log(`started:   ${startedAt.toISOString()}`)
  log(`node:      ${process.version} (${process.platform} ${process.arch})`)

  const logPath = path.join(os.tmpdir(), `dsh-rdm-verify-${startedAt.toISOString().replace(/[:.]/g, '-')}.log`)
  const writeRunLog = async () => {
    await fs.writeFile(logPath, `${logLines.join('\n')}\n`, 'utf8')
    log(`log:       ${logPath}`)
    return logPath
  }

  if (!hasKernelBinary(kernelPath)) {
    log('')
    log(`ERROR: kernel binary not found: ${kernelPath}`)
    log('Build it first with: node scripts/build-kernel.mjs  (or npm run build:kernel)')
    log('verify: FAIL (missing kernel binary)')
    await writeRunLog()
    return 2
  }

  const preflight = await preflightKernel(kernelPath, log)
  if (!preflight.ok) {
    log('')
    log('verify: FAIL (kernel binary does not start / never sent ready)')
    await writeRunLog()
    return 1
  }

  const fixture = await startFixtureServer({ rangedDelayMs: 2 })
  log(`fixture:   ${fixture.origin}`)
  let e2eResult = null
  let measurementResult = null
  const failures = []
  let exitCode = 0
  try {
    e2eResult = await runKernelE2ESuite({
      kernelPath,
      fixture,
      only: args.only.length > 0 ? args.only : null,
      log,
      verbose: args.verbose,
    })
    if (args.measure) {
      log('')
      measurementResult = await runMeasurements({
        root: ROOT,
        kernelPath,
        fixture,
        allowMissingArtifacts: args.allowMissingArtifacts,
      })
      for (const line of formatMeasurementLines(measurementResult)) log(line)
    } else {
      log('')
      log('Measurements skipped (--no-measure).')
    }
  } catch (err) {
    log('')
    log(`FATAL: verification suite crashed: ${err?.stack ?? err?.message ?? err}`)
    exitCode = 1
  } finally {
    await fixture.close()
    // The kernel cannot write under os.tmpdir() on this host (ACCESS_DENIED), so
    // run artifacts live in a workspace-owned root; drop it when the run ends.
    if (!process.env.DSH_RDM_TEST_TMP_ROOT) {
      try {
        await removeDir(TEST_TMP_ROOT)
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  log('')
  log('E2E scenario matrix')
  log('='.repeat(78))
  if (e2eResult) {
    for (const result of e2eResult.results) {
      const mark = result.ok ? 'PASS' : 'FAIL'
      log(`${mark}  ${result.name}  (${result.checksPassed}/${result.checksTotal} checks, ${result.ms}ms)`)
      if (!result.ok) {
        failures.push(`scenario failed: ${result.name}`)
        for (const check of result.checks.filter((c) => !c.ok)) failures.push(`  - ${result.name} :: ${check.name} (${check.detail})`)
        if (result.error) failures.push(`  - ${result.name} :: ${result.error}`)
        for (const cleanupError of result.cleanupErrors) failures.push(`  - ${result.name} :: cleanup: ${cleanupError}`)
      }
    }
    const summary = e2eResult.summary
    log('-'.repeat(78))
    log(
      `scenarios: ${summary.scenariosPassed}/${summary.scenariosTotal} passed, ${summary.scenariosFailed} failed  |  checks: ${summary.checksPassed}/${summary.checksTotal} passed  |  e2e time: ${(summary.durationMs / 1000).toFixed(1)}s`,
    )
    if (summary.scenariosFailed > 0) exitCode = 1
  } else {
    exitCode = 1
  }

  if (measurementResult) {
    if (measurementResult.summary.failed > 0) {
      exitCode = 1
      for (const entry of measurementResult.entries.filter((entry) => entry.status === 'fail')) {
        failures.push(`measurement failed: ${entry.label} — ${JSON.stringify(entry.details)}`)
      }
    }
    if (!args.allowMissingArtifacts) {
      for (const entry of measurementResult.entries.filter((entry) => entry.status === 'skipped')) {
        failures.push(`measurement skipped (missing artifact): ${entry.label} — ${JSON.stringify(entry.details)}`)
        exitCode = 1
      }
    }
  }

  if (failures.length > 0) {
    log('')
    log('Failures')
    log('-'.repeat(78))
    for (const failure of failures) log(failure)
  }

  log('')
  await writeRunLog()

  if (args.jsonPath) {
    const report = {
      kind: 'dsh-rdm-verification',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      root: ROOT,
      kernelPath,
      node: { version: process.version, platform: process.platform, arch: process.arch },
      e2e: e2eResult,
      measurements: measurementResult,
      failures,
      exitCode,
    }
    const jsonPath = path.resolve(args.jsonPath)
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    log(`report:    ${jsonPath}`)
  }

  log('')
  if (exitCode === 0) {
    log('verify: PASS')
  } else {
    log('verify: FAIL')
  }
  return exitCode
}

main()
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 1
  })
  .catch((err) => {
    console.error('verify-kernel crashed:', err)
    process.exitCode = 1
  })
