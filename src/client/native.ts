// Registration of the plugin's content into the DSH native right Sidebar.
//
// Two stages, exactly the public path described by
// `@deepseek-ai/dsh-client-ui-sidebar-right` (§ Extension seats):
//
//   1. the tab TYPE — id `dsh-rdm/downloads`, kind `rdm`, a guide entry and the
//      captured chip title;
//   2. the keyed slots — `sidebar.right.pane.tab` (body) and
//      `sidebar.right.pane.tab.title` (live chip), both keyed by the same id.
//
// The service is waited for with `ctx.inject(['sidebarRightTabs'], …)` rather
// than read eagerly: the sidebar package declares the slot seat before it
// provides the registry, so an eager read can see undefined forever (the
// failure mode documented in the reference implementation
// `dsh-better-sidebar/src/client/native/index.ts`).
//
// Everything here is optional and guarded: when the profile does not inject
// `@deepseek-ai/dsh-client-ui-sidebar-right`, the left review page still works
// and only the native tab is absent.

import React from 'react'
import { Icon } from './icon'
import { makeSessionTabBody, makeSessionTabTitle } from './session-tab'
import { optionalService } from './services'
import type { ClientContext, SidebarRightService, SidebarTabRegistry, TFunction } from './types'

/** Native tab implementation id (unique across every registration). */
export const TAB_ID = 'dsh-rdm/downloads'

/** Tab kind this plugin owns. */
export const TAB_KIND = 'rdm'

/** Guide entry order (after the shipped guide's own entries). */
const GUIDE_ORDER = 40

/** Dependencies needed to register the surface. */
export interface NativeSidebarDeps {
  /** Bound locale translate function. */
  t: TFunction
}

/** Resolve the native tab registry from the plugin context (direct or via `get`). */
function registryOf(ctx: ClientContext): SidebarTabRegistry | undefined {
  // `ctx.sidebarRightTabs` throws for a service outside `inject`; the optional
  // reader goes through `ctx.get` and treats a missing service as absent.
  const direct = optionalService<SidebarTabRegistry>(ctx, 'sidebarRightTabs')
  if (direct !== undefined && typeof direct.register === 'function') return direct
  return undefined
}

/** Resolve the sidebar navigation controller. */
function controllerOf(ctx: ClientContext): SidebarRightService | undefined {
  const direct = optionalService<SidebarRightService>(ctx, 'sidebarRight')
  if (direct !== undefined && typeof direct.openResource === 'function') return direct
  return undefined
}

/** Component-encode one resource-address path segment, keeping `:` for drives. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Encode a `/`-separated path segment by segment. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment, index, all) => segment !== '' || index === 0 || index === all.length - 1)
    .map(encodeSegment)
    .join('/')
}

/**
 * Build the `dsh-resource://file/…` address of a downloaded file.
 *
 * A session-scoped address is preferred (the file viewer resolves it against
 * the session's workspace and can show a real path); without a session the
 * absolute scope carries the path on its own.
 */
export function fileAddress(path: string, sessionId?: string | null): string {
  const normalized = path.replace(/\\/g, '/')
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
    return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
  }
  const stripped = normalized.replace(/^\/+/, '')
  return `dsh-resource://file/absolute/${encodePath(stripped)}`
}

/**
 * Reveal one saved file in the host's file viewer. Returns false when no
 * controller is available, so the caller can fall back to copying the path.
 */
export function revealFile(ctx: ClientContext, path: string, sessionId?: string | null): boolean {
  const controller = controllerOf(ctx)
  if (controller === undefined || typeof controller.openResource !== 'function') return false
  const attempts = sessionId !== undefined && sessionId !== null && sessionId !== ''
    ? [fileAddress(path, sessionId), fileAddress(path)]
    : [fileAddress(path)]
  for (const address of attempts) {
    try {
      controller.openResource(address, { revealIfOpened: true })
      return true
    } catch {
      // Try the next address form; the absolute scope is the fallback for a
      // host build that does not accept a session-scoped path.
    }
  }
  return false
}

/** Install the type + slots once the registry exists. */
function install(tabs: SidebarTabRegistry, ctx: ClientContext, deps: NativeSidebarDeps): void {
  const { t } = deps
  try {
    tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      keepMounted: true,
      priority: 'extension',
      title: () => t('session.title'),
      guide: [
        {
          id: 'downloads',
          order: GUIDE_ORDER,
          title: () => t('session.title'),
          description: () => t('guide.description'),
          icon: (props: { size?: number }) => React.createElement(Icon, { size: props.size ?? 16 }),
        },
      ],
    })
  } catch (error) {
    console.warn('[dsh-rdm] right-sidebar tab type registration failed:', error)
    return
  }

  const bodyFor = (): unknown =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        // The slot framework calls this with the column's session id; the
        // body then scopes its ledger to that session.
        inject: (sessionId: string) => ({ sessionId }),
      },
      makeSessionTabBody(t, (path, sessionId) => {
        revealFile(ctx, path, sessionId)
      }),
    )

  const titleFor = (): unknown =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        inject: (sessionId: string) => ({ sessionId }),
      },
      makeSessionTabTitle(t),
    )

  try {
    ctx.slots.inject('sidebar.right.pane.tab', bodyFor)
  } catch (error) {
    console.warn('[dsh-rdm] right-sidebar tab body registration failed:', error)
  }
  try {
    ctx.slots.inject('sidebar.right.pane.tab.title', titleFor)
  } catch (error) {
    console.warn('[dsh-rdm] right-sidebar tab title registration failed:', error)
  }
}

/**
 * Register the native tab surface. Never throws: a profile without the
 * sidebar package (or with a different slot runtime) degrades to the left
 * review page only.
 */
export function registerNativeSidebar(ctx: ClientContext, deps: NativeSidebarDeps): void {
  let installed = false
  const installOnce = (tabs: SidebarTabRegistry): void => {
    if (installed) return
    installed = true
    try {
      install(tabs, ctx, deps)
    } catch (error) {
      console.warn('[dsh-rdm] right-sidebar surface unavailable:', error)
    }
  }

  // Wait for the registry service when the context supports cordis injection.
  let seatRequested = false
  if (typeof ctx.inject === 'function') {
    try {
      const seat = ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = injected.get('sidebarRightTabs') as SidebarTabRegistry | undefined
        if (tabs !== undefined && typeof tabs.register === 'function') installOnce(tabs)
      })
      // A seat exists even when the callback has not run yet: the sidebar
      // package may provide the registry after this plugin activates, so the
      // install happens later and silence here is correct.
      seatRequested = true
      if (seat !== undefined && typeof seat.dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => seat.dispose?.(), 'dsh-rdm: native sidebar seat')
      }
      if (installed) return
    } catch (error) {
      seatRequested = false
      console.warn('[dsh-rdm] waiting for the right-sidebar registry failed:', error)
    }
  }

  const immediate = registryOf(ctx)
  if (immediate !== undefined) {
    installOnce(immediate)
    return
  }
  // A requested seat installs the tab as soon as the service appears; only a
  // context without cordis injection is genuinely unable to wait for it.
  if (seatRequested) {
    console.debug('[dsh-rdm] native right-sidebar tab waits for "sidebarRightTabs" to mount')
    return
  }
  console.warn(
    '[dsh-rdm] native right-sidebar tab not registered: add "@deepseek-ai/dsh-client-ui-sidebar-right" ' +
      'to dsh.client.inject in package.json (the left review page is unaffected).',
  )
}
