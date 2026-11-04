// Component-local styles for the RDM panel. Rendered as a keyed <style> React
// element so unmounting the panel removes them. Colors come only from host theme
// tokens (--dsw-*, --dsh-*, --ds-*); literal colors never appear here.
//
// Layout vocabulary: a page, a start composer, and one ledger surface whose
// rows are divided by hairlines. The row rail is split into connection lanes —
// the panel's signature element — and is the only place motion lives.

export const PANEL_CSS = `
.rdm-panel {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 24px clamp(20px, 3vw, 40px) 48px;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);

  --rdm-ink: var(--dsw-alias-label-primary);
  --rdm-ink-2: var(--dsw-alias-label-secondary);
  --rdm-ink-3: color-mix(in srgb, var(--dsw-alias-label-tertiary) 78%, var(--dsw-alias-label-primary));
  --rdm-line: var(--dsw-alias-border-l1);
  --rdm-line-strong: var(--dsw-alias-border-l2);
  --rdm-surface: var(--dsw-alias-bg-layer-1);
  --rdm-wash: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-2));
  --rdm-hover: var(--dsw-alias-interactive-bg-hover);
  --rdm-signal: var(--dsw-alias-state-business-primary);
  --rdm-ok: color-mix(in srgb, var(--dsw-alias-state-success-primary) 74%, var(--dsw-alias-label-primary));
  --rdm-warn: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 78%, var(--dsw-alias-label-primary));
  --rdm-err: var(--dsw-alias-state-error-primary);
  --rdm-idle: var(--dsw-alias-state-idle-primary);
  --rdm-track: color-mix(in srgb, var(--dsw-alias-label-secondary) 15%, transparent);
  --rdm-ok-quiet: color-mix(in srgb, var(--rdm-ok) 58%, var(--rdm-ink-3));
  --rdm-err-quiet: color-mix(in srgb, var(--rdm-err) 62%, var(--rdm-ink-3));
  --rdm-err-text: color-mix(in srgb, var(--dsw-alias-state-error-primary) 88%, var(--dsw-alias-label-primary));
  --rdm-signal-text: color-mix(in srgb, var(--dsw-alias-state-business-primary) 75%, var(--dsw-alias-label-primary));
  --rdm-focus: color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, var(--dsw-alias-label-primary));
  --rdm-code: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}
[data-platform='darwin'] .rdm-panel {
  /* Desktop macOS: clear the hiddenInset traffic lights like the host entry pages. */
  padding-top: calc(24px + var(--dsh-frame-top-clearance, 0px));
}
.rdm-header,
.rdm-alert,
.rdm-composer,
.rdm-section {
  box-sizing: border-box;
  width: 100%;
  max-width: 920px;
}
.rdm-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Header: page title + a plain engine status line (no chrome chip). */
.rdm-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 20px;
}
.rdm-headline { min-width: 0; }
.rdm-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.rdm-sub {
  margin: 4px 0 0;
  max-width: 62ch;
  color: var(--rdm-ink-2);
  font-size: 13px;
  line-height: 20px;
}
.rdm-kernel {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  padding-top: 5px;
  color: var(--rdm-ink-2);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.rdm-kernel-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rdm-idle);
}
.rdm-kernel[data-tone='ok'] .rdm-kernel-dot { background: var(--rdm-ok); }
.rdm-kernel[data-tone='warn'] .rdm-kernel-dot { background: var(--rdm-warn); }
.rdm-kernel[data-tone='error'] .rdm-kernel-dot { background: var(--rdm-err); }
.rdm-kernel-meta { color: var(--rdm-ink-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* Route error: direction, not mood. */
.rdm-alert {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border: 0.5px solid color-mix(in srgb, var(--rdm-err) 42%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--rdm-err) 7%, transparent);
  font-size: 12px;
  line-height: 18px;
}
.rdm-alert-body { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.rdm-alert-title { color: var(--rdm-err-text); font-weight: 500; }
.rdm-alert-text { color: var(--rdm-ink-2); overflow-wrap: anywhere; }
.rdm-alert-hint { color: var(--rdm-ink-3); }
.rdm-alert .rdm-btn { flex: none; }

/* Start composer: one calm bar; options stay out of the way until asked for. */
.rdm-composer { display: flex; flex-direction: column; gap: 8px; }
.rdm-composer-row {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  padding: 5px 5px 5px 10px;
  border: 0.5px solid var(--rdm-line-strong);
  border-radius: 12px;
  background: var(--rdm-wash);
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.rdm-composer-row:focus-within {
  border-color: color-mix(in srgb, var(--rdm-signal) 55%, var(--rdm-line-strong));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--rdm-signal) 13%, transparent);
}
.rdm-url-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 4px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--rdm-ink);
  font: inherit;
  font-size: 13px;
}
.rdm-url-input::placeholder { color: var(--rdm-ink-3); }
.rdm-url-input:focus-visible { outline: none; }
.rdm-url-input:disabled { opacity: 0.6; }
.rdm-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 12px;
  padding: 2px 2px 0;
}
.rdm-field { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.rdm-field-label { color: var(--rdm-ink-3); font-size: 12px; line-height: 18px; }
.rdm-input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--rdm-line-strong);
  border-radius: 8px;
  background: var(--rdm-surface);
  color: var(--rdm-ink);
  font: inherit;
  font-size: 12.5px;
}
.rdm-input::placeholder { color: var(--rdm-ink-3); }
.rdm-input:disabled { opacity: 0.6; }
.rdm-input:focus-visible {
  outline: 2px solid var(--rdm-focus);
  outline-offset: 1px;
}
.rdm-composer[data-invalid='true'] .rdm-composer-row {
  border-color: color-mix(in srgb, var(--rdm-err) 60%, var(--rdm-line-strong));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--rdm-err) 10%, transparent);
}
.rdm-form-error { margin: 0 2px; color: var(--rdm-err-text); font-size: 12px; line-height: 18px; }

/* Buttons: quiet by default, one primary per page. */
.rdm-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  margin: 0;
  padding: 0 10px;
  border: 0.5px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--rdm-ink-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.rdm-btn:hover:not(:disabled) { background: var(--rdm-hover); color: var(--rdm-ink); }
.rdm-btn:disabled { opacity: 0.4; cursor: default; }
.rdm-btn:focus-visible {
  outline: 2px solid var(--rdm-focus);
  outline-offset: 2px;
}
.rdm-btn--icon {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--rdm-ink-2);
}
.rdm-btn--icon:hover:not(:disabled) { color: var(--rdm-ink); }
.rdm-btn--ghost { height: 30px; color: var(--rdm-ink-2); }
.rdm-btn--primary {
  height: 34px;
  padding: 0 14px;
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.rdm-btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill));
  color: var(--dsw-alias-label-primary-foreground);
}
.rdm-start { flex: none; }
.rdm-icon { display: block; width: 14px; height: 14px; flex: none; }
.rdm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  flex: none;
  border: 1.5px solid color-mix(in srgb, var(--rdm-signal) 28%, transparent);
  border-top-color: var(--rdm-signal);
  border-radius: 50%;
  animation: rdm-spin 0.7s linear infinite;
}
@keyframes rdm-spin { to { transform: rotate(360deg); } }

/* Section head: title, filters, live aggregate. */
.rdm-section { display: flex; flex-direction: column; gap: 10px; }
.rdm-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.rdm-section-title {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.rdm-count { color: var(--rdm-ink-3); font-weight: 500; font-variant-numeric: tabular-nums; }
.rdm-filters {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--rdm-ink-2) 7%, transparent);
}
.rdm-filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--rdm-ink-2);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.rdm-filter:hover { color: var(--rdm-ink); }
.rdm-filter[aria-pressed='true'] {
  background: var(--rdm-surface);
  color: var(--rdm-ink);
  box-shadow: 0 0 0 0.5px var(--rdm-line-strong);
}
.rdm-filter:focus-visible {
  outline: 2px solid var(--rdm-focus);
  outline-offset: 1px;
}
.rdm-filter-count { color: var(--rdm-ink-3); font-variant-numeric: tabular-nums; }
.rdm-filter[aria-pressed='true'] .rdm-filter-count { color: var(--rdm-ink-2); }
.rdm-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  margin-left: auto;
  color: var(--rdm-ink-2);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.rdm-summary-speed { color: var(--rdm-ink); font-weight: 500; font-variant-numeric: tabular-nums; }
.rdm-summary-group { display: inline-flex; align-items: baseline; gap: 10px; }
.rdm-summary-failed { color: var(--rdm-err-text); }

/* Ledger surface. One border, hairline rows — not one card per download. */
.rdm-board {
  box-sizing: border-box;
  border: 0.5px solid var(--rdm-line-strong);
  border-radius: 16px;
  background: var(--rdm-surface);
}
.rdm-filter-empty { margin: 0; padding: 28px 16px; color: var(--rdm-ink-3); font-size: 12.5px; line-height: 19px; text-align: center; }

/* Empty state: the same lane vocabulary, at rest. */
.rdm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 52px 24px 48px;
  text-align: center;
}
.rdm-empty-meter { display: flex; flex-direction: column; gap: 5px; width: 168px; margin-bottom: 8px; }
.rdm-empty-lanes { display: flex; gap: 2px; height: 9px; }
.rdm-empty-lanes span { display: block; flex: 1; border-radius: 1px; background: var(--rdm-track); }
.rdm-empty-lanes span[data-lit='true'] {
  background: color-mix(in srgb, var(--rdm-signal) 42%, var(--rdm-track));
}
.rdm-empty-rail { position: relative; height: 5px; overflow: hidden; border-radius: 3px; background: var(--rdm-track); }
.rdm-empty-rail-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 28%;
  border-radius: 3px;
  background: color-mix(in srgb, var(--rdm-signal) 42%, var(--rdm-track));
}
.rdm-empty-title { margin: 0; color: var(--rdm-ink); font-size: 14px; font-weight: 500; line-height: 22px; }
.rdm-empty-desc {
  margin: 0;
  max-width: 44ch;
  color: var(--rdm-ink-2);
  font-size: 12.5px;
  line-height: 19px;
}

/* Loading skeleton (only before the first snapshot arrives). */
.rdm-skeleton { display: flex; flex-direction: column; }
.rdm-skeleton-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 16px;
}
.rdm-skeleton-row + .rdm-skeleton-row { border-top: 0.5px solid var(--rdm-line); }
.rdm-skeleton-line {
  display: block;
  height: 12px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-skeleton, var(--rdm-track));
  animation: rdm-skeleton 1.6s ease-in-out infinite;
}
.rdm-skeleton-line--name { width: 38%; }
.rdm-skeleton-line--meta { width: 56%; height: 10px; }
.rdm-skeleton-rail { display: flex; gap: 3px; height: 7px; }
.rdm-skeleton-lane {
  flex: 1;
  border-radius: 2px;
  background: var(--dsw-alias-bg-skeleton, var(--rdm-track));
  animation: rdm-skeleton 1.6s ease-in-out infinite;
}
@keyframes rdm-skeleton { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

/* A download row. */
.rdm-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 13px 16px 14px;
  transition: background-color 0.12s ease;
}
.rdm-row:first-child { border-top-left-radius: 15px; border-top-right-radius: 15px; }
.rdm-row:last-child { border-bottom-left-radius: 15px; border-bottom-right-radius: 15px; }
.rdm-row + .rdm-row { border-top: 0.5px solid var(--rdm-line); }
.rdm-row:hover { background: color-mix(in srgb, var(--rdm-ink-2) 4%, transparent); }
.rdm-row-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
.rdm-state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  color: var(--rdm-ink-2);
  font-size: 12px;
  line-height: 18px;
}
.rdm-state-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rdm-idle);
}
.rdm-state[data-tone='business'] .rdm-state-dot { background: var(--rdm-signal); }
.rdm-state[data-tone='warn'] .rdm-state-dot { background: var(--rdm-warn); }
.rdm-state[data-tone='success'] .rdm-state-dot { background: var(--rdm-ok); }
.rdm-state[data-tone='error'] .rdm-state-dot { background: var(--rdm-err); }
.rdm-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--rdm-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdm-row-pct {
  flex: none;
  min-width: 34px;
  color: var(--rdm-ink);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  text-align: right;
}
.rdm-row-actions { display: inline-flex; flex: none; align-items: center; gap: 1px; margin-left: 2px; }
.rdm-chevron { display: inline-flex; transition: transform 0.15s ease; }
.rdm-chevron[data-expanded='true'] { transform: rotate(180deg); }

/* Transfer rail: bytes and only bytes. The connection lanes are the tick
   meter in the meta line below, so a stalled-looking empty bar never lies. */
.rdm-rail {
  position: relative;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--rdm-track);
}
.rdm-rail-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 3px;
  background: var(--rdm-signal);
  transition: width 0.35s ease;
}
.rdm-rail[data-state='warn'] .rdm-rail-fill { background: var(--rdm-warn); }
.rdm-rail[data-state='success'] .rdm-rail-fill { background: var(--rdm-ok-quiet); }
.rdm-rail[data-state='error'] .rdm-rail-fill { background: var(--rdm-err-quiet); }
.rdm-rail[data-state='muted'] .rdm-rail-fill {
  background: color-mix(in srgb, var(--rdm-ink-3) 60%, transparent);
}
/* Unknown length while probing/running: a small signal segment sweeps through
   an already tinted rail, so live-but-sizeless never reads as stalled. */
.rdm-rail[data-indeterminate='true'] {
  background: color-mix(in srgb, var(--rdm-signal) 16%, var(--rdm-track));
}
.rdm-rail[data-indeterminate='true'] .rdm-rail-fill {
  width: 34% !important;
  animation: rdm-rail-sweep 1.6s ease-in-out infinite;
}
@keyframes rdm-rail-sweep {
  0% { transform: translateX(-12%); }
  100% { transform: translateX(232%); }
}
/* Connection lanes: one tick per planned worker, staffed ticks are lit.
   Static by design; only staffed lanes breathe, and only while running. */
.rdm-lanes {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 9px;
}
.rdm-lane-mark {
  display: block;
  flex: none;
  width: 3px;
  height: 9px;
  border-radius: 1px;
  background: var(--rdm-track);
}
.rdm-lane-mark[data-active='true'] { background: var(--rdm-signal); }
.rdm-lane-mark[data-active='true'][data-running='true'] {
  animation: rdm-lane-mark 1.8s ease-in-out infinite;
}
@keyframes rdm-lane-mark {
  0%, 100% { opacity: 0.62; }
  50% { opacity: 1; }
}

/* State-specific telemetry. Labels are quiet; values carry the data. */
.rdm-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  color: var(--rdm-ink-2);
  font-size: 12px;
  line-height: 18px;
}
.rdm-meta-item { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; white-space: nowrap; }
.rdm-meta-label { color: var(--rdm-ink-3); }
.rdm-meta-value { color: var(--rdm-ink-2); font-variant-numeric: tabular-nums; }

.rdm-path-row { display: flex; flex-wrap: nowrap; align-items: baseline; gap: 8px; min-width: 0; font-size: 12px; line-height: 18px; }
.rdm-path-label { flex: none; color: var(--rdm-ink-3); }
.rdm-path {
  min-width: 0;
  overflow: hidden;
  color: var(--rdm-ink-2);
  font-family: var(--rdm-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdm-row-error {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--rdm-err-text);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.rdm-row-error-label { flex: none; font-weight: 500; }

/* Expanded details: engine facts + the kernel event log. */
.rdm-row-details { padding-top: 10px; border-top: 0.5px solid var(--rdm-line); animation: rdm-details-in 0.15s ease-out; }
@keyframes rdm-details-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
.rdm-details { display: flex; flex-direction: column; gap: 12px; }
.rdm-details-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 4px 24px;
  margin: 0;
}
.rdm-detail { display: flex; align-items: baseline; gap: 10px; min-width: 0; font-size: 12px; line-height: 18px; }
.rdm-detail dt { flex: none; color: var(--rdm-ink-3); }
.rdm-detail dd { min-width: 0; margin: 0; color: var(--rdm-ink-2); overflow-wrap: anywhere; }
.rdm-detail code { font-family: var(--rdm-code); font-size: 11.5px; }
.rdm-events-block { display: flex; flex-direction: column; gap: 6px; }
.rdm-events-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--rdm-ink-3);
  font-size: 12px;
  line-height: 18px;
}
.rdm-events-loading { display: inline-flex; align-items: center; gap: 6px; color: var(--rdm-ink-3); }
.rdm-events-note { color: var(--rdm-ink-3); font-size: 12px; line-height: 18px; }
.rdm-events {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border: 0.5px solid var(--rdm-line);
  border-radius: 8px;
  background: var(--rdm-wash);
}
.rdm-event {
  display: flex;
  gap: 8px;
  min-width: 0;
  color: var(--rdm-ink-2);
  font-family: var(--rdm-code);
  font-size: 11.5px;
  line-height: 17px;
  overflow-wrap: anywhere;
}
.rdm-event-time { flex: none; color: var(--rdm-ink-3); font-variant-numeric: tabular-nums; }
.rdm-event-kind { flex: none; color: var(--rdm-signal-text); }
.rdm-event-detail { min-width: 0; white-space: pre-wrap; }

/* Overflow menu. */
.rdm-menu-anchor { position: relative; display: inline-flex; }
.rdm-menu {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
  z-index: 40;
  display: flex;
  min-width: 172px;
  flex-direction: column;
  gap: 1px;
  box-sizing: border-box;
  padding: 4px;
  border: 0.5px solid var(--rdm-line-strong);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-panel);
  animation: rdm-menu-in 0.12s ease-out;
}
@keyframes rdm-menu-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.rdm-menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--rdm-ink);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.rdm-menu-item:hover { background: var(--rdm-hover); }
.rdm-menu-item:focus-visible { outline: 2px solid var(--rdm-focus); outline-offset: -2px; }
.rdm-menu-item--danger { color: var(--rdm-err-text); }
.rdm-menu-touch { display: none; }
@media (max-width: 520px) { .rdm-menu-touch { display: contents; } }
.rdm-menu-sep { height: 0.5px; margin: 3px 2px; background: var(--rdm-line); }

/* Copy feedback. */
.rdm-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  z-index: 60;
  max-width: min(80vw, 420px);
  padding: 7px 12px;
  border: 0.5px solid var(--dsw-alias-border-inverted, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  transform: translateX(-50%);
  animation: rdm-toast-in 0.14s ease-out;
}
@keyframes rdm-toast-in { from { opacity: 0; transform: translate(-50%, 4px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* Narrow layouts: stack the header and composer, then wrap telemetry. */
@media (max-width: 760px) {
  .rdm-panel { gap: 16px; padding: 20px 16px 40px; }
  .rdm-composer-row { flex-wrap: wrap; padding: 6px; }
  .rdm-url-input { flex: 1 1 100%; height: 32px; padding: 0 4px; }
  .rdm-options-toggle { margin-left: 0; }
  .rdm-start { flex: 0 0 auto; margin-left: auto; }
  .rdm-options { grid-template-columns: 1fr; }
  .rdm-section-head { gap: 8px 10px; }
  .rdm-filters { order: 3; width: 100%; }
  .rdm-summary { order: 2; margin-left: auto; }
  .rdm-row { padding: 12px 13px 13px; }
  .rdm-details-grid { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .rdm-summary { order: 3; width: 100%; margin-left: 0; }
  .rdm-meta { gap: 2px 12px; }
  .rdm-row-pct { min-width: 30px; }
  .rdm-row-actions .rdm-btn--icon:not([data-rdm-action='menu']) { display: none; }
  .rdm-row-actions [data-rdm-action='menu'] { width: 36px; height: 36px; }
  .rdm-menu { min-width: 188px; }
  .rdm-menu-item { height: 36px; }
}

@media (prefers-reduced-motion: reduce) {
  .rdm-rail-fill,
  .rdm-lane-mark,
  .rdm-chevron,
  .rdm-spinner,
  .rdm-skeleton-line,
  .rdm-skeleton-lane,
  .rdm-menu,
  .rdm-toast,
  .rdm-row-details {
    animation: none !important;
    transition: none !important;
  }
  /* The rail keeps its 34% signal segment at rest (transform is animated only). */
  .rdm-rail[data-indeterminate='true'] .rdm-rail-fill { transform: none; }
}
`
