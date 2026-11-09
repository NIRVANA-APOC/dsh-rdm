// Styles for the three review surfaces (global workbench, session tab,
// active-download popup).
//
// One token block on `.rdm2` maps host theme tokens to local names; every rule
// consumes those locals and there are no literal colours. The workbench is a
// single centred column: a paste-a-link composer, three state cards (the one
// bold element), a quiet filter/selection toolbar and a workspace → session
// ledger of cards. The popup repeats the same card language at frame scale.
//
// Motion is limited to answering a user action: card/row hover, the popup's
// single entrance, and the meter transition. `prefers-reduced-motion` removes
// all of it.

export const REVIEW_CSS = `
.rdm2 {
  --rdm2-base: var(--dsw-alias-bg-base);
  --rdm2-card: var(--dsw-alias-bg-layer-1);
  --rdm2-wash: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2));
  --rdm2-ink: var(--dsw-alias-label-primary);
  --rdm2-ink-2: var(--dsw-alias-label-secondary);
  --rdm2-ink-3: color-mix(in srgb, var(--dsw-alias-label-tertiary) 84%, var(--dsw-alias-label-primary));
  --rdm2-line: var(--dsw-alias-border-l1);
  --rdm2-line-2: var(--dsw-alias-border-l2);
  --rdm2-hover: var(--dsw-alias-interactive-bg-hover);
  --rdm2-live: var(--dsw-alias-state-business-primary);
  --rdm2-ok: var(--dsw-alias-state-success-primary);
  --rdm2-warn: var(--dsw-alias-state-warn-primary);
  --rdm2-err: var(--dsw-alias-state-error-primary);
  --rdm2-primary-fill: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
  --rdm2-primary-hover: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary));
  --rdm2-on-primary: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-bg-base));
  --rdm2-ok-graphic: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
  --rdm2-warn-graphic: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 75%, var(--dsw-alias-label-primary));
  --rdm2-err-graphic: var(--dsw-alias-state-error-primary);
  --rdm2-ok-text: color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, var(--dsw-alias-label-primary));
  --rdm2-warn-text: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, var(--dsw-alias-label-primary));
  --rdm2-err-text: color-mix(in srgb, var(--dsw-alias-state-error-primary) 86%, var(--dsw-alias-label-primary));
  --rdm2-live-text: color-mix(in srgb, var(--dsw-alias-state-business-primary) 62%, var(--dsw-alias-label-primary));
  --rdm2-live-soft: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  --rdm2-focus: color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, var(--dsw-alias-label-primary));
  --rdm2-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  --rdm2-track: color-mix(in srgb, var(--dsw-alias-label-tertiary) 18%, transparent);
  --rdm2-wave-fill: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  --rdm2-wave-line: color-mix(in srgb, var(--dsw-alias-state-business-primary) 78%, var(--dsw-alias-label-primary));
  --rdm2-skeleton: var(--dsw-alias-bg-skeleton, color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent));
  --rdm2-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --rdm2-shadow-lift: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  color: var(--rdm2-ink);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
[data-ds-dark-theme] .rdm2 {
  --rdm2-ok-graphic: var(--dsw-alias-state-success-primary);
  --rdm2-warn-graphic: var(--dsw-alias-state-warn-primary);
  --rdm2-err-graphic: var(--dsw-alias-state-error-primary);
  --rdm2-shadow: 0 1px 2px color-mix(in srgb, #000 24%, transparent);
  --rdm2-shadow-lift: 0 10px 28px color-mix(in srgb, #000 36%, transparent);
}
.rdm2 * { box-sizing: border-box; }
.rdm2 button { font: inherit; color: inherit; }
.rdm2 :focus-visible { outline: 2px solid var(--rdm2-focus); outline-offset: 2px; }

/* ------------------------------------------------------------------- page */

.rdm2-page {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--rdm2-base);
}
[data-platform='darwin'] .rdm2-page {
  padding-top: var(--dsh-frame-top-clearance, 0px);
}
.rdm2-page-inner {
  box-sizing: border-box;
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
  padding: 26px clamp(20px, 3vw, 40px) 56px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.rdm2-page-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-height: 28px;
  flex-wrap: wrap;
}
.rdm2-title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--rdm2-ink);
}
.rdm2-kernel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ok-text);
}
.rdm2-kernel[data-ok='false'] { color: var(--rdm2-err-text); }
.rdm2-kernel[data-ok='loading'] { color: var(--rdm2-ink-3); }
.rdm2-kernel-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--rdm2-err-graphic);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--rdm2-err) 18%, transparent);
}
.rdm2-kernel-dot[data-tone='ok'] {
  background: var(--rdm2-ok-graphic);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--rdm2-ok) 18%, transparent);
}
.rdm2-kernel-dot[data-tone='idle'] {
  background: var(--rdm2-ink-3);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--rdm2-ink-3) 18%, transparent);
}

/* --------------------------------------------------------------- composer */

.rdm2-composer { display: flex; flex-direction: column; gap: 6px; }
.rdm2-composer-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 5px 5px 12px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 12px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow);
  color: var(--rdm2-ink-3);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.rdm2-composer-field:focus-within {
  border-color: var(--rdm2-live);
  box-shadow: 0 0 0 3px var(--rdm2-live-soft);
}
.rdm2-composer-field[data-invalid='true'] { border-color: color-mix(in srgb, var(--rdm2-err) 55%, transparent); }
.rdm2-composer-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--rdm2-ink);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.rdm2-composer-input::placeholder { color: var(--rdm2-ink-3); }
.rdm2-composer-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--rdm2-primary-fill);
  color: var(--rdm2-on-primary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.rdm2-composer-submit:hover:not(:disabled) { background: var(--rdm2-primary-hover); }
.rdm2-composer-submit:disabled { opacity: 0.45; cursor: default; }
.rdm2-composer-error { margin: 0 4px; font-size: 12px; line-height: 18px; color: var(--rdm2-err-text); }

/* ----------------------------------------------------------------- cards */

.rdm2-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.rdm2-stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  min-width: 0;
  padding: 14px 16px 13px;
  text-align: left;
  border: 1px solid var(--rdm2-line);
  border-radius: 14px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.rdm2-stat:hover { border-color: var(--rdm2-line-2); box-shadow: var(--rdm2-shadow-lift); }
.rdm2-stat[data-active='true'] { border-color: var(--rdm2-live); box-shadow: 0 0 0 3px var(--rdm2-live-soft); }
.rdm2-stat-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.rdm2-stat-label { font-size: 12.5px; line-height: 18px; font-weight: 500; color: var(--rdm2-ink-2); }
.rdm2-stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin: -2px -2px 0 0;
  border-radius: 9px;
  background: var(--rdm2-live-soft);
  color: var(--rdm2-live-text);
}
.rdm2-stat[data-tone='done'] .rdm2-stat-icon { background: color-mix(in srgb, var(--rdm2-ok) 12%, transparent); color: var(--rdm2-ok-text); }
.rdm2-stat[data-tone='failed'] .rdm2-stat-icon { background: color-mix(in srgb, var(--rdm2-err) 10%, transparent); color: var(--rdm2-err-text); }
.rdm2-stat-value {
  margin-top: 6px;
  font-size: 30px;
  line-height: 36px;
  font-weight: 600;
  letter-spacing: -0.6px;
  color: var(--rdm2-ink);
}
.rdm2-stat-hint {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--rdm2-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ------------------------------------------------------------------ risk */

.rdm2-risk { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; }
.rdm2-risk-summary {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-warn-text);
  cursor: pointer;
}
.rdm2-risk-rows { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rdm2-risk[data-expanded='false'] .rdm2-risk-rows { display: none; }
.rdm2-risk-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--rdm2-warn-text); }
.rdm2-risk-row[data-severity='error'] { color: var(--rdm2-err-text); }
.rdm2-risk-name {
  flex: 0 1 auto;
  max-width: 34ch;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--rdm2-ink);
  font-weight: 500;
}
.rdm2-risk-cause { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rdm2-risk-more { color: var(--rdm2-ink-3); padding-left: 18px; }
.rdm2-risk-summary-dot { font-size: 12px; line-height: 12px; }

/* ---------------------------------------------------------------- banner */

.rdm2-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--rdm2-warn) 42%, transparent);
  background: color-mix(in srgb, var(--rdm2-warn) 7%, var(--rdm2-card));
  border-radius: 10px;
  font-size: 12px;
  line-height: 18px;
}
.rdm2-banner-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rdm2-banner-title { color: var(--rdm2-ink); font-weight: 500; }
.rdm2-banner-hint { color: var(--rdm2-ink-2); }

/* --------------------------------------------------------------- toolbar */

.rdm2-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-top: 2px;
}
.rdm2-toolbar-start, .rdm2-toolbar-end { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.rdm2-select-all { display: inline-flex; align-items: center; gap: 7px; }
.rdm2-select-all-label {
  padding: 0;
  border: 0;
  background: none;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--rdm2-ink-2);
  cursor: pointer;
}
.rdm2-select-all-label:hover { color: var(--rdm2-ink); }
.rdm2-select-all-label:disabled { opacity: 0.5; cursor: default; }
.rdm2-result-count, .rdm2-selected-count { font-size: 12px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }
.rdm2-selected-count { color: var(--rdm2-ink-2); margin-left: 2px; }
.rdm2-search {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 10px;
  background: var(--rdm2-card);
  color: var(--rdm2-ink-3);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.rdm2-search:focus-within { border-color: var(--rdm2-live); box-shadow: 0 0 0 3px var(--rdm2-live-soft); }
.rdm2-search > svg { position: absolute; left: 10px; top: 10px; pointer-events: none; }
.rdm2-search input {
  width: 210px;
  max-width: 48vw;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--rdm2-ink);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.rdm2-search input::placeholder { color: var(--rdm2-ink-3); }
.rdm2-search input::-webkit-search-cancel-button { display: none; }
.rdm2-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--rdm2-ink-3);
  cursor: pointer;
}
.rdm2-search-clear:hover { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-ext { position: relative; }
.rdm2-ext-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 10px;
  background: var(--rdm2-card);
  color: var(--rdm2-ink-2);
  font-size: 12.5px;
  cursor: pointer;
}
.rdm2-ext-trigger:hover { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-ext-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--rdm2-live-soft);
  color: var(--rdm2-live-text);
  font-size: 10.5px;
  font-weight: 600;
}
.rdm2-disclosure { display: inline-flex; color: var(--rdm2-ink-3); transition: transform 0.15s ease; }
.rdm2-disclosure[data-open='true'] { transform: rotate(180deg); }
.rdm2-ext-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: 216px;
  max-height: 300px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 12px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow-lift);
}
.rdm2-ext-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--rdm2-ink-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.rdm2-ext-row:hover { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-ext-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 4px;
  color: var(--rdm2-base);
  background: transparent;
}
.rdm2-ext-row[data-checked='true'] .rdm2-ext-tick { border-color: var(--rdm2-live); background: var(--rdm2-live); }
.rdm2-ext-name { flex: 1 1 auto; min-width: 0; font-family: var(--rdm2-code); font-size: 11.5px; }
.rdm2-ext-meta { flex: none; color: var(--rdm2-ink-3); font-size: 11px; }
.rdm2-ext-empty { margin: 6px 8px; font-size: 12px; color: var(--rdm2-ink-3); }
.rdm2-ext-footer { margin-top: 4px; padding: 4px 4px 0; border-top: 1px solid var(--rdm2-line); display: flex; justify-content: flex-end; }

/* -------------------------------------------------------------- confirm */

.rdm2-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--rdm2-err) 42%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--rdm2-err) 6%, var(--rdm2-card));
}
.rdm2-confirm-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rdm2-confirm-title { font-size: 12.5px; line-height: 18px; font-weight: 500; color: var(--rdm2-ink); }
.rdm2-confirm-hint { font-size: 11.5px; line-height: 17px; color: var(--rdm2-ink-2); }
.rdm2-confirm-actions { display: flex; gap: 6px; flex: none; }
.rdm2-confirm-inline { margin: 0 14px 8px; }

/* -------------------------------------------------------------- feedback */

.rdm2-feedback {
  align-self: flex-start;
  padding: 4px 9px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--rdm2-ok) 9%, transparent);
  color: var(--rdm2-ok-text);
  font-size: 12px;
  line-height: 18px;
}

/* ---------------------------------------------------------------- ledger */

.rdm2-ledger-section { display: flex; flex-direction: column; gap: 10px; }
.rdm2-ledger { display: flex; flex-direction: column; gap: 20px; }
.rdm2-filter-chip {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 999px;
  background: var(--rdm2-card);
  color: var(--rdm2-ink-2);
  font-size: 11.5px;
  cursor: pointer;
}
.rdm2-filter-chip:hover { color: var(--rdm2-ink); background: var(--rdm2-hover); }
.rdm2-workspace { display: flex; flex-direction: column; }
.rdm2-ws-head {
  display: flex;
  align-items: baseline;
  gap: 6px 10px;
  flex-wrap: wrap;
  padding: 0 2px 7px;
  border-bottom: 1px solid var(--rdm2-line-2);
}
.rdm2-ws-title { font-size: 13px; line-height: 20px; font-weight: 600; color: var(--rdm2-ink); }
.rdm2-ws-path {
  font-family: var(--rdm2-code);
  font-size: 11px;
  line-height: 18px;
  color: var(--rdm2-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46ch;
}
.rdm2-ws-meta { margin-left: auto; font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }
.rdm2-session-group { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.rdm2-session-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px; }
.rdm2-session-title {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--rdm2-ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rdm2-session-head .rdm2-session-title::before {
  content: '';
  align-self: center;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--rdm2-ink-3);
  opacity: 0.7;
}
.rdm2-session-live {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--rdm2-live-text);
  background: var(--rdm2-live-soft);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.rdm2-session-meta { font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }

/* ---------------------------------------------------------------- record */

.rdm2-record-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--rdm2-line);
  border-radius: 12px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow);
  overflow: hidden;
}
.rdm2-record {
  border: 0;
  border-top: 1px solid var(--rdm2-line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  transition: background 0.15s ease;
}
.rdm2-record:first-child { border-top: 0; }
.rdm2-record:hover { background: var(--rdm2-hover); }
.rdm2-record[data-selected='true'] {
  background: color-mix(in srgb, var(--rdm2-live) 5%, var(--rdm2-card));
  box-shadow: inset 3px 0 0 var(--rdm2-live);
}
.rdm2-record-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 11px 14px 12px;
}
.rdm2-record-check { margin-top: 4px; }
.rdm2-record-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; cursor: pointer; }
.rdm2-record-name-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rdm2-record-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--rdm2-ink);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.rdm2-record-name:hover { text-decoration: underline; text-decoration-color: var(--rdm2-line-2); }
.rdm2-record-percent { flex: none; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--rdm2-ink); }
.rdm2-record-spacer { flex: 1 1 0; min-width: 0; }
.rdm2-record-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 11px;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ink-2);
}
.rdm2-meta-item { white-space: nowrap; }
.rdm2-meta-label { color: var(--rdm2-ink-3); margin-right: 4px; }
.rdm2-meta-rate { color: var(--rdm2-ink); font-weight: 500; }
.rdm2-status-word { color: var(--rdm2-ink-3); }
.rdm2-record-error { color: var(--rdm2-err-text); white-space: normal; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
.rdm2-record-host { color: var(--rdm2-ink-3); font-family: var(--rdm2-code); font-size: 11px; }
.rdm2-record-elapsed { color: var(--rdm2-ink-3); }
.rdm2-conn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px 1px 4px;
  border-radius: 999px;
  background: var(--rdm2-live-soft);
  color: var(--rdm2-live-text);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
.rdm2-id-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--rdm2-line);
  border-radius: 5px;
  background: transparent;
  color: var(--rdm2-ink-3);
  font-family: var(--rdm2-code);
  font-size: 10.5px;
  cursor: pointer;
}
.rdm2-id-chip:hover { color: var(--rdm2-ink); border-color: var(--rdm2-line-2); background: var(--rdm2-hover); }
.rdm2-record-actions { display: flex; align-items: center; gap: 2px; opacity: 0.72; transition: opacity 0.15s ease; }
.rdm2-record:hover .rdm2-record-actions, .rdm2-record:focus-within .rdm2-record-actions { opacity: 1; }
.rdm2-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--rdm2-ink-3);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.rdm2-icon-button:hover:not(:disabled) { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-icon-button[data-tone='danger']:hover:not(:disabled) { background: color-mix(in srgb, var(--rdm2-err) 10%, transparent); color: var(--rdm2-err-text); }
.rdm2-icon-button:disabled { opacity: 0.35; cursor: default; }
.rdm2-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 7px;
  background: var(--rdm2-card);
  color: var(--rdm2-ink-2);
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}
.rdm2-button:hover:not(:disabled) { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-button[data-tone='danger'] { color: var(--rdm2-err-text); }
.rdm2-button[data-tone='danger']:hover:not(:disabled) { background: color-mix(in srgb, var(--rdm2-err) 9%, transparent); }
.rdm2-button:disabled { opacity: 0.4; cursor: default; }
.rdm2-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1.5px solid color-mix(in srgb, var(--rdm2-ink-3) 60%, transparent);
  border-radius: 4px;
  background: transparent;
  color: var(--rdm2-base);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.rdm2-checkbox:hover { border-color: var(--rdm2-ink-2); }
.rdm2-checkbox:disabled { opacity: 0.45; cursor: default; }
.rdm2-checkbox[data-checked='true'] { background: var(--rdm2-live); border-color: var(--rdm2-live); }
.rdm2-checkbox-dash { width: 8px; height: 1.5px; border-radius: 1px; background: var(--rdm2-base); }
.rdm2-meter { height: 3px; border-radius: 2px; background: var(--rdm2-track); overflow: hidden; }
.rdm2-meter-fill { display: block; height: 100%; border-radius: 2px; background: var(--rdm2-live); transition: width 0.4s var(--ds-ease-in-out, ease); }
.rdm2-meter[data-tone='done'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-ok) 30%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='failed'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-err) 40%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='paused'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-warn) 34%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='idle'] .rdm2-meter-fill { background: var(--rdm2-ink-3); }

/* ------------------------------------------------------------- glyphs etc */

.rdm2-glyph { display: inline-flex; flex: none; width: 10px; height: 10px; }
.rdm2-glyph[data-tone='live'] { color: var(--rdm2-live); }
.rdm2-glyph[data-tone='done'] { color: var(--rdm2-ok-graphic); }
.rdm2-glyph[data-tone='failed'] { color: var(--rdm2-err-graphic); }
.rdm2-glyph[data-tone='paused'] { color: var(--rdm2-warn-graphic); }
.rdm2-glyph[data-tone='idle'] { color: var(--rdm2-ink-3); }
.rdm2-glyph-ring { fill: none; stroke: currentColor; stroke-width: 1; opacity: 0.45; }
.rdm2-glyph-core { fill: currentColor; }
.rdm2-glyph-stroke { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.rdm2-seal {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 4px;
  color: var(--rdm2-ink-2);
}
.rdm2-seal[data-state='verified'] svg { color: var(--rdm2-ok-graphic); }
.rdm2-seal[data-state='mismatch'] { color: var(--rdm2-err-text); border-color: color-mix(in srgb, var(--rdm2-err) 42%, transparent); }
.rdm2-seal[data-state='mismatch'] svg { color: var(--rdm2-err-graphic); }
.rdm2-seal-stroke { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.rdm2-seal-hash { font-family: var(--rdm2-code); font-size: 11px; line-height: 16px; }
.rdm2-confidence { display: inline-flex; align-items: center; margin-left: 6px; vertical-align: -1px; }
.rdm2-conf-on { fill: var(--rdm2-ink-2); }
.rdm2-conf-off { fill: var(--rdm2-ink-3); opacity: 0.35; }
.rdm2-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rdm2-chip {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--rdm2-ink-2);
  white-space: nowrap;
}
.rdm2-chip[data-tone='warn'] { color: var(--rdm2-warn-text); border-color: color-mix(in srgb, var(--rdm2-warn) 45%, transparent); }
.rdm2-chip[data-tone='error'] { color: var(--rdm2-err-text); border-color: color-mix(in srgb, var(--rdm2-err) 45%, transparent); }
.rdm2-chip-more { font-size: 11px; line-height: 16px; color: var(--rdm2-ink-3); }
.rdm2-note { margin: 0; padding: 4px 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-2); }
.rdm2-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* --------------------------------------------------------------- waveform */

.rdm2-wave { display: flex; flex-direction: column; min-width: 0; width: 100%; }
.rdm2-wave-plot { position: relative; flex: 1 1 auto; min-height: 0; }
.rdm2-wave-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.rdm2-wave-baseline { stroke: var(--rdm2-line-2); stroke-width: 1; vector-effect: non-scaling-stroke; }
.rdm2-wave-flat { stroke: var(--rdm2-ink-3); stroke-width: 1; opacity: 0.55; vector-effect: non-scaling-stroke; }
.rdm2-wave-area { fill: var(--rdm2-wave-fill); stroke: none; }
.rdm2-wave-line {
  fill: none;
  stroke: var(--rdm2-wave-line);
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.rdm2-wave-head {
  position: absolute;
  right: 0;
  width: 7px;
  height: 7px;
  margin-top: -3.5px;
  border-radius: 50%;
  background: var(--rdm2-live);
  box-shadow: 0 0 0 3px var(--rdm2-live-soft);
  transform: translate(50%, 0);
  animation: rdm2-head-pulse 2.4s ease-in-out infinite;
}
.rdm2-wave-labels {
  display: flex;
  justify-content: space-between;
  height: 16px;
  font-size: 11px;
  line-height: 16px;
  color: var(--rdm2-ink-3);
}
.rdm2-wave-label { font-variant-numeric: tabular-nums; }
.rdm2-session .rdm2-wave { gap: 2px; }
.rdm2-session .rdm2-wave-labels { display: none; }
@keyframes rdm2-head-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 3px var(--rdm2-live-soft); }
  50% { opacity: 0.72; box-shadow: 0 0 0 5px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
}

/* ---------------------------------------------------------------- drawer */

.rdm2-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 12px 12px;
  padding: 12px 14px 14px;
  border: 1px solid var(--rdm2-line);
  border-radius: 10px;
  background: var(--rdm2-wash);
  cursor: auto;
}
.rdm2-drawer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rdm2-copy-flash { font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); }
.rdm2-drawer-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--rdm2-err-text); }
.rdm2-drawer-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; align-items: start; }
.rdm2-drawer-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.rdm2-section { min-width: 0; }
.rdm2-section-title { margin: 0 0 4px; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--rdm2-ink); }
.rdm2-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 16px; margin: 0; }
.rdm2-fact { display: flex; flex-direction: column; min-width: 0; }
.rdm2-fact[data-wide='true'] { grid-column: 1 / -1; }
.rdm2-fact-label { margin: 0; font-size: 11.5px; line-height: 17px; color: var(--rdm2-ink-3); }
.rdm2-fact-value { margin: 0; min-width: 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-2); overflow-wrap: anywhere; }
.rdm2-mono { font-family: var(--rdm2-code); font-size: 11px; line-height: 17px; }
.rdm2-warning-line { margin: 0 0 4px; font-size: 12px; line-height: 18px; color: var(--rdm2-warn-text); overflow-wrap: anywhere; }
.rdm2-diagnosis { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rdm2-diagnosis-item { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; line-height: 18px; }
.rdm2-diagnosis-code { color: var(--rdm2-ink-2); }
.rdm2-diagnosis-message { color: var(--rdm2-ink-2); min-width: 0; overflow-wrap: anywhere; }
.rdm2-events { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
.rdm2-event { display: grid; grid-template-columns: 64px 88px minmax(0, 1fr); gap: 8px; font-size: 11.5px; line-height: 17px; color: var(--rdm2-ink-2); }
.rdm2-event-time, .rdm2-event-kind { color: var(--rdm2-ink-3); }
.rdm2-event-text { min-width: 0; overflow-wrap: anywhere; font-family: var(--rdm2-code); font-size: 11px; line-height: 17px; }
.rdm2-sources { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.rdm2-source { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11.5px; line-height: 17px; }
.rdm2-source-host { color: var(--rdm2-ink-2); min-width: 0; overflow-wrap: anywhere; }
.rdm2-source-meta { color: var(--rdm2-ink-3); }
.rdm2-source-error { color: var(--rdm2-err-text); min-width: 0; overflow-wrap: anywhere; }
.rdm2-source[data-state='bad'] .rdm2-source-host { color: var(--rdm2-err-text); }
.rdm2-note { margin: 0; padding: 4px 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-2); }
.rdm2-empty .rdm2-note { padding: 18px 16px; }

/* --------------------------------------------------------- skeleton/empty */

.rdm2-skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  border: 1px solid var(--rdm2-line);
  border-radius: 12px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow);
  overflow: hidden;
}
.rdm2-skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-top: 1px solid var(--rdm2-line);
}
.rdm2-skeleton-card:first-child { border-top: 0; }
.rdm2-skeleton { display: block; height: 10px; border-radius: 4px; background: var(--rdm2-skeleton); }
.rdm2-skeleton-name { width: 38%; height: 13px; }
.rdm2-skeleton-meta { width: 62%; height: 10px; }
.rdm2-skeleton-meter { width: 100%; height: 3px; }
.rdm2-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 40px 20px;
  border: 1px dashed var(--rdm2-line-2);
  border-radius: 14px;
  background: color-mix(in srgb, var(--rdm2-card) 70%, transparent);
  text-align: center;
}
.rdm2-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border-radius: 12px;
  background: var(--rdm2-live-soft);
  color: var(--rdm2-live-text);
}
.rdm2-empty-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--rdm2-ink); }
.rdm2-empty-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-3); max-width: 46ch; }
.rdm2-empty-action { display: flex; justify-content: center; margin-top: 8px; }

/* ---------------------------------------------------------------- session */

.rdm2-session { box-sizing: border-box; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; background: var(--rdm2-base); }
.rdm2-session-header { position: sticky; top: 0; z-index: 2; padding: 12px 14px 10px; background: var(--rdm2-base); border-bottom: 1px solid var(--rdm2-line); }
.rdm2-session-title-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rdm2-session-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--rdm2-ink); }
.rdm2-session-sub { display: flex; gap: 12px; font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }
.rdm2-session-body { display: flex; flex-direction: column; gap: 0; padding: 0 14px 24px; }
.rdm2-session .rdm2-record { border: 0; border-top: 1px solid var(--rdm2-line); border-radius: 0; box-shadow: none; background: transparent; }
.rdm2-session .rdm2-record:first-child { border-top: 0; }
.rdm2-session .rdm2-record:hover { border-color: var(--rdm2-line); box-shadow: none; }
.rdm2-session .rdm2-record-row {
  position: relative;
  display: block;
  padding: 11px 0 12px;
}
.rdm2-session .rdm2-record-actions {
  position: absolute;
  top: 5px;
  right: 0;
}
.rdm2-session .rdm2-record-name-line { padding-right: 116px; }
.rdm2-session .rdm2-seal-hash { display: none; }
.rdm2-session .rdm2-record-meta { padding-right: 0; }
.rdm2-session .rdm2-record-actions { opacity: 1; }
.rdm2-session .rdm2-checkbox { display: none; }
.rdm2-session .rdm2-drawer { margin: 0 0 12px; background: transparent; }
.rdm2-session .rdm2-drawer-cols { grid-template-columns: 1fr; gap: 12px; }
.rdm2-session .rdm2-event { grid-template-columns: 56px minmax(0, 1fr); }
.rdm2-session .rdm2-event-kind { display: none; }
.rdm2-session .rdm2-banner { margin: 8px 14px 0; }
.rdm2-session .rdm2-note { padding: 14px 0; }
.rdm2-session .rdm2-skeleton-list { padding-top: 6px; }
.rdm2-session .rdm2-skeleton-card { padding: 10px 0; border: 0; border-top: 1px solid var(--rdm2-line); border-radius: 0; background: transparent; }
.rdm2-tab-title { display: inline-flex; align-items: center; gap: 6px; }
.rdm2-confirm-inline { margin: 8px 14px; }

/* ------------------------------------------------------------------ popup */

.rdm2-pop {
  position: fixed;
  top: calc(14px + var(--dsh-frame-top-clearance, 0px));
  right: 16px;
  z-index: 60;
  width: 300px;
  max-width: calc(100vw - 24px);
  pointer-events: auto;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 14px;
  background: var(--rdm2-card);
  box-shadow: var(--rdm2-shadow-lift);
  overflow: hidden;
  animation: rdm2-pop-in 0.18s var(--ds-ease-in-out, ease);
}
.rdm2-pop-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 10px 10px 12px;
  border-bottom: 1px solid var(--rdm2-line);
}
.rdm2-pop-live-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--rdm2-live);
  box-shadow: 0 0 0 3px var(--rdm2-live-soft);
  animation: rdm2-pop-pulse 2.4s ease-in-out infinite;
}
.rdm2-pop-title { font-size: 12.5px; line-height: 18px; font-weight: 600; color: var(--rdm2-ink); white-space: nowrap; }
.rdm2-pop-summary { margin-left: auto; font-size: 11px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rdm2-pop-collapse { flex: none; width: 24px; height: 24px; }
.rdm2-pop-collapse svg { transform: rotate(180deg); }
.rdm2-pop-rows { display: flex; flex-direction: column; gap: 2px; padding: 6px; max-height: 50vh; overflow: auto; }
.rdm2-pop-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.rdm2-pop-row:hover { background: var(--rdm2-hover); }
.rdm2-pop-row-top { display: flex; align-items: baseline; gap: 8px; }
.rdm2-pop-session { flex: 1 1 auto; min-width: 0; font-size: 12.5px; line-height: 18px; font-weight: 500; color: var(--rdm2-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rdm2-pop-percent { flex: none; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--rdm2-ink); }
.rdm2-pop-meter { display: block; height: 3px; border-radius: 2px; background: var(--rdm2-track); overflow: hidden; }
.rdm2-pop-meter-fill { display: block; height: 100%; border-radius: 2px; background: var(--rdm2-live); transition: width 0.4s var(--ds-ease-in-out, ease); }
.rdm2-pop-row-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; line-height: 16px; color: var(--rdm2-ink-3); }
.rdm2-pop-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--rdm2-line); }
.rdm2-pop-open {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--rdm2-live-text);
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}
.rdm2-pop-open:hover { text-decoration: underline; }
.rdm2-pop-open-quiet {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--rdm2-ink-3);
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}
.rdm2-pop-open-quiet:hover { color: var(--rdm2-ink-2); }
.rdm2-pop[data-collapsed='true'] { width: auto; border-radius: 999px; }
.rdm2-pop-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border: 0;
  background: var(--rdm2-card);
  color: var(--rdm2-ink);
  font-size: 12px;
  cursor: pointer;
}
.rdm2-pop-pill-text { white-space: nowrap; }
.rdm2-pop-pill-chevron { display: inline-flex; color: var(--rdm2-ink-3); }
@keyframes rdm2-pop-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes rdm2-pop-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* ---------------------------------------------------------------- motion */

@media (prefers-reduced-motion: reduce) {
  .rdm2, .rdm2 *, .rdm2 *::before, .rdm2 *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

/* ------------------------------------------------------------- responsive */

@media (max-width: 900px) {
  .rdm2-page-inner { padding: 22px 20px 44px; }
}
@media (max-width: 760px) {
  .rdm2-page-inner { padding: 18px 16px 40px; gap: 15px; }
  .rdm2-page-header { align-items: flex-start; }
  .rdm2-record-actions { opacity: 1; }
  .rdm2-record-row { grid-template-columns: auto minmax(0, 1fr); }
  .rdm2-record-actions { grid-column: 1 / -1; justify-content: flex-end; padding-top: 2px; opacity: 1; }
  .rdm2-record-check { margin-top: 3px; }
  .rdm2-toolbar { align-items: stretch; }
  .rdm2-toolbar-start, .rdm2-toolbar-end { width: 100%; }
  .rdm2-toolbar-end { justify-content: flex-end; }
  .rdm2-search { flex: 1 1 auto; }
  .rdm2-search input { width: 100%; max-width: none; }
  .rdm2-drawer-cols { grid-template-columns: 1fr; }
  .rdm2-record-host { display: none; }
  .rdm2-event { grid-template-columns: 56px 76px minmax(0, 1fr); }
  .rdm2-pop { right: 12px; }
}
@media (max-width: 560px) {
  .rdm2-page-inner { padding: 14px 12px 32px; }
  .rdm2-cards { gap: 8px; }
  .rdm2-stat { padding: 11px 12px 10px; border-radius: 12px; }
  .rdm2-stat-value { font-size: 26px; line-height: 32px; margin-top: 4px; }
  .rdm2-stat-icon { width: 26px; height: 26px; border-radius: 8px; }
  .rdm2-stat-label { font-size: 12px; }
  .rdm2-stat-hint { font-size: 10.5px; line-height: 15px; -webkit-line-clamp: 2; }
  .rdm2-composer-submit { padding: 0 11px; }
  .rdm2-record-meta { gap: 2px 9px; }
  .rdm2-record-size, .rdm2-record-elapsed { display: none; }
  .rdm2-ws-path { max-width: 100%; flex-basis: 100%; }
  .rdm2-empty-state { padding: 30px 16px; }
  .rdm2-pop { width: calc(100vw - 24px); }
}
@media (max-width: 400px) {
  .rdm2-seal-hash { display: none; }
  .rdm2-seal { padding: 0 4px; }
  .rdm2-toolbar-start { gap: 6px; }
}
`.trim()

/** Marker attribute for the one style element both surfaces render. */
export const STYLE_ATTR = 'data-rdm2-styles'
