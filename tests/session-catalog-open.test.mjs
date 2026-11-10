// Host-side desktop opener tests: honest capability detection + spawn verification.
//
// Run with: node tests/session-catalog-open.test.mjs
//
// The platform/env/spawn facts are injected through the SessionCatalog
// constructor, so every branch runs on one OS: a fake graphical session, a temp
// PATH directory with an executable xdg-open shim (real spawn, real argv), and
// scripted fake children for the async-error/timeout branches. The last test
// exercises the real process environment and asserts the bug report's case (a
// headless Linux host answers `unsupported` instead of a silent success).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SessionCatalog,
  createSessionCatalog,
  desktopAvailability,
  resolveOpener,
} from '../lib/index.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Fake Host context exposing only `ctx.get(name)` (all `openPath` needs). */
function makeContext(services = {}) {
  return {
    tools: {},
    effect: () => () => {},
    get: (name) => services[name],
  }
}

/** Build one catalog with injected platform/env/spawn facts. */
function makeCatalog(overrides) {
  return new SessionCatalog(makeContext(), Date.now, overrides)
}

/**
 * Temp directory containing an executable `xdg-open` shim that appends its
 * argv (one argument per line) to `argv.txt`, plus a saved file and a folder.
 */
function makePosixDesktopFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rdm-open-'))
  const shim = join(dir, 'xdg-open')
  const argvFile = join(dir, 'argv.txt')
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvFile}"\n`, { mode: 0o755 })
  chmodSync(shim, 0o755)
  const target = join(dir, 'download.bin')
  writeFileSync(target, 'payload')
  return {
    dir,
    shim,
    argvFile,
    target,
    /** Environment that capability detection accepts on Linux. */
    displayEnv: { DISPLAY: ':99', PATH: dir },
  }
}

/** Remove a fixture directory (recursive, never throws). */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Scripted child-process factory. Behavior per spawned child:
 * `spawn` -> a `'spawn'` event, `error` -> that `'error'` event, `never` ->
 * no event at all (the timeout branch).
 */
function scriptedSpawn(script) {
  const calls = []
  const children = []
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] })
    const listeners = new Map()
    const child = {
      unrefed: false,
      unref() {
        child.unrefed = true
      },
      on(event, listener) {
        listeners.set(event, listener)
        return child
      },
    }
    children.push(child)
    setImmediate(() => {
      if (script.event === 'spawn') listeners.get('spawn')?.()
      if (script.event === 'error') listeners.get('error')?.(script.error)
    })
    return child
  }
  return { calls, children, spawn }
}

