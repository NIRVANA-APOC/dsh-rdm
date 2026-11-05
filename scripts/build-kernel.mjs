// Build the N-API-free resident Rust kernel and ship it with the plugin:
//   kernel/  --cargo build --release-->  bin/<platform>-<arch>/rdm-kernel[.exe]
//
// Usage: node scripts/build-kernel.mjs [--no-build]
//
// Environment notes:
// * cargo lives in `%USERPROFILE%\.cargo\bin`; MinGW-w64 GCC in a WiGet
//   package directory. Both are added to PATH for the build.
// * the kernel crate is a standalone workspace (`kernel/Cargo.toml` has its own
//   empty `[workspace]`), so this never touches the RDM repository workspace.
// * TMP/TEMP point inside `kernel/target/tmp`: on Windows hosts whose
//   `%LOCALAPPDATA%\Temp` is not writable by cargo's child processes (sandboxed
//   CI/agent hosts) GCC otherwise fails with "Cannot create temporary file".
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kernelDir = path.join(root, 'kernel')
// The plugin resolves the bundled kernel from bin/<platform>-<arch>/ at runtime
// (see resolveKernelPath in src/kernel-client.ts), so the build output must use
// the same directory layout on every platform.
const outDir = path.join(root, 'bin', `${process.platform}-${process.arch}`)
const isWindows = process.platform === 'win32'
const fileName = isWindows ? 'rdm-kernel.exe' : 'rdm-kernel'
const builtExe = path.join(kernelDir, 'target', 'release', fileName)
const shippedExe = path.join(outDir, fileName)

const build = !process.argv.includes('--no-build')

/** Locate the WinLibs MinGW-w64 bin directory, if installed. */
async function findMingw() {
  const packages = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Microsoft',
    'WinGet',
    'Packages',
  )
  let entries
  try {
    entries = await fs.readdir(packages)
  } catch {
    return null
  }
  for (const entry of entries.filter((name) => name.startsWith('BrechtSanders.WinLibs'))) {
    const bin = path.join(packages, entry, 'mingw64', 'bin')
    try {
      await fs.access(path.join(bin, 'gcc.exe'))
      return bin
    } catch {
      /* keep looking */
    }
  }
  return null
}

const mingwBin = await findMingw()
const pathParts = [mingwBin, path.join(os.homedir(), '.cargo', 'bin'), process.env.PATH ?? ''].filter(
  Boolean,
)
const env = { ...process.env, PATH: pathParts.join(path.delimiter) }

// Keep compiler temporaries inside the workspace: see header note.
const tmpDir = path.join(kernelDir, 'target', 'tmp')
await fs.mkdir(tmpDir, { recursive: true })
env.TMP = tmpDir
env.TEMP = tmpDir

if (build) {
  console.log(
    `building rdm-kernel (release)${mingwBin ? ` with MinGW from ${mingwBin}` : ' using system PATH'}`,
  )
  const result = spawnSync('cargo', ['build', '--release'], {
    cwd: kernelDir,
    env,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`build-kernel: could not run cargo: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`build-kernel: cargo build failed with exit code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

const stat = await fs.stat(builtExe).catch(() => null)
if (!stat) {
  console.error(`build-kernel: ${builtExe} does not exist; run without --no-build`)
  process.exit(1)
}
await fs.mkdir(outDir, { recursive: true })
// The live plugin usually has the kernel exe open; Windows refuses to replace a
// running image. Move the old file aside first (a running process keeps its
// handle, so the new path takes effect on the next kernel spawn).
async function install(src, dest) {
  try {
    await fs.copyFile(src, dest)
    return
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error
  }
  const old = `${dest}.old-${Date.now()}`
  try {
    await fs.rename(dest, old)
  } catch {
    /* already gone */
  }
  await fs.copyFile(src, dest)
  console.log(`build-kernel: previous exe moved to ${old} (restart the plugin kernel to load the new build)`)
}
await install(builtExe, shippedExe)
const shipped = await fs.stat(shippedExe)
console.log(
  `rdm-kernel: ${shippedExe} (${shipped.size.toLocaleString('en-US')} bytes, ` +
    `${(shipped.size / 1024 / 1024).toFixed(2)} MiB)`,
)
