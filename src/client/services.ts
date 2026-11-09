// Optional-service access for the client half.
//
// Cordis resolves a plugin's services strictly: reading `ctx.<name>` for a
// service that the plugin did not declare in `inject` **throws**
// (`cannot get property "<name>" without inject`). A throw inside `apply` fails
// the plugin's fiber, and the shell's boot audit turns one failed client entry
// into a fatal `Failed to load plugins` page — so a plugin that only *wants* an
// optional service must never touch it through the property path.
//
// `ctx.get(name)` is Cordis's reflection read: it bypasses the inject guard and
// returns `undefined` for a service this deployment does not mount. That is the
// path used here, with the property read kept only as a last-resort fallback
// (a non-Cordis context such as the preview harness serves plain objects).

import type { ClientContext } from './types'

/**
 * Read one optional service without tripping Cordis's inject guard.
 *
 * @param ctx - Client plugin context.
 * @param name - Service name as it appears on the context (`layout`, ...).
 * @returns the service, or `undefined` when this deployment does not provide it.
 */
export function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(name) as T | undefined
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      // An unreadable service is the same as an absent one.
    }
  }
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[name] as T | undefined
    return direct ?? undefined
  } catch {
    // Cordis throws here for a service outside `inject`; treat it as absent.
    return undefined
  }
}
