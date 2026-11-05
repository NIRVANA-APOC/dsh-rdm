#!/usr/bin/env node
// Verify the prebuilt kernels bundled under bin/<platform>-<arch>/.
//
//   node scripts/verify-kernels.mjs                 # every expected target, strict
//   node scripts/verify-kernels.mjs --host          # the current host target only
//   node scripts/verify-kernels.mjs --host --run    # ...and start it once (--help)
//   node scripts/verify-kernels.mjs --allow-missing # report locally built targets only
//   node scripts/verify-kernels.mjs --json          # machine-readable summary
//
// The runtime resolver (src/kernel-client.ts, resolveKernelPath) looks for
// bin/${process.platform}-${process.arch}/rdm-kernel[.exe]; every platform this
// plugin claims to support must therefore carry that file in the package.
// Besides existence, this check asserts the file magic matches the target OS and,
// on POSIX hosts, that the executable bit survived packaging (artifacts and tar
// extraction have silently dropped it before).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every target the prebuilt-kernel workflow publishes. */
const TARGETS = [
  { dir: 'linux-x64', platform: 'linux', arch: 'x64', binary: 'rdm-kernel', magic: 'elf' },
  { dir: 'linux-arm64', platform: 'linux', arch: 'arm64', binary: 'rdm-kernel', magic: 'elf' },
  { dir: 'win32-x64', platform: 'win32', arch: 'x64', binary: 'rdm-kernel.exe', magic: 'pe' },
  { dir: 'darwin-x64', platform: 'darwin', arch: 'x64', binary: 'rdm-kernel', magic: 'macho' },
  { dir: 'darwin-arm64', platform: 'darwin', arch: 'arm64', binary: 'rdm-kernel', magic: 'macho' },
]

const MIN_BINARY_BYTES = 1_000_000

function parseArgs(argv) {
  const args = { host: false, run: false, allowMissing: false, json: false }
  for (const arg of argv) {
    if (arg === '--host') args.host = true
    else if (arg === '--run') args.run = true
    else if (arg === '--allow-missing') args.allowMissing = true
    else if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/verify-kernels.mjs [--host] [--run] [--allow-missing] [--json]',
      )
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

/** Identify the first bytes of a seeded executable. */
function fileMagic(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    // Mach-O 64-bit little-endian (both x86_64 and arm64 hosts).
    if (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) return 'macho'
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf'
    if (head[0] === 0x4d && head[1] === 0x5a) return 'pe'
    return 'unknown'
  } finally {
    fs.closeSync(fd)
  }
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let read
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** The `files` manifest must keep bin/** in the published package. */
function packagingCheck() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const coversBin = files.some((entry) => typeof entry === 'string' && /^bin(\/|$)/.test(entry))
  return coversBin
    ? { ok: true }
    : { ok: false, error: 'package.json "files" does not include bin/**' }
}

/** Check one target; `hostTarget` switches on the runtime smoke expectations. */
function inspect(target, options) {
  const relative = ['bin', target.dir, target.binary].join('/')
  const absolute = path.join(ROOT, 'bin', target.dir, target.binary)
  const result = {
    dir: target.dir,
    path: relative,
    platform: `${target.platform}-${target.arch}`,
    size: null,
    sha256: null,
    executable: null,
    magic: null,
    ok: false,
    error: null,
  }
  let stat
  try {
    stat = fs.statSync(absolute)
  } catch {
    result.error = 'missing'
    return result
  }
  result.size = stat.size
  if (!stat.isFile()) {
    result.error = 'not a regular file'
    return result
  }
  if (stat.size < MIN_BINARY_BYTES) {
    result.error = `suspiciously small (${stat.size} bytes)`
    return result
  }
  result.sha256 = sha256(absolute)
  result.magic = fileMagic(absolute)
  if (result.magic !== target.magic) {
    result.error = `wrong executable format: ${result.magic} (expected ${target.magic})`
    return result
  }
  // Windows ignores the POSIX executable bit; every other target needs it.
  if (target.platform !== 'win32') {
    result.executable = (stat.mode & 0o111) !== 0
    if (!result.executable) {
      result.error = 'not executable (mode lost in packaging)'
      return result
    }
  }
  result.ok = true
  if (options.run) {
    const smoke = spawnSync(absolute, ['--help'], { timeout: 20_000, encoding: 'utf8' })
    const output = `${smoke.stdout ?? ''}${smoke.stderr ?? ''}`
    if (smoke.error !== undefined || smoke.status !== 0 || !/rdm-kernel/.test(output)) {
      result.ok = false
      result.error = `smoke start failed (status=${smoke.status}, error=${smoke.error?.message ?? 'none'})`
    }
  }
  return result
}

const args = parseArgs(process.argv.slice(2))
const hostDir = `${process.platform}-${process.arch}`
const targets = args.host ? TARGETS.filter((target) => target.dir === hostDir) : TARGETS

if (targets.length === 0) {
  console.error(
    `verify-kernels: no prebuilt target for host ${hostDir}; ` +
      `known targets: ${TARGETS.map((target) => target.dir).join(', ')}`,
  )
  process.exit(2)
}
if (args.run && !args.host) {
  console.error('verify-kernels: --run needs --host (a foreign binary cannot be started)')
  process.exit(2)
}

const results = targets.map((target) => inspect(target, args))
const packaging = packagingCheck()
const failures = results.filter((result) => !result.ok)
const ok = packaging.ok && failures.length === 0

if (args.json) {
  console.log(
    JSON.stringify(
      {
        host: hostDir,
        ran: args.run,
        packageFilesIncludeBin: packaging.ok,
        targets: results,
        ok,
      },
      null,
      2,
    ),
  )
} else {
  for (const result of results) {
    if (result.ok) {
      const mode = result.executable === null ? '' : ' executable'
      console.log(
        `ok   ${result.dir.padEnd(13)} ${result.path}  ` +
          `${result.size.toLocaleString('en-US')} B  ${result.magic}${mode}  ${result.sha256}`,
      )
    } else {
      console.log(`FAIL ${result.dir.padEnd(13)} ${result.path}  ${result.error}`)
    }
  }
  if (!packaging.ok) console.log(`FAIL packaging    ${packaging.error}`)
  const found = results.length - failures.length
  console.log(
    `\nverify-kernels: ${ok ? 'PASS' : 'FAIL'} (${found}/${results.length} targets present${
      args.run ? ', host smoke started' : ''
    }${args.host ? `, host ${hostDir} only` : ''})`,
  )
}

process.exit(ok ? 0 : 1)
