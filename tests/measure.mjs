// Measurements for the dsh-rdm verification report:
//   * kernel Rust source line count
//   * shipped kernel binary size + sha256
//   * idle resident memory of a live kernel (Windows WorkingSet64)
//   * loopback download throughput (multi-connection) + curl.exe single-stream baseline
//   * plugin artifact sanity (lib/index.js ESM host bundle, lib/client.js loader wrapper)
//
// Every measurement returns a structured entry with an explicit status:
//   pass / fail / skipped / info
// "skipped" is used when an artifact does not exist yet (e.g. plugin not built)
// and only fails the overall run when --allow-missing-artifacts is not set.
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { launchKernel, makeTempDir, removeDir, sha256File } from './kernel-client.mjs'

const MIB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function walkFiles(dir, filter) {
  const results = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return results
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...(await walkFiles(full, filter)))
    else if (entry.isFile() && filter(full)) results.push(full)
  }
  return results
}

function countLines(text) {
  const lines = text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  const rawLines = endsWithNewline ? lines.length - 1 : lines.length
  let nonEmpty = 0
  let code = 0
  let inBlockComment = false
  for (const original of lines) {
    if (original === '' && endsWithNewline) continue
    const trimmed = original.trim()
    if (trimmed === '') continue
    nonEmpty += 1
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      continue
    }
    code += 1
  }
  return { rawLines, nonEmpty, code }
}

/**
 * Approximate "runtime-only" Rust LOC: raw lines minus whole `#[cfg(test)]`
 * items (inline `mod tests { ... }` blocks and individual annotated items).
 * Line-based brace matching; braces inside string literals are not parsed, so
 * both sides of the comparison use the same approximation.
 */
function countRuntimeLines(text) {
  const lines = text.split('\n')
  let depth = 0
  let kept = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (/^#\[cfg\(test\)\]/.test(trimmed)) {
      const startDepth = depth
      let sawOpen = false
      let sawItem = false
      i += 1
      while (i < lines.length) {
        const current = lines[i]
        const currentTrimmed = current.trim()
        for (const ch of current) {
          if (ch === '{') {
            depth += 1
            sawOpen = true
          } else if (ch === '}') {
            depth -= 1
          }
        }
        sawItem = true
        i += 1
        if (sawOpen) {
          if (depth <= startDepth) break
        } else if (currentTrimmed !== '' && !currentTrimmed.startsWith('#[') && !currentTrimmed.startsWith('//')) {
          // single-line item annotated by cfg(test) (e.g. `use ...;`): skip it
          break
        }
      }
      continue
    }
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (trimmed !== '') kept += 1
    i += 1
  }
  return { runtimeLines: kept }
}

async function rustStats(dir) {
  const files = await walkFiles(dir, (file) => file.endsWith('.rs'))
  let rawLines = 0
  let nonEmpty = 0
  let code = 0
  let runtimeLines = 0
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const counted = countLines(text)
    rawLines += counted.rawLines
    nonEmpty += counted.nonEmpty
    code += counted.code
    runtimeLines += countRuntimeLines(text).runtimeLines
  }
  return { files: files.length, rawLines, nonEmpty, code, runtimeLines }
}

function safeExec(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', timeout: 20000, ...options })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (err) {
    return { ok: false, error: err.message, stdout: err.stdout ? String(err.stdout).trim() : '', stderr: err.stderr ? String(err.stderr).trim() : '' }
  }
}

/**
 * Async command execution. Required while the in-process fixture server is
 * serving traffic: spawnSync would block the Node event loop and deadlock the
 * fixture, so every request-issuing child must run asynchronously.
 */
function safeExecAsync(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: '', stderr: '' })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `timed out after ${timeoutMs}ms`, stdout, stderr })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => finish({ ok: false, error: err.message, stdout, stderr }))
    child.on('close', (code) =>
      finish({ ok: code === 0, code, error: code === 0 ? undefined : `exit code ${code}`, stdout: stdout.trim(), stderr: stderr.trim() }),
    )
  })
}

