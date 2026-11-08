// Styles for both review surfaces (global page + session right-sidebar tab).
//
// One token block on `.rdm2` maps host theme tokens to the two surfaces' local
// names; every rule below consumes those locals. There are no literal colours
// anywhere in this file — dark/light parity comes entirely from the host
// palette, and the only `color-mix()` uses are ink/state blends (the 0.1.x
// pattern for quiet history rails and readable state text).
//
// Type rules from .design/DESIGN.md §4 carry over: host UI stack, tabular
// numerals, code font only for literal values (paths, URLs, hashes, hosts,
// event log). No all-caps, no letter-spaced labels, no monospace micro-labels.
//
// The file is rendered by each surface as one keyed <style> element, so
// unloading the surface removes it. Global page = `.rdm2-page`; session tab =
// `.rdm2-session`; shared primitives live under `.rdm2`.

export const REVIEW_CSS = `
.rdm2 {
  --rdm2-base: var(--dsw-alias-bg-base);
  --rdm2-surface: var(--dsw-alias-bg-layer-1);
  --rdm2-wash: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2));
  --rdm2-ink: var(--dsw-alias-label-primary);
  --rdm2-ink-2: var(--dsw-alias-label-secondary);
  --rdm2-ink-3: color-mix(in srgb, var(--dsw-alias-label-tertiary) 82%, var(--dsw-alias-label-primary));
  --rdm2-line: var(--dsw-alias-border-l1);
  --rdm2-line-2: var(--dsw-alias-border-l2);
  --rdm2-signal: var(--dsw-alias-state-business-primary);
  --rdm2-ok: var(--dsw-alias-state-success-primary);
  --rdm2-warn: var(--dsw-alias-state-warn-primary);
  --rdm2-err: var(--dsw-alias-state-error-primary);
  /* Non-text status marks (glyphs, seal strokes, live meter fill). §6.5 asks
     for >= 3:1 against the surface; the raw success/warn hues only reach
     2.28:1 and 2.15:1 on the light surface, so light mode mixes them toward
     ink. Dark mode restores the raw tokens below (all >= 4.7:1 there). */
  --rdm2-graphic-ok: color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-label-primary));
  --rdm2-graphic-warn: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 75%, var(--dsw-alias-label-primary));
  --rdm2-graphic-err: var(--dsw-alias-state-error-primary);
  --rdm2-graphic-live: var(--dsw-alias-state-business-primary);
  --rdm2-ok-text: color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, var(--dsw-alias-label-primary));
  --rdm2-warn-text: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, var(--dsw-alias-label-primary));
  --rdm2-err-text: color-mix(in srgb, var(--dsw-alias-state-error-primary) 86%, var(--dsw-alias-label-primary));
  --rdm2-hover: var(--dsw-alias-interactive-bg-hover);
  --rdm2-skeleton: var(--dsw-alias-bg-skeleton, color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent));
  --rdm2-focus: color-mix(in srgb, var(--dsw-alias-state-business-primary) 70%, var(--dsw-alias-label-primary));
  --rdm2-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  --rdm2-wave-fill: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  --rdm2-wave-line: color-mix(in srgb, var(--dsw-alias-state-business-primary) 78%, var(--dsw-alias-label-primary));
  --rdm2-track: color-mix(in srgb, var(--dsw-alias-label-tertiary) 18%, transparent);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  color: var(--rdm2-ink);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
[data-ds-dark-theme] .rdm2 {
  /* Dark mode keeps the host's state hues for non-text marks; these overrides
     only undo the light-mode ink mixes above. */
  --rdm2-graphic-ok: var(--dsw-alias-state-success-primary);
  --rdm2-graphic-warn: var(--dsw-alias-state-warn-primary);
  --rdm2-graphic-err: var(--dsw-alias-state-error-primary);
  --rdm2-graphic-live: var(--dsw-alias-state-business-primary);
}

/* ------------------------------------------------------------------ page */

.rdm2-page {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 24px clamp(20px, 3vw, 40px) 48px;
  background: var(--rdm2-base);
}
[data-platform='darwin'] .rdm2-page {
  /* Desktop macOS: clear the hiddenInset traffic lights like the host pages. */
  padding-top: calc(24px + var(--dsh-frame-top-clearance, 0px));
}
.rdm2-page-header {
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 24px;
}
.rdm2-page-title-block { min-width: 0; }
.rdm2-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: var(--rdm2-ink); }
.rdm2-engine {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ink-3);
  overflow-wrap: anywhere;
}
.rdm2-stats {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.rdm2-counts { color: var(--rdm2-ink-2); }
.rdm2-rates { color: var(--rdm2-ink-3); }

/* -------------------------------------------------------------- recorder */

.rdm2-recorder {
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  border: 1px solid var(--rdm2-line);
  border-radius: 8px;
  background: var(--rdm2-surface);
  padding: 10px 12px 6px;
}
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
  background: var(--rdm2-graphic-live);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);
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
.rdm2-recorder-note { margin: 2px 0 0; font-size: 11px; line-height: 16px; color: var(--rdm2-ink-3); }
@keyframes rdm2-head-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }
  50% { opacity: 0.72; box-shadow: 0 0 0 5px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
}

/* ------------------------------------------------------------------ risk */

.rdm2-risk {
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 18px;
}
.rdm2-risk-summary { display: none; }
.rdm2-risk-rows { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rdm2-risk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--rdm2-warn-text);
}
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
@media (max-width: 600px) {
  .rdm2-risk-summary {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 12px;
    line-height: 18px;
    color: var(--rdm2-warn-text);
    cursor: pointer;
  }
  .rdm2-risk[data-expanded='false'] .rdm2-risk-rows { display: none; }
  .rdm2-risk-rows { padding-top: 2px; }
  .rdm2-risk-row { flex-wrap: wrap; align-items: baseline; }
  .rdm2-risk-name { max-width: 100%; white-space: normal; }
  .rdm2-risk-cause { white-space: normal; }
}
.rdm2-risk-summary-dot { font-size: 12px; line-height: 12px; }

/* ---------------------------------------------------------------- banner */

.rdm2-banner {
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--rdm2-surface));
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 18px;
}
.rdm2-banner-title { color: var(--rdm2-ink); font-weight: 500; }
.rdm2-banner-hint { color: var(--rdm2-ink-2); }

/* ---------------------------------------------------------------- ledger */

.rdm2-ledger-section { box-sizing: border-box; width: 100%; max-width: 960px; }
.rdm2-ledger {
  border: 1px solid var(--rdm2-line-2);
  border-radius: 8px;
  background: var(--rdm2-surface);
  overflow: hidden;
}
.rdm2-empty { display: block; }
.rdm2-group + .rdm2-group { border-top: 1px solid var(--rdm2-line-2); }
.rdm2-group-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px 16px;
  padding: 8px 14px 6px;
  background: var(--rdm2-wash);
  border-bottom: 1px solid var(--rdm2-line);
}
.rdm2-group-title { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--rdm2-ink-2); }
.rdm2-group-meta { font-size: 12px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }

/* ---------------------------------------------------------------- record */

.rdm2-record { border-top: 1px solid var(--rdm2-line); }
.rdm2-group-head + .rdm2-record { border-top: 0; }
.rdm2-record-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 12px;
  cursor: pointer;
  text-align: left;
  color: inherit;
}
.rdm2-record-main:hover { background: var(--rdm2-hover); }
.rdm2-record-main:focus-visible { outline: 2px solid var(--rdm2-focus); outline-offset: -2px; }
.rdm2-record-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rdm2-record-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--rdm2-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rdm2-record-percent {
  flex: none;
  margin-left: auto;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--rdm2-ink);
}
.rdm2-record-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 14px;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ink-2);
}
.rdm2-meta-item { white-space: nowrap; }
.rdm2-meta-label { color: var(--rdm2-ink-3); margin-right: 4px; }
.rdm2-meta-rate { color: var(--rdm2-ink); font-weight: 500; }
.rdm2-status-word { color: var(--rdm2-ink-3); }
.rdm2-record-error { color: var(--rdm2-err-text); white-space: normal; }
.rdm2-record-host { color: var(--rdm2-ink-3); font-family: var(--rdm2-code); font-size: 11.5px; }
.rdm2-record-elapsed { color: var(--rdm2-ink-3); }
.rdm2-record-spacer { flex: 1 1 0; min-width: 0; }

/* ------------------------------------------------------------- glyphs etc */

.rdm2-glyph { display: inline-flex; flex: none; width: 10px; height: 10px; }
.rdm2-glyph[data-tone='live'] { color: var(--rdm2-graphic-live); }
.rdm2-glyph[data-tone='done'] { color: var(--rdm2-graphic-ok); }
.rdm2-glyph[data-tone='failed'] { color: var(--rdm2-graphic-err); }
.rdm2-glyph[data-tone='paused'] { color: var(--rdm2-graphic-warn); }
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
.rdm2-seal[data-state='verified'] svg { color: var(--rdm2-graphic-ok); }
.rdm2-seal[data-state='mismatch'] { color: var(--rdm2-err-text); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent); }
.rdm2-seal[data-state='mismatch'] svg { color: var(--rdm2-graphic-err); }
.rdm2-seal-stroke { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.rdm2-seal-hash { font-family: var(--rdm2-code); font-size: 11px; line-height: 16px; }

.rdm2-meter { height: 2px; border-radius: 1px; background: var(--rdm2-track); overflow: hidden; }
.rdm2-meter-fill { display: block; height: 100%; background: var(--rdm2-graphic-live); transition: width 0.4s var(--ds-ease-in-out, ease); }
.rdm2-meter[data-tone='done'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-ok) 22%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='failed'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-err) 36%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='paused'] .rdm2-meter-fill { background: color-mix(in srgb, var(--rdm2-warn) 30%, var(--rdm2-ink-3)); }
.rdm2-meter[data-tone='idle'] .rdm2-meter-fill { background: var(--rdm2-ink-3); }
.rdm2-session .rdm2-meter { display: none; }

.rdm2-confidence { display: inline-flex; align-items: center; margin-left: 6px; vertical-align: -1px; }
.rdm2-conf-on { fill: var(--rdm2-ink-2); }
.rdm2-conf-off { fill: var(--rdm2-ink-3); opacity: 0.35; }

/* ---------------------------------------------------------------- chips */

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
.rdm2-chip[data-tone='warn'] {
  color: var(--rdm2-warn-text);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent);
}
.rdm2-chip[data-tone='error'] {
  color: var(--rdm2-err-text);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
}
.rdm2-chip-more { font-size: 11px; line-height: 16px; color: var(--rdm2-ink-3); }

/* --------------------------------------------------------------- drawer */

.rdm2-drawer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 16px;
  background: var(--rdm2-wash);
  border-top: 1px solid var(--rdm2-line-2);
  cursor: auto;
}
.rdm2-drawer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.rdm2-copy-flash { font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); }
.rdm2-button {
  appearance: none;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 4px;
  background: var(--rdm2-surface);
  color: var(--rdm2-ink-2);
  font: inherit;
  font-size: 11.5px;
  line-height: 18px;
  padding: 1px 8px;
  cursor: pointer;
}
.rdm2-button:hover { background: var(--rdm2-hover); color: var(--rdm2-ink); }
.rdm2-button:focus-visible { outline: 2px solid var(--rdm2-focus); outline-offset: 2px; }
.rdm2-button[data-tone='danger'] { color: var(--rdm2-err-text); }
.rdm2-button[data-confirm='true'] {
  border-color: var(--rdm2-err);
  color: var(--rdm2-err-text);
}
.rdm2-drawer-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-err-text);
}
.rdm2-drawer-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 28px;
  align-items: start;
}
.rdm2-drawer-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rdm2-section { min-width: 0; }
.rdm2-section-title {
  margin: 0 0 3px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--rdm2-ink);
}
.rdm2-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px 16px;
  margin: 0;
}
.rdm2-fact { display: flex; flex-direction: column; min-width: 0; }
.rdm2-fact[data-wide='true'] { grid-column: 1 / -1; }
.rdm2-fact-label { margin: 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-3); }
.rdm2-fact-value {
  margin: 0;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ink-2);
  overflow-wrap: anywhere;
}
.rdm2-mono { font-family: var(--rdm2-code); font-size: 11.5px; line-height: 17px; }
.rdm2-warning-line { margin: 0 0 4px; font-size: 12px; line-height: 18px; color: var(--rdm2-warn-text); overflow-wrap: anywhere; }
.rdm2-diagnosis { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rdm2-diagnosis-item { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 12px; line-height: 18px; }
.rdm2-diagnosis-code { color: var(--rdm2-ink-2); }
.rdm2-diagnosis-message { color: var(--rdm2-ink-2); min-width: 0; overflow-wrap: anywhere; }
.rdm2-events {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rdm2-event {
  display: grid;
  grid-template-columns: 64px 88px minmax(0, 1fr);
  gap: 8px;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--rdm2-ink-2);
}
.rdm2-event-time, .rdm2-event-kind { color: var(--rdm2-ink-3); }
.rdm2-event-text { min-width: 0; overflow-wrap: anywhere; font-family: var(--rdm2-code); font-size: 11.5px; line-height: 17px; }
.rdm2-note { margin: 0; padding: 4px 0; font-size: 12px; line-height: 18px; color: var(--rdm2-ink-2); }
.rdm2-empty .rdm2-note { padding: 18px 16px; }
.rdm2-footnote {
  box-sizing: border-box;
  width: 100%;
  max-width: 960px;
  margin: 0;
  font-size: 11.5px;
  line-height: 17px;
  color: var(--rdm2-ink-3);
}

/* -------------------------------------------------------------- skeleton */

.rdm2-skeleton-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 14px;
  border: 1px solid var(--rdm2-line-2);
  border-radius: 8px;
  background: var(--rdm2-surface);
}
.rdm2-skeleton-row { display: flex; flex-direction: column; gap: 7px; }
.rdm2-skeleton { display: block; height: 10px; border-radius: 3px; background: var(--rdm2-skeleton); }
.rdm2-skeleton-name { width: 42%; height: 12px; }
.rdm2-skeleton-meter { width: 100%; height: 2px; }
.rdm2-skeleton-meta { width: 64%; height: 10px; }

/* -------------------------------------------------------------- session */

.rdm2-session {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  background: var(--rdm2-base);
}
.rdm2-session-header {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 12px 16px 10px;
  background: var(--rdm2-base);
  border-bottom: 1px solid var(--rdm2-line);
}
.rdm2-session-title-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rdm2-session-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--rdm2-ink); }
.rdm2-session-counts { display: flex; gap: 10px; font-size: 11.5px; line-height: 18px; color: var(--rdm2-ink-3); white-space: nowrap; }
.rdm2-session-risk { color: var(--rdm2-warn-text); }
.rdm2-session-sub {
  display: flex;
  gap: 14px;
  margin-top: 1px;
  font-size: 12px;
  line-height: 18px;
  color: var(--rdm2-ink-3);
}
.rdm2-session-body { display: flex; flex-direction: column; padding: 0 16px 24px; }
.rdm2-session .rdm2-record:first-child { border-top: 0; }
.rdm2-session .rdm2-record-main { padding: 10px 0 12px; gap: 5px; }
.rdm2-session .rdm2-record-main:hover { background: transparent; }
.rdm2-session .rdm2-record-main:hover .rdm2-record-name { text-decoration: underline; text-decoration-color: var(--rdm2-line-2); }
.rdm2-session .rdm2-drawer { padding: 10px 0 14px; background: transparent; border-top: 0; }
.rdm2-session .rdm2-drawer-cols { grid-template-columns: 1fr; gap: 10px; }
.rdm2-session .rdm2-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.rdm2-session .rdm2-event { grid-template-columns: 56px minmax(0, 1fr); }
.rdm2-session .rdm2-event-kind { display: none; }
.rdm2-session .rdm2-wave-labels { display: none; }
.rdm2-session .rdm2-wave { gap: 4px; }
.rdm2-session .rdm2-note { padding: 14px 0; }
.rdm2-session .rdm2-banner { max-width: none; margin: 10px 16px 0; }
.rdm2-session-loading { padding-top: 4px; }
.rdm2-session-loading .rdm2-skeleton-list { border: 0; border-radius: 0; padding: 8px 0; background: transparent; }
.rdm2-session .rdm2-record-main:focus-visible { outline-offset: 0; }
.rdm2-tab-title { display: inline-flex; align-items: center; gap: 6px; }

/* -------------------------------------------------------------- motion */

@media (prefers-reduced-motion: reduce) {
  .rdm2, .rdm2 *, .rdm2 *::before, .rdm2 *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

/* ---------------------------------------------------------- responsive */

@media (max-width: 760px) {
  .rdm2-page { padding: 18px 16px 40px; gap: 13px; }
  .rdm2-page-header { flex-direction: column; align-items: stretch; }
  .rdm2-stats { align-items: flex-start; }
  .rdm2-drawer-cols { grid-template-columns: 1fr; }
  .rdm2-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rdm2-record-host { display: none; }
  .rdm2-event { grid-template-columns: 56px 76px minmax(0, 1fr); }
}
@media (max-width: 480px) {
  .rdm2-page { padding: 14px 12px 32px; }
  .rdm2-record-main { padding: 9px 12px 11px; }
  .rdm2-record-size { display: none; }
  .rdm2-record-meta { gap: 2px 10px; }
  .rdm2-facts { grid-template-columns: 1fr; }
  .rdm2-event { grid-template-columns: 52px minmax(0, 1fr); }
  .rdm2-event-kind { display: none; }
  .rdm2-ledger { border-radius: 6px; }
}
@media (max-width: 400px) {
  .rdm2-seal-hash { display: none; }
  .rdm2-seal { padding: 0 4px; }
}
`.trim()

/** Marker attribute for the one style element both surfaces render. */
export const STYLE_ATTR = 'data-rdm2-styles'
