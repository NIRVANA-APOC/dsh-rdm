// Client half of the dsh-rdm plugin (0.3.4).
//
// Compiled by scripts/dev-build.sh into the Harness module-loader format:
// `window.__ModuleLoader__.load({ id: 'dsh-rdm', factory(require) { ... } })`.
// The factory's `require` provides the baseline `react` module, so React is
// imported normally and JSX compiles to `React.createElement` (classic runtime).
//
// Surfaces:
//   * `sidebar.panellist` entry (id `rdm`) → the root-scoped `main` keyed slot
//     `rdm`, which renders the download workbench (composer, cards, ledger);
//   * `shell.overlay` (id `dsh-rdm-progress`) → the active-download popup.

import React from 'react'
import en from '../../locale/en.json'
import zh from '../../locale/zh.json'
import { Icon } from './icon'
import { ReviewPage } from './ledger'
import { DownloadsPopup } from './overlay'
import { optionalService } from './services'
import type { ClientContext, LayoutService, TFunction } from './types'

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
  // DSH audits every client entry after Cordis boot and fails the whole page
  // ("Failed to load plugins") when one fiber does not reach `active`. A throw
  // in `apply` is therefore not a local failure — it takes the harness UI down
  // for every profile that installs this plugin. Activation stays total: each
  // optional surface is guarded, and this frame is the last-resort net.
  try {
    activate(ctx)
  } catch (error) {
    console.warn('[dsh-rdm] client activation failed; download surfaces stay hidden:', error)
  }
}

function activate(ctx: ClientContext): void {
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

  // Frame-wide active-download popup. This is the one surface that is visible
  // outside the plugin panel, so it renders nothing unless a session is running
  // a download.
  //
  // The layout service is optional and must be resolved at USE time, not
  // captured during activation: the DSH page starts every client entry in the
  // same boot pass, so a service provided by a sibling entry (the layout
  // package) may still be `pending` while this plugin's `apply` runs — Cordis
  // publishes a service only once its fiber is active. A value captured here
  // would therefore stay `undefined` for the life of the page, and the popup's
  // "open downloads page" button would silently do nothing. It is also read
  // through `ctx.get` because `ctx.layout` throws for a service outside
  // `inject`.
  const openDownloads = (): void => {
    try {
      // Throws when the shell has not registered the `rdm` main panel; the
      // popup's own button then stays a no-op instead of failing activation.
      const layout = optionalService<LayoutService>(ctx, 'layout')
      if (typeof layout?.selectPanel !== 'function') {
        console.warn('[dsh-rdm] layout service is unavailable; the downloads panel cannot be selected')
        return
      }
      layout.selectPanel(SLOT_ID)
    } catch (error) {
      console.warn('[dsh-rdm] could not open the downloads panel:', error)
    }
  }
  try {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-rdm-progress', order: 40, locale: NAMESPACE },
        () => React.createElement(DownloadsPopup, { t, onOpen: openDownloads }),
      ),
    )
  } catch (error) {
    console.warn('[dsh-rdm] active-download popup registration skipped:', error)
  }

}

const name = 'dsh-rdm'
const inject = ['slots', 'locale']

module.exports = { name, inject, apply }