/** Tool version with a few Windows-friendly fallbacks (the Node PATH may omit .cargo/bin). */
function toolVersion(name, { args = ['--version'], fallbacks = [] } = {}) {
  const direct = safeExec(name, args)
  if (direct.ok && direct.stdout) return direct.stdout.split(/\r?\n/)[0]
  for (const fallback of fallbacks) {
    if (!fallback || !fsp.existsSync(fallback)) continue
    const result = safeExec(fallback, args)
    if (result.ok && result.stdout) return result.stdout.split(/\r?\n/)[0]
  }
  return null
}

function npmVersion() {
  if (process.platform !== 'win32') {
    const direct = safeExec('npm', ['--version'])
    return direct.ok ? direct.stdout.split(/\r?\n/)[0] : null
  }
  // Avoid shell:true (deprecated); prefer the npm-cli.js bundled with Node.
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fsp.existsSync(cli)) {
    const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 20000 })
    if (result.status === 0) return String(result.stdout).trim().split(/\r?\n/)[0]
  }
  try {
    const result = spawnSync('cmd.exe', ['/d', '/c', 'npm --version'], { encoding: 'utf8', timeout: 20000 })
    if (result.status === 0) return String(result.stdout).trim().split(/\r?\n/)[0]
  } catch {
    /* ignore */
  }
  return null
}

function environmentInfo(root) {
  const packageJsonPath = path.join(root, 'package.json')
  let packageVersion = null
  try {
    packageVersion = JSON.parse(fsp.readFileSync(packageJsonPath, 'utf8')).version
  } catch {
    packageVersion = null
  }
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin')
  return {
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    node: process.version,
    npm: npmVersion(),
    rustc: toolVersion('rustc', { fallbacks: [path.join(cargoBin, 'rustc.exe')] }),
    cargo: toolVersion('cargo', { fallbacks: [path.join(cargoBin, 'cargo.exe')] }),
    packageVersion,
    measuredAt: new Date().toISOString(),
  }
}

// ── JS structure helpers for the plugin bundles ─────────────────────────────

/** Strip comments and string/template literals, then count delimiters. */
function scanJsStructure(source) {
  let braces = 0
  let parens = 0
  let brackets = 0
  let state = 'code' // code | line-comment | block-comment | single | double | template
  let templateDepth = 0
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment'
        i += 1
      } else if (ch === '/' && next === '*') {
        state = 'block-comment'
        i += 1
      } else if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') {
        state = 'template'
        templateDepth = 1
      } else if (ch === '{') braces += 1
      else if (ch === '}') braces -= 1
      else if (ch === '(') parens += 1
      else if (ch === ')') parens -= 1
      else if (ch === '[') brackets += 1
      else if (ch === ']') brackets -= 1
      continue
    }
    if (state === 'line-comment') {
      if (ch === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code'
        i += 1
      }
      continue
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"'
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') escaped = true
      else if (ch === quote) state = 'code'
      continue
    }
    if (state === 'template') {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') escaped = true
      else if (ch === '`') {
        templateDepth -= 1
        if (templateDepth === 0) state = 'code'
      } else if (ch === '$' && next === '{') {
        templateDepth += 1
        i += 1
      } else if (ch === '{') {
        templateDepth += 1
      } else if (ch === '}') {
        templateDepth -= 1
        if (templateDepth === 0) state = 'code'
      }
      continue
    }
  }
  return {
    braces,
    parens,
    brackets,
    balanced: braces === 0 && parens === 0 && brackets === 0,
    strippedBytes: source.length,
  }
}

function rawBalance(source) {
  const count = (needle) => source.split(needle).length - 1
  return { braces: count('{') - count('}'), parens: count('(') - count(')'), brackets: count('[') - count(']') }
}

function syntaxCheck(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8', timeout: 30000 })
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: String(result.stderr ?? '').trim().slice(0, 800),
  }
}

/** Read WorkingSet64 / PeakWorkingSet64 for one Windows pid via PowerShell. */
function queryProcessMemory(pid) {
  const powershell = safeExec('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$p = Get-Process -Id ${pid}; Write-Output $p.WorkingSet64; Write-Output $p.PeakWorkingSet64`,
  ])
  if (!powershell.ok) return { ok: false, error: powershell.error, stderr: powershell.stderr }
  const [workingSetRaw, peakRaw] = powershell.stdout.split(/\r?\n/).map((line) => Number(String(line).trim()))
  const workingSet = Number.isFinite(workingSetRaw) ? workingSetRaw : null
  const peak = Number.isFinite(peakRaw) ? peakRaw : null
  return {
    ok: typeof workingSet === 'number' && workingSet > 0,
    workingSetBytes: workingSet,
    peakWorkingSetBytes: peak,
    workingSetMiB: workingSet ? Math.round((workingSet / MIB) * 100) / 100 : null,
    peakWorkingSetMiB: peak ? Math.round((peak / MIB) * 100) / 100 : null,
  }
}

