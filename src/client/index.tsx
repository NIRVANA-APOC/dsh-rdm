// Client half of the dsh-rdm plugin.
//
// Compiled by scripts/build.mjs into the Harness module-loader format:
// `window.__ModuleLoader__.load({ id: 'dsh-rdm', factory(require) { ... } })`.
// The factory's `require` provides the baseline `react` module, so React is
// imported normally and JSX compiles to `React.createElement` (classic runtime).
//
// The plugin registers a sidebar entry (`sidebar.panellist`, id `rdm`) whose icon
// opens the RDM download panel in the root-scoped `main` keyed slot (`rdm`).

import React from 'react'
import en from '../../locale/en.json'
import zh from '../../locale/zh.json'
import { Icon } from './icon'
import { Panel } from './panel'
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
        label: () => t('panel.title'),
        locale: NAMESPACE,
      },
      (props: { size?: unknown; active?: unknown }) =>
        React.createElement(Icon, {
          size: typeof props.size === 'number' ? props.size : undefined,
          active: props.active === true,
        }),
    ),
  )

  // Main panel, selected by the sidebar row through the shared panel id.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: SLOT_ID, locale: NAMESPACE },
      (props: Record<string, unknown>) => React.createElement(Panel, { ...props, t, locale: ctx.locale }),
    ),
  )
}

const name = 'dsh-rdm'
const inject = ['slots', 'locale']

module.exports = { name, inject, apply }