/** Poll a file until it contains at least `count` lines, then return them. */
async function waitForLines(file, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    const lines = text === '' ? [] : text.split('\n')
    if (lines.length >= count) return lines
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${count} argv lines in ${file}`)
}

// ── Capability detection (pure) ─────────────────────────────────────────────

test('desktopAvailability reports a headless POSIX host as unsupported', () => {
  const headless = desktopAvailability('linux', {})
  assert.equal(headless.available, false)
  assert.equal(headless.reason, 'no_display')
  assert.match(headless.error, /graphical desktop session/)
  assert.match(headless.error, /DISPLAY/)
  assert.match(headless.error, /WAYLAND_DISPLAY/)
  assert.match(headless.error, /copy the path/)

  // Blank display variables do not count as a session.
  const blank = desktopAvailability('linux', { DISPLAY: '   ', WAYLAND_DISPLAY: '' })
  assert.equal(blank.reason, 'no_display')
})

test('desktopAvailability needs xdg-open on PATH even with a display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rdm-open-path-'))
  try {
    const emptyPath = desktopAvailability('linux', { DISPLAY: ':99', PATH: dir })
    assert.equal(emptyPath.available, false)
    assert.equal(emptyPath.reason, 'no_opener')
    assert.match(emptyPath.error, /xdg-open/)
    assert.match(emptyPath.error, /PATH/)
    // An unset/blank PATH cannot resolve any opener.
    assert.equal(desktopAvailability('linux', { DISPLAY: ':99', PATH: '' }).reason, 'no_opener')
    assert.equal(desktopAvailability('linux', { DISPLAY: ':99' }).reason, 'no_opener')

    // A non-executable file with the right name is not an opener.
    writeFileSync(join(dir, 'xdg-open'), '#!/bin/sh\n', { mode: 0o644 })
    assert.equal(desktopAvailability('linux', { DISPLAY: ':99', PATH: dir }).reason, 'no_opener')

    // Wayland alone counts as a graphical session once the opener resolves.
    chmodSync(join(dir, 'xdg-open'), 0o755)
    assert.deepEqual(desktopAvailability('linux', { WAYLAND_DISPLAY: 'wayland-0', PATH: dir }), {
      available: true,
      reason: 'ready',
    })
  } finally {
    cleanup(dir)
  }
})

test('desktopAvailability treats Windows and macOS as always having an opener', () => {
  assert.deepEqual(desktopAvailability('win32', {}), { available: true, reason: 'ready' })
  assert.deepEqual(desktopAvailability('darwin', {}), { available: true, reason: 'ready' })
})

// ── Opener resolution (pure apart from the PATH probe) ─────────────────────

test('resolveOpener picks the platform opener with reveal semantics on macOS', () => {
  assert.deepEqual(resolveOpener('C:\\Downloads\\a.zip', 'file', 'win32', {}), {
    ok: true,
    spec: { command: 'explorer.exe', args: ['C:\\Downloads\\a.zip'] },
  })
  assert.deepEqual(resolveOpener('C:\\Downloads', 'folder', 'win32', {}), {
    ok: true,
    spec: { command: 'explorer.exe', args: ['C:\\Downloads'] },
  })
  assert.deepEqual(resolveOpener('/Users/u/a.zip', 'file', 'darwin', {}), {
    ok: true,
    spec: { command: 'open', args: ['/Users/u/a.zip'] },
  })
  assert.deepEqual(resolveOpener('/Users/u/a.zip', 'folder', 'darwin', {}), {
    ok: true,
    spec: { command: 'open', args: ['-R', '/Users/u/a.zip'] },
  })
})

test('resolveOpener returns the absolute xdg-open path on Linux', () => {
  const fixture = makePosixDesktopFixture()
  try {
    const file = resolveOpener(fixture.target, 'file', 'linux', fixture.displayEnv)
    assert.equal(file.ok, true)
    assert.equal(file.spec.command, fixture.shim, 'the resolved path is spawned, not a bare name')
    assert.deepEqual(file.spec.args, [fixture.target])

    const folder = resolveOpener(fixture.dir, 'folder', 'linux', fixture.displayEnv)
    assert.equal(folder.ok, true)
    assert.deepEqual(folder.spec.args, [fixture.dir])

    const headless = resolveOpener(fixture.target, 'file', 'linux', { PATH: fixture.dir })
    assert.equal(headless.ok, false)
    assert.equal(headless.code, 'unsupported')
    assert.match(headless.error, /graphical desktop session/)
  } finally {
    cleanup(fixture.dir)
  }
})

// ── openPath: capability branch ─────────────────────────────────────────────

test('openPath reports unsupported before spawning on a headless host', async () => {
  const fixture = makePosixDesktopFixture()
  const spawns = []
  const catalog = makeCatalog({
    platform: 'linux',
    env: { PATH: fixture.dir }, // no DISPLAY / WAYLAND_DISPLAY
    spawn: (command) => {
      spawns.push(command)
      throw new Error('the opener must not be spawned when the host has no desktop')
    },
  })
  try {
    const result = await catalog.openPath(fixture.target, 'file')
    assert.equal(result.opened, false)
    assert.equal(result.code, 'unsupported')
    assert.match(result.error, /graphical desktop session/)
    assert.equal(spawns.length, 0, 'no child process is attempted')

    const noOpener = makeCatalog({
      platform: 'linux',
      env: { DISPLAY: ':99', PATH: fixture.dir + '-missing' },
      spawn: (command) => {
        spawns.push(command)
        throw new Error('unreachable')
      },
    })
    const missing = await noOpener.openPath(fixture.target, 'file')
    assert.equal(missing.opened, false)
    assert.equal(missing.code, 'unsupported')
    assert.match(missing.error, /xdg-open/)
    assert.equal(spawns.length, 0)
  } finally {
    cleanup(fixture.dir)
  }
})

// ── openPath: spawn verification ────────────────────────────────────────────

test('openPath starts the Linux opener and passes the resolved path as argv', async () => {
  const fixture = makePosixDesktopFixture()
  try {
    const catalog = makeCatalog({ platform: 'linux', env: fixture.displayEnv })
    const fileResult = await catalog.openPath(fixture.target, 'file')
    assert.deepEqual(fileResult, { opened: true })
    // Wait for the first shim to finish before spawning the second, so the
    // two detached children cannot interleave their argv lines.
    assert.deepEqual(await waitForLines(fixture.argvFile, 1), [fixture.target])

    const folderResult = await catalog.openPath(fixture.dir, 'folder')
    assert.deepEqual(folderResult, { opened: true })
    assert.deepEqual(await waitForLines(fixture.argvFile, 2), [fixture.target, fixture.dir], 'the shim received exactly the task path')
  } finally {
    cleanup(fixture.dir)
  }
})

test('openPath reports an async spawn error as io instead of success', async () => {
  const fixture = makePosixDesktopFixture()
  const scripted = scriptedSpawn({
    event: 'error',
    error: Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }),
  })
  const catalog = makeCatalog({
    platform: 'linux',
    env: fixture.displayEnv,
    spawn: scripted.spawn,
  })
  try {
    const result = await catalog.openPath(fixture.target, 'file')
    assert.equal(result.opened, false)
    assert.equal(result.code, 'io')
    assert.match(result.error, /failed to start/)
    assert.match(result.error, /ENOENT/)
    assert.equal(scripted.calls.length, 1)
    assert.equal(scripted.calls[0].command, fixture.shim)
    assert.equal(scripted.children[0].unrefed, false, 'a failed child is never detached')
  } finally {
    cleanup(fixture.dir)
  }
})

test('openPath treats an unconfirmed start as an io failure', async () => {
  const fixture = makePosixDesktopFixture()
  const scripted = scriptedSpawn({ event: 'never' })
  const catalog = makeCatalog({
    platform: 'linux',
    env: fixture.displayEnv,
    spawn: scripted.spawn,
    startTimeoutMs: 30,
  })
  try {
    const result = await catalog.openPath(fixture.target, 'file')
    assert.equal(result.opened, false)
    assert.equal(result.code, 'io')
    assert.match(result.error, /did not report a successful start within 30ms/)
    assert.equal(scripted.children[0].unrefed, false)
  } finally {
    cleanup(fixture.dir)
  }
})

test('openPath wraps a synchronous spawn throw as io', async () => {
  const fixture = makePosixDesktopFixture()
  const catalog = makeCatalog({
    platform: 'linux',
    env: fixture.displayEnv,
    spawn: () => {
      throw new Error('EPERM: process creation denied')
    },
  })
  try {
    const result = await catalog.openPath(fixture.target, 'file')
    assert.equal(result.opened, false)
    assert.equal(result.code, 'io')
    assert.match(result.error, /EPERM/)
  } finally {
    cleanup(fixture.dir)
  }
})

test('openPath uses reveal semantics on macOS through the same spawn check', async () => {
  const fixture = makePosixDesktopFixture()
  const scripted = scriptedSpawn({ event: 'spawn' })
  const catalog = makeCatalog({ platform: 'darwin', env: {}, spawn: scripted.spawn })
  try {
    assert.deepEqual(await catalog.openPath(fixture.target, 'file'), { opened: true })
    assert.deepEqual(await catalog.openPath(fixture.dir, 'folder'), { opened: true })
    assert.deepEqual(scripted.calls, [
      { command: 'open', args: [fixture.target] },
      { command: 'open', args: ['-R', fixture.dir] },
    ])
    assert.equal(scripted.children[0].unrefed, true, 'a started child is detached')
    assert.equal(scripted.children[1].unrefed, true)
  } finally {
    cleanup(fixture.dir)
  }
})

// ── openPath: validation is unchanged and runs before capability detection ──

test('openPath validation still rejects bad input before capability detection', async () => {
  const catalog = makeCatalog({
    platform: 'linux',
    env: {}, // headless: a validated path would be unsupported
    spawn: () => {
      throw new Error('must not spawn for invalid input')
    },
  })
  const relative = await catalog.openPath('relative/file.zip', 'file')
  assert.equal(relative.opened, false)
  assert.equal(relative.code, 'invalid_request')

  const nul = await catalog.openPath('/tmp/a\u0000b.zip', 'file')
  assert.equal(nul.opened, false)
  assert.equal(nul.code, 'invalid_request')

  const missing = await catalog.openPath('/definitely-missing/dsh-rdm-test.zip', 'file')
  assert.equal(missing.opened, false)
  assert.equal(missing.code, 'not_found')

  const badTarget = await catalog.openPath('/definitely-missing/x.zip', 'desktop')
  assert.equal(badTarget.opened, false)
  assert.equal(badTarget.code, 'invalid_request')
})

// ── Real process environment: the reported headless case ────────────────────

test('the real host environment reports this headless Linux host as unsupported', async (t) => {
  if (process.platform !== 'linux') {
    return t.skip('the headless capability branch is POSIX-specific')
  }
  if ((process.env.DISPLAY ?? '') !== '' || (process.env.WAYLAND_DISPLAY ?? '') !== '') {
    return t.skip('this host has a graphical session; the real opener would launch')
  }
  const fixture = makePosixDesktopFixture()
  try {
    const catalog = createSessionCatalog(makeContext())
    const result = await catalog.openPath(fixture.target, 'folder')
    assert.equal(result.opened, false, 'a headless host must not claim the folder opened')
    assert.equal(result.code, 'unsupported')
    assert.match(result.error, /DISPLAY/)
    assert.match(result.error, /copy the path/)
  } finally {
    cleanup(fixture.dir)
  }
})