function makeEntry(id, label, status, fields = {}) {
  return { id, label, status, ...fields }
}

// ── individual measurements ─────────────────────────────────────────────────

async function measureLoc(root) {
  const kernelSrc = path.join(root, 'kernel', 'src')
  const kernel = await rustStats(kernelSrc)
  if (kernel.files === 0) {
    return makeEntry('kernel.loc', 'Kernel Rust source LOC', 'fail', {
      value: null,
      unit: 'lines (kernel/src/**/*.rs not found)',
      details: { kernelSrc },
    })
  }
  return makeEntry('kernel.loc', 'Kernel Rust source LOC', 'pass', {
    value: kernel.rawLines,
    unit: 'source lines (raw)',
    details: {
      kernel: {
        files: kernel.files,
        rawLines: kernel.rawLines,
        nonEmptyLines: kernel.nonEmpty,
        codeLinesApprox: kernel.code,
        runtimeLinesExcludingCfgTest: kernel.runtimeLines,
      },
    },
  })
}

async function measureBinary(root, kernelPath) {
  const candidates = [kernelPath, path.join(root, 'bin', 'win32-x64', 'rdm-kernel.exe')]
  const found = candidates.find((candidate) => candidate && fsp.existsSync(candidate))
  if (!found) {
    return makeEntry('kernel.binary', 'Kernel binary', 'fail', { value: null, unit: 'bytes', details: { candidates } })
  }
  const stat = await fs.stat(found)
  const digest = await sha256File(found)
  return makeEntry('kernel.binary', 'Kernel binary size', 'pass', {
    value: stat.size,
    unit: 'bytes',
    details: { path: found, MiB: Math.round((stat.size / MIB) * 100) / 100, sha256: digest, mtime: stat.mtime.toISOString() },
  })
}

async function measureIdleRss(root, kernelPath) {
  if (!fsp.existsSync(kernelPath)) {
    return makeEntry('kernel.idleRss', 'Kernel idle resident memory (3s after initialize)', 'fail', {
      value: null,
      unit: 'bytes',
      details: { reason: `kernel binary missing: ${kernelPath}` },
    })
  }
  const tempRoot = await makeTempDir('dsh-rdm-rss-')
  let kernel = null
  try {
    kernel = await launchKernel(kernelPath, { dataDir: path.join(tempRoot, 'data'), logLevel: 'warn', label: 'kernel-rss' })
    await kernel.initialize({ defaultDir: path.join(tempRoot, 'downloads') })
    await sleep(3000)
    const pid = kernel.pid
    const memory = queryProcessMemory(pid)
    if (!memory.ok) {
      return makeEntry('kernel.idleRss', 'Kernel idle resident memory (3s after initialize)', 'fail', {
        value: null,
        unit: 'bytes',
        details: { pid, error: memory.error, stderr: memory.stderr },
      })
    }
    return makeEntry('kernel.idleRss', 'Kernel idle resident memory (3s after initialize)', 'pass', {
      value: memory.workingSetBytes,
      unit: 'bytes',
      details: {
        pid,
        workingSetMiB: memory.workingSetMiB,
        peakWorkingSetMiB: memory.peakWorkingSetMiB,
        measuredAfterMs: 3000,
      },
    })
  } finally {
    if (kernel && !kernel.exited.at) {
      try {
        await kernel.shutdown({ timeoutMs: 8000 })
      } catch {
        await kernel.kill()
      }
    }
    await removeDir(tempRoot)
  }
}

