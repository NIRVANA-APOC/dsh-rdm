// Client-half activation contract tests for `lib/client.js`.
//
// Run with: node scripts/build.mjs && node tests/client-activation.test.mjs
//
// Why this exists: DSH audits every client entry after Cordis boot and replaces
// the whole harness UI with "Failed to load plugins" when a single fiber does
// not reach `active`. A throw inside the plugin's `apply` is therefore a
// process-wide outage for the profile that installed the plugin, not a local
// degradation — and 0.3.0 shipped exactly that (`ctx.layout` read without
// declaring `layout` in `inject` throws
// `cannot get property "layout" without inject`).
//
// The context below mirrors Cordis: every service read through the property
// path throws unless the plugin declared it in `inject`, while `ctx.get(name)`
// is the reflection read that always works.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')

// ── Harness ─────────────────────────────────────────────────────────────────

/** Minimal React stand-in: capture element trees without a renderer. */
function reactStub() {
  return {
    __esModule: true,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
  }
}

/** Evaluate the built bundle and return the module face it registers. */
async function loadClientFace() {
  const source = await readFile(bundlePath, 'utf8')
  const registrations = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    window: {
      __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  const [registration] = registrations
  assert.equal(registration.id, 'dsh-rdm')
  const react = reactStub()
  const face = registration.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected external require: ${specifier}`)
  })
  return { face, react }
}

/**
 * Build a strict, Cordis-shaped client context.
 *
 * @param options - `provide` maps service names to objects; `inject` is the
 *   plugin's declared dependency list. Optional services (such as `layout`) are
 *   provided per test; reading one through the property path must still throw
 *   unless it is declared in `inject`.
 */
function strictContext({ inject, provide = {}, throwOnRegister = null }) {
  const registered = []
  const services = {
    slots: {
      inject(_name, factory) {
        const value = typeof factory === 'function' ? factory() : undefined
        return { dispose() {}, value }
      },
      register(descriptor, component) {
        if (throwOnRegister !== null && descriptor?.name === throwOnRegister) {
          throw new Error(`slot ${descriptor.name} registration rejected`)
        }
        registered.push({ descriptor, component })
        return { dispose() {} }
      },
    },
    locale: {
      register: () => () => {},
      bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`),
    },
    ...provide,
  }
  const allowed = new Set(inject)
  const ctx = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'get' || property === 'has') {
          return (name) => services[name]
        }
        if (property === 'effect') {
          return (callback) => {
            const disposer = callback()
            return disposer
          }
        }
        if (property === 'inject') {
          return (deps, callback) => {
            const bag = { get: (name) => services[name] }
            callback?.(bag)
            return { dispose() {} }
          }
        }
        if (typeof property === 'string' && property in services) {
          // Exactly Cordis's guard: property access outside `inject` throws.
          if (!allowed.has(property)) throw new Error(`cannot get property "${property}" without inject`)
          return services[property]
        }
        return undefined
      },
    },
  )
  return { ctx, registered, services }
}

const layout = { selectPanel: (panelId) => { layout.selected = panelId }, selected: undefined }

// ── Tests ───────────────────────────────────────────────────────────────────

test('the bundle exposes a plain cordis face', async () => {
  const { face } = await loadClientFace()
  assert.equal(face.name, 'dsh-rdm')
  assert.deepEqual([...face.inject], ['slots', 'locale'])
  assert.equal(typeof face.apply, 'function')
})

test('apply never throws on an optional service outside inject (0.3.0 outage)', async () => {
  const { face } = await loadClientFace()
  const { ctx } = strictContext({ inject: face.inject, provide: { layout } })
  // The regression: `ctx.layout` throws in Cordis, so apply must not read it.
  assert.throws(() => {
    void ctx.layout
  }, /cannot get property "layout" without inject/)
  assert.doesNotThrow(() => face.apply(ctx))
})

test('activation registers the sidebar entry, the main panel and the popup', async () => {
  const { face } = await loadClientFace()
  const { ctx, registered } = strictContext({ inject: face.inject, provide: { layout } })
  face.apply(ctx)
  const names = registered.map((entry) => entry.descriptor.name)
  assert.ok(names.includes('sidebar.panellist'), 'sidebar entry missing')
  assert.ok(names.includes('main'), 'global review panel missing')
  assert.ok(names.includes('shell.overlay'), 'active-download popup missing')
  assert.equal(registered.find((entry) => entry.descriptor.name === 'main').descriptor.key, 'rdm')
  assert.equal(
    registered.find((entry) => entry.descriptor.name === 'sidebar.panellist').descriptor.id,
    'rdm',
  )
})

test('the popup resolves layout at click time, not during activation', async () => {
  // Real boot race: the page starts every client entry in one pass, so the
  // layout package's fiber is usually still pending while this plugin's
  // `apply` runs. A service captured then would stay undefined forever; the
  // click must resolve it lazily.
  const { face } = await loadClientFace()
  const { ctx, registered, services } = strictContext({ inject: face.inject, provide: {} })
  face.apply(ctx)
  const popup = registered.find((entry) => entry.descriptor.name === 'shell.overlay')
  const element = popup.component()
  // Boot stage: layout is not published yet — the click is a guarded no-op.
  layout.selected = undefined
  assert.doesNotThrow(() => element.props.onOpen())
  assert.equal(layout.selected, undefined)
  // The page finishes booting and the layout entry becomes active.
  services.layout = layout
  element.props.onOpen()
  assert.equal(layout.selected, 'rdm')
})

test('the popup opens the workbench through layout.selectPanel', async () => {
  const { face } = await loadClientFace()
  const { ctx, registered } = strictContext({ inject: face.inject, provide: { layout } })
  face.apply(ctx)
  layout.selected = undefined
  const popup = registered.find((entry) => entry.descriptor.name === 'shell.overlay')
  // The slot runtime calls the registered component; call it the same way.
  const element = popup.component()
  assert.equal(typeof element.props.onOpen, 'function')
  element.props.onOpen()
  assert.equal(layout.selected, 'rdm')
})

test('a profile without the layout service still activates', async () => {
  const { face } = await loadClientFace()
  const { ctx, registered } = strictContext({ inject: face.inject, provide: {} })
  assert.doesNotThrow(() => face.apply(ctx))
  assert.ok(registered.some((entry) => entry.descriptor.name === 'main'))
})

test('a throwing optional surface is contained instead of failing the fiber', async () => {
  const { face } = await loadClientFace()
  const { ctx, registered } = strictContext({
    inject: face.inject,
    provide: { layout },
    throwOnRegister: 'shell.overlay',
  })
  assert.doesNotThrow(() => face.apply(ctx))
  assert.ok(registered.some((entry) => entry.descriptor.name === 'main'), 'earlier surfaces stay registered')
})

test('the removed right-sidebar tab registers no native surface', async () => {
  const { face } = await loadClientFace()
  const tabs = { ids: [], register(descriptor) { this.ids.push(descriptor.id) } }
  const { ctx, registered } = strictContext({
    inject: face.inject,
    provide: { layout, sidebarRightTabs: tabs, sidebarRight: { openResource() {} } },
  })
  face.apply(ctx)
  assert.deepEqual(tabs.ids, [], 'the native tab type is no longer registered')
  const names = registered.map((entry) => entry.descriptor.name)
  assert.ok(
    !names.some((name) => typeof name === 'string' && name.startsWith('sidebar.right.pane.tab')),
    'no native right-sidebar slot is registered',
  )
  assert.ok(names.includes('main'), 'the workbench panel stays registered')
  assert.ok(names.includes('shell.overlay'), 'the popup stays registered')
})
