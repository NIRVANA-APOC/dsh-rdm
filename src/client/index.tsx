// Client half of the dsh-rdm plugin (0.2.0).
//
// Compiled by scripts/dev-build.sh into the Harness module-loader format:
// `window.__ModuleLoader__.load({ id: 'dsh-rdm', factory(require) { ... } })`.
// The factory's `require` provides the baseline `react` module, so React is
// imported normally and JSX compiles to `React.createElement` (classic runtime).
//
// Surfaces:
//   * `sidebar.panellist` entry (id `rdm`) → the root-scoped `main` keyed slot
//     `rdm`, which renders the global review page (flight recorder, no composer);
//   * the session right-sidebar native tab `dsh-rdm/downloads`, registered only
//     when the profile injects `@deepseek-ai/dsh-client-ui-sidebar-right`.
//
// A missing sidebar service must never break the left page: the native
// registration is awaited in the background and is fully guarded.

import React from 'react'
import en from '../../locale/en.json'
import zh from '../../locale/zh.json'
import { Icon } from './icon'
import { ReviewPage } from './ledger'
import { registerNativeSidebar } from './native'
import type { ClientContext, TFunction } from './types'

const NAMESPACE = 'dsh-rdm'
const SLOT_ID = 'rdm'

/** Flatten the nested locale JSON into the flat dotted keys the locale service looks up. */
function flattenDictionary(source: Record<string, unknown>, prefix = '', target: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') {
      target[path] = value
    } else if (value !== null && typeof value === 'object') {
      flattenDictionary(value as Record<string, unknown>, path, target)
    }
  }
  return target
}

function apply(ctx: ClientContext): void {
  // Dictionaries: the plugin's locale JSON files are the single source of truth;
  // the locale service wants flat keys, so nested sections are flattened here.
  const disposeDictionaries = ctx.locale.register(NAMESPACE, {
    en: flattenDictionary(en as Record<string, unknown>),
    zh: flattenDictionary(zh as Record<string, unknown>),
  })
  if (typeof ctx.effect === 'function' && typeof disposeDictionaries === 'function') {
    ctx.effect(() => disposeDictionaries, 'dsh-rdm: dictionaries')
  }
  const t: TFunction = ctx.locale.bind(NAMESPACE)

  // Sidebar entry. The sidebar renders this component with `{ size, active }` and
  // uses the same id for the `main` panel key.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: SLOT_ID,
        order: 30,
        label: () => t('page.title'),
        locale: NAMESPACE,
      },
      (props: { size?: unknown; active?: unknown }) =>
        React.createElement(Icon, {
          size: typeof props.size === 'number' ? props.size : undefined,
          active: props.active === true,
        }),
    ),
  )

  // Global review page, selected by the sidebar row through the shared panel id.
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: SLOT_ID, locale: NAMESPACE }, (props: Record<string, unknown>) =>
      React.createElement(ReviewPage, { ...props, t }),
    ),
  )

  // Session review surface: native right-sidebar tab. Optional by construction —
  // when the sidebar package is not injected this logs and returns.
  try {
    registerNativeSidebar(ctx, { t })
  } catch (error) {
    console.warn('[dsh-rdm] native right-sidebar registration skipped:', error)
  }
}

const name = 'dsh-rdm'
const inject = ['slots', 'locale']

module.exports = { name, inject, apply }