async function measureThroughput(fixture, kernelPath) {
  if (!fsp.existsSync(kernelPath)) {
    return [
      makeEntry('kernel.throughput', 'Loopback multi-connection throughput', 'fail', {
        value: null,
        unit: 'MiB/s',
        details: { reason: `kernel binary missing: ${kernelPath}` },
      }),
      makeEntry('baseline.curl', 'curl.exe single-stream loopback baseline', 'skipped', { value: null, unit: 'MiB/s', details: {} }),
    ]
  }
  const tempRoot = await makeTempDir('dsh-rdm-throughput-')
  const size = 12 * MIB
  const name = 'measure-throughput.bin'
  const url = fixture.urlFor('ranged', size, name)
  let kernel = null
  let entries = []
  try {
    kernel = await launchKernel(kernelPath, { dataDir: path.join(tempRoot, 'data'), logLevel: 'warn', label: 'kernel-throughput' })
    await kernel.initialize({ defaultDir: path.join(tempRoot, 'downloads') })
    const started = await kernel.start({
      url,
      dir: path.join(tempRoot, 'downloads'),
      connections: 8,
    })
    const wallStart = performance.now()
    const { task } = await kernel.waitTerminal(started.task.id, 180000)
    const wallMs = performance.now() - wallStart
    const elapsedMs = task?.elapsedMs && task.elapsedMs > 0 ? task.elapsedMs : wallMs
    const expected = fixture.expected(size)
    let digestOk = false
    if (task?.path && fsp.existsSync(task.path)) digestOk = (await sha256File(task.path)) === expected.sha256
    const mibPerSec = size / MIB / (elapsedMs / 1000)
    const overlap = fixture.overlapFor(name)
    const memoryDuringRun = queryProcessMemory(kernel.pid)
    const ok = task?.status === 'completed' && digestOk && overlap.maxOverlap > 1
    entries.push(
      makeEntry('kernel.throughput', 'Loopback multi-connection throughput (12 MiB, connections=8)', ok ? 'pass' : 'fail', {
        value: Math.round(mibPerSec * 100) / 100,
        unit: 'MiB/s',
        details: {
          elapsedMs: Math.round(elapsedMs),
          wallMs: Math.round(wallMs),
          peakWorkers: task?.peakWorkers,
          rangeRequests: overlap.count,
          maxRangeOverlap: overlap.maxOverlap,
          sha256Verified: digestOk,
          status: task?.status,
          rssAfterMiB: memoryDuringRun.workingSetMiB ?? null,
          peakWorkingSetMiB: memoryDuringRun.peakWorkingSetMiB ?? null,
        },
      }),
    )

    // curl.exe baseline: single connection, no ranges -> comparable wall-clock number.
    // Must run async: the fixture server lives in this Node process.
    const curlVersion = safeExec('curl.exe', ['--version'])
    if (!curlVersion.ok) {
      entries.push(makeEntry('baseline.curl', 'curl.exe single-stream loopback baseline', 'skipped', { value: null, unit: 'MiB/s', details: { reason: 'curl.exe not available' } }))
    } else {
      const curlStart = performance.now()
      const curlResult = await safeExecAsync(
        'curl.exe',
        ['-sS', '-o', 'NUL', '-w', '%{speed_download}', '--max-time', '120', '--noproxy', '*', '-4', url],
        { timeoutMs: 150000 },
      )
      const curlWallMs = performance.now() - curlStart
      const bytesPerSecond = Number(String(curlResult.stdout).split(/\r?\n/).pop())
      if (!curlResult.ok || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        entries.push(makeEntry('baseline.curl', 'curl.exe single-stream loopback baseline', 'skipped', {
          value: null,
          unit: 'MiB/s',
          details: { error: curlResult.error, stdout: curlResult.stdout, stderr: curlResult.stderr },
        }))
      } else {
        entries.push(makeEntry('baseline.curl', 'curl.exe single-stream loopback baseline', 'pass', {
          value: Math.round((bytesPerSecond / MIB) * 100) / 100,
          unit: 'MiB/s',
          details: { wallMs: Math.round(curlWallMs), curl: curlVersion.stdout.split(/\r?\n/)[0] },
        }))
      }
    }
  } catch (err) {
    entries.push(makeEntry('kernel.throughput', 'Loopback multi-connection throughput', 'fail', {
      value: null,
      unit: 'MiB/s',
      details: { error: `${err.name ?? 'Error'}: ${err.message}` },
    }))
    if (entries.length < 2) {
      entries.push(makeEntry('baseline.curl', 'curl.exe single-stream loopback baseline', 'skipped', { value: null, unit: 'MiB/s', details: { reason: 'throughput run failed first' } }))
    }
  } finally {
    if (kernel && !kernel.exited.at) {
      try {
        await kernel.shutdown({ timeoutMs: 8000 })
      } catch {
        await kernel.kill()
      }
    }
    await removeDir(tempRoot)
  }
  return entries
}

async function measureHostArtifact(root) {
  const file = path.join(root, 'lib', 'index.js')
  const exists = fsp.existsSync(file)
  if (!exists) {
    return makeEntry('plugin.hostArtifact', 'Plugin host bundle lib/index.js', 'skipped', {
      value: null,
      unit: 'bytes',
      details: { reason: `missing: ${file} — run node scripts/build.mjs` },
    })
  }
  const source = await fs.readFile(file, 'utf8')
  const stat = await fs.stat(file)
  const syntax = syntaxCheck(file)
  const structure = scanJsStructure(source)
  const raw = rawBalance(source)
  const hasEsmExport =
    /\bexport\s+(?:async\s+)?function\s+apply\s*\(/.test(source) ||
    /\bexport\s+(?:const|let|var)\s+apply\b/.test(source) ||
    /\bexport\s*\{/.test(source) ||
    /\bexport\s+default\b/.test(source)
  const requireMatches = [...source.matchAll(/\brequire\s*\(/g)]
  const hasRequire = requireMatches.length > 0
  const rawBracketsBalanced = raw.braces === 0 && raw.parens === 0 && raw.brackets === 0
  const checks = {
    esmExportApply: hasEsmExport,
    noRequireCalls: !hasRequire,
    syntaxCheck: syntax.ok,
    // Primary balance check is the literal count (what the QA spec asks for);
    // the string/comment-aware scan is reported as supplementary evidence.
    bracketsBalanced: rawBracketsBalanced,
    bannerComment: source.startsWith('// generated by dsh-rdm/scripts/build.mjs'),
  }
  const ok = Object.values(checks).every(Boolean)
  return makeEntry('plugin.hostArtifact', 'Plugin host bundle lib/index.js (ESM, no require)', ok ? 'pass' : 'fail', {
    value: stat.size,
    unit: 'bytes',
    details: {
      path: file,
      checks,
      syntax,
      structure,
      rawBalance: raw,
      scannerBalanced: structure.balanced,
      requireCallCount: requireMatches.length,
      firstLine: source.split(/\r?\n/)[0],
    },
  })
}

async function measureClientArtifact(root) {
  const file = path.join(root, 'lib', 'client.js')
  const exists = fsp.existsSync(file)
  if (!exists) {
    return makeEntry('plugin.clientArtifact', 'Plugin client bundle lib/client.js', 'skipped', {
      value: null,
      unit: 'bytes',
      details: { reason: `missing: ${file} — run node scripts/build.mjs` },
    })
  }
  const source = await fs.readFile(file, 'utf8')
  const stat = await fs.stat(file)
  const syntax = syntaxCheck(file)
  const structure = scanJsStructure(source)
  const raw = rawBalance(source)
  const loaderIndex = source.indexOf('window.__ModuleLoader__.load(')
  const rawBracketsBalanced = raw.braces === 0 && raw.parens === 0 && raw.brackets === 0
  const checks = {
    loaderWrapper: loaderIndex >= 0 && loaderIndex < 400,
    moduleId: source.includes("id: 'dsh-rdm'"),
    syntaxCheck: syntax.ok,
    // Literal delimiter counts (QA spec); scanner result is supplementary.
    bracketsBalanced: rawBracketsBalanced,
  }
  const ok = Object.values(checks).every(Boolean)
  return makeEntry('plugin.clientArtifact', 'Plugin client bundle lib/client.js (module-loader wrapper)', ok ? 'pass' : 'fail', {
    value: stat.size,
    unit: 'bytes',
    details: {
      path: file,
      checks,
      syntax,
      structure,
      rawBalance: raw,
      scannerBalanced: structure.balanced,
      loaderIndex,
      startsWith: source.slice(0, 120),
    },
  })
}

/**
 * Run every measurement.
 * @param {object} options
 * @param {string} options.root dsh-rdm package root
 * @param {string} options.kernelPath kernel exe path
 * @param {object} options.fixture started fixture server
 * @param {boolean} [options.allowMissingArtifacts] if true, skipped artifacts don't fail
 */
export async function runMeasurements(options) {
  const { root, kernelPath, fixture, allowMissingArtifacts = false } = options
  const environment = environmentInfo(root)
  const entries = []
  entries.push(makeEntry('environment', 'Verification environment', 'info', { value: null, unit: '', details: environment }))
  entries.push(await measureLoc(root))
  entries.push(await measureBinary(root, kernelPath))
  entries.push(await measureIdleRss(root, kernelPath))
  entries.push(...(await measureThroughput(fixture, kernelPath)))
  entries.push(await measureHostArtifact(root))
  entries.push(await measureClientArtifact(root))

  const skipped = entries.filter((entry) => entry.status === 'skipped')
  const failed = entries.filter((entry) => entry.status === 'fail')
  const passed = entries.filter((entry) => entry.status === 'pass')
  const ok = failed.length === 0 && (allowMissingArtifacts || skipped.length === 0)
  return {
    environment,
    entries,
    summary: {
      ok,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      infra: entries.length,
    },
  }
}

// ── human-readable rendering ────────────────────────────────────────────────

function renderValue(entry) {
  if (entry.value === null || entry.value === undefined) return '—'
  if (entry.id === 'kernel.binary') {
    return `${Math.round((entry.value / MIB) * 100) / 100} MiB (${entry.value} bytes)`
  }
  if (entry.id === 'kernel.idleRss') {
    return `${Math.round((entry.value / MIB) * 100) / 100} MiB (${entry.value} bytes)`
  }
  if (entry.id === 'kernel.loc') return `${entry.value} lines`
  if (entry.unit === 'MiB/s') return `${entry.value} MiB/s`
  if (entry.unit === 'bytes') return `${entry.value} bytes`
  return `${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`
}

export function formatMeasurementLines(result) {
  const lines = []
  lines.push('Measurements')
  lines.push('='.repeat(78))
  for (const entry of result.entries) {
    if (entry.status === 'info') {
      lines.push(`INFO  ${entry.label}`)
      for (const [key, value] of Object.entries(entry.details ?? {})) {
        if (value !== null && value !== undefined) lines.push(`        ${key}: ${value}`)
      }
      continue
    }
    const mark = entry.status === 'pass' ? 'PASS' : entry.status === 'fail' ? 'FAIL' : 'SKIP'
    lines.push(`${mark}  ${entry.label}: ${renderValue(entry)}`)
    const details = entry.details ?? {}
    if (entry.id === 'kernel.loc') {
      lines.push(
        `        kernel: files=${details.kernel.files} raw=${details.kernel.rawLines} nonEmpty=${details.kernel.nonEmptyLines} code≈${details.kernel.codeLinesApprox} runtime≈${details.kernel.runtimeLinesExcludingCfgTest}`,
      )
    } else if (entry.id === 'kernel.binary') {
      if (details.sha256) lines.push(`        sha256=${details.sha256}`)
      if (details.path) lines.push(`        path=${details.path}`)
    } else if (entry.id === 'kernel.idleRss') {
      lines.push(`        pid=${details.pid ?? '—'} peak=${details.peakWorkingSetMiB ?? '—'} MiB (after ${details.measuredAfterMs ?? '—'}ms idle)`)
    } else if (entry.id === 'kernel.throughput' || entry.id === 'baseline.curl') {
      lines.push(`        ${JSON.stringify(details)}`)
    } else if (entry.id.startsWith('plugin.')) {
      lines.push(`        checks=${JSON.stringify(details.checks)}`)
      if (details.syntax && details.syntax.ok === false) lines.push(`        syntax stderr=${details.syntax.stderr}`)
      if (details.rawBalance) lines.push(`        rawBalance=${JSON.stringify(details.rawBalance)} structure=${JSON.stringify({ braces: details.structure?.braces, parens: details.structure?.parens, brackets: details.structure?.brackets })}`)
      if (entry.status === 'skipped') lines.push(`        reason=${details.reason}`)
    } else if (entry.status === 'fail' || entry.status === 'skipped') {
      lines.push(`        ${JSON.stringify(details)}`)
    }
  }
  lines.push('-'.repeat(78))
  lines.push(
    `measurements: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
  )
  return lines
}

export { MIB }
