// Small shared marks for the review surfaces: status glyph, verification seal,
// server-fact chip, byte meter, connection badge, checkboxes, icon buttons,
// empty state and the polite live region.
//
// All colour comes from CSS custom properties defined once on `.rdm2`; this
// file only carries structure and accessible names.

import React from 'react'
import type { ChipModel, SealModel } from './model'
import { REVIEW_CSS } from './review-css'
import { ChevronGlyph, CloseGlyph } from './icons'

/** The one keyed style element both surfaces render (CSS lives in review-css.ts). */
export function ReviewStyle() {
  return <style data-rdm2-styles="">{REVIEW_CSS}</style>
}

/** One action offered beside a notice (e.g. copy a path that could not be opened). */
export interface NoticeAction {
  label: string
  onClick: () => void
}

export interface NoticeBarProps {
  /** `success` confirms a completed user action; `info` explains a limitation; `error` reports a failure. */
  tone?: 'success' | 'info' | 'error'
  title: string
  hint?: string
  action?: NoticeAction
  onDismiss?: () => void
  dismissLabel?: string
}

/**
 * Visible outcome bar for a user action.
 *
 * `LiveRegion` alone is screen-reader-only: a sighted user clicking an action
 * that produces no window on the host (file opener, desktop-only capability)
 * otherwise sees nothing at all. Actions that can silently degrade render this
 * bar so the outcome — success, limitation, or failure — is always on screen.
 */
export function NoticeBar(props: NoticeBarProps) {
  const tone = props.tone ?? 'info'
  return (
    <div className="rdm2-banner" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="rdm2-banner-copy">
        <span className="rdm2-banner-title">{props.title}</span>
        {props.hint !== undefined ? <span className="rdm2-banner-hint">{props.hint}</span> : null}
      </div>
      <div className="rdm2-banner-actions">
        {props.action !== undefined ? (
          <TextButton label={props.action.label} onClick={props.action.onClick}>
            {props.action.label}
          </TextButton>
        ) : null}
        {props.onDismiss !== undefined ? (
          <IconButton label={props.dismissLabel ?? 'Dismiss'} onClick={props.onDismiss}>
            <CloseGlyph size={12} />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
}

/** The six shapes a record's status can take, as a 10×10 mark. */
function glyphPath(status: string): any {
  switch (status) {
    case 'running':
      return (
        <>
          <circle cx="5" cy="5" r="4.6" className="rdm2-glyph-ring" />
          <circle cx="5" cy="5" r="2.6" className="rdm2-glyph-core" />
        </>
      )
    case 'probing':
      return (
        <>
          <circle cx="5" cy="5" r="4.2" className="rdm2-glyph-stroke" />
          <circle cx="5" cy="5" r="1.3" className="rdm2-glyph-core" />
        </>
      )
    case 'queued':
      return <circle cx="5" cy="5" r="4.2" className="rdm2-glyph-stroke" />
    case 'paused':
    case 'interrupted':
      return (
        <>
          <rect x="2.4" y="2.4" width="1.8" height="5.2" rx="0.7" className="rdm2-glyph-core" />
          <rect x="5.8" y="2.4" width="1.8" height="5.2" rx="0.7" className="rdm2-glyph-core" />
        </>
      )
    case 'completed':
      return <path d="M1.9 5.3 L4.2 7.6 L8.2 2.7" className="rdm2-glyph-stroke" fill="none" />
    case 'failed':
      return (
        <>
          <path d="M2.6 2.6 L7.4 7.4" className="rdm2-glyph-stroke" fill="none" />
          <path d="M7.4 2.6 L2.6 7.4" className="rdm2-glyph-stroke" fill="none" />
        </>
      )
    default:
      return <rect x="2" y="4.3" width="6" height="1.5" rx="0.7" className="rdm2-glyph-core" />
  }
}

export interface StatusGlyphProps {
  status: string
  tone: 'live' | 'paused' | 'done' | 'failed' | 'idle'
  /** Localized status word; also the accessible name of the mark. */
  label: string
}

/** A record's status mark. The shape carries the state; the word is its name. */
export function StatusGlyph(props: StatusGlyphProps) {
  return (
    <span className="rdm2-glyph" data-tone={props.tone} role="img" aria-label={props.label} title={props.label}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {glyphPath(props.status)}
      </svg>
    </span>
  )
}

/** Verification seal: a bordered capsule, present only after a hash compared. */
export function Seal({ seal }: { seal: SealModel }) {
  return (
    <span className="rdm2-seal" data-state={seal.state} role="img" aria-label={seal.label} title={seal.label}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        {seal.state === 'verified' ? (
          <path d="M1.9 5.3 L4.2 7.6 L8.2 2.7" className="rdm2-seal-stroke" fill="none" />
        ) : (
          <>
            <path d="M2.6 2.6 L7.4 7.4" className="rdm2-seal-stroke" fill="none" />
            <path d="M7.4 2.6 L2.6 7.4" className="rdm2-seal-stroke" fill="none" />
          </>
        )}
      </svg>
      <code className="rdm2-seal-hash">{seal.hash}</code>
    </span>
  )
}

/** One server-fact chip (11px, 1px border, quiet). */
export function Chip({ chip }: { chip: ChipModel }) {
  return (
    <span className="rdm2-chip" data-tone={chip.tone}>
      {chip.label}
    </span>
  )
}

export interface ChipRowProps {
  chips: ChipModel[]
  /** Maximum chips shown on a row; the drawer shows all of them. */
  max?: number
  /** Overflow copy, e.g. `+2`. */
  overflowLabel?: (hidden: number) => string
}

/** A row's chips, capped (0.2.0 §6.5: at most 4 visible; drawer shows all). */
export function ChipRow(props: ChipRowProps) {
  const max = props.max ?? 4
  const chips = props.chips
  if (chips.length === 0) return null
  const visible = chips.slice(0, max)
  const hidden = chips.length - visible.length
  return (
    <div className="rdm2-chips">
      {visible.map((chip) => (
        <Chip key={chip.key} chip={chip} />
      ))}
      {hidden > 0 ? (
        <span className="rdm2-chip-more">{props.overflowLabel !== undefined ? props.overflowLabel(hidden) : `+${hidden}`}</span>
      ) : null}
    </div>
  )
}

/** Three-bar ETA confidence mark; the word is carried in the accessible name. */
export function ConfidenceMark({ bars, label }: { bars: number; label: string }) {
  return (
    <span className="rdm2-confidence" role="img" aria-label={label} title={label}>
      <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" focusable="false">
        <rect x="0.5" y="6" width="2.4" height="3.5" rx="0.6" className={bars >= 1 ? 'rdm2-conf-on' : 'rdm2-conf-off'} />
        <rect x="4.8" y="3.4" width="2.4" height="6.1" rx="0.6" className={bars >= 2 ? 'rdm2-conf-on' : 'rdm2-conf-off'} />
        <rect x="9.1" y="0.8" width="2.4" height="8.7" rx="0.6" className={bars >= 3 ? 'rdm2-conf-on' : 'rdm2-conf-off'} />
      </svg>
    </span>
  )
}

/** The progress meter under a record's meta line; tone carries the state. */
export function ByteMeter({ fraction, tone }: { fraction: number; tone: 'live' | 'paused' | 'done' | 'failed' | 'idle' }) {
  const width = `${Math.max(0, Math.min(1, fraction)) * 100}%`
  return (
    <div className="rdm2-meter" data-tone={tone} role="presentation">
      <span className="rdm2-meter-fill" style={{ width }} />
    </div>
  )
}

/** Worker-connection badge: the adaptive concurrency, at a glance. */
export function ConnectionBadge({ label, title }: { label: string; title: string }) {
  return (
    <span className="rdm2-conn" title={title} aria-label={title}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none">
          <path d="M3 9.2V4.4M6 9.2V2.6M9 9.2V5.8" />
        </g>
      </svg>
      {label}
    </span>
  )
}

/** An icon-only action button with a visible tooltip via `title` + a11y name. */
export interface IconButtonProps {
  label: string
  onClick?: (event: { stopPropagation(): void }) => void
  disabled?: boolean
  tone?: 'default' | 'danger'
  className?: string
  children: any
}

export function IconButton(props: IconButtonProps) {
  return (
    <button
      type="button"
      className={`rdm2-icon-button${props.className === undefined ? '' : ` ${props.className}`}`}
      data-tone={props.tone ?? 'default'}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled === true}
      onClick={(event) => {
        event.stopPropagation()
        props.onClick?.(event)
      }}
    >
      {props.children}
    </button>
  )
}

/** A quiet text button. */
export interface TextButtonProps {
  label?: string
  onClick?: (event: { stopPropagation(): void }) => void
  disabled?: boolean
  tone?: 'default' | 'danger' | 'primary'
  className?: string
  children: any
}

export function TextButton(props: TextButtonProps) {
  return (
    <button
      type="button"
      className={`rdm2-button${props.className === undefined ? '' : ` ${props.className}`}`}
      data-tone={props.tone ?? 'default'}
      aria-label={props.label}
      disabled={props.disabled === true}
      onClick={(event) => {
        event.stopPropagation()
        props.onClick?.(event)
      }}
    >
      {props.children}
    </button>
  )
}

/** A custom checkbox (button semantics) that stays legible on every token set. */
export interface CheckboxProps {
  checked: boolean
  mixed?: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
  className?: string
}

export function Checkbox(props: CheckboxProps) {
  return (
    <button
      type="button"
      className={`rdm2-checkbox${props.className === undefined ? '' : ` ${props.className}`}`}
      role="checkbox"
      aria-checked={props.mixed === true ? 'mixed' : props.checked}
      aria-label={props.label}
      disabled={props.disabled === true}
      data-checked={props.checked || props.mixed === true ? 'true' : 'false'}
      onClick={(event) => {
        event.stopPropagation()
        if (props.disabled === true) return
        props.onChange(!props.checked)
      }}
    >
      {props.mixed === true ? (
        <span className="rdm2-checkbox-dash" aria-hidden="true" />
      ) : props.checked ? (
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">
          <path d="M2 5.7 4.4 8 9 2.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  )
}

/** Kernel health mark: one dot, nothing else (`idle` while the first poll runs). */
export function KernelDot({ tone, label }: { tone: 'ok' | 'bad' | 'idle'; label: string }) {
  return <span className="rdm2-kernel-dot" data-tone={tone} role="img" aria-label={label} title={label} />
}

/** Disclosure chevron for the filter menu and record drawer. */
export function Disclosure({ open }: { open: boolean }) {
  return (
    <span className="rdm2-disclosure" data-open={open ? 'true' : 'false'} aria-hidden="true">
      <ChevronGlyph size={12} />
    </span>
  )
}

/** Polite live region for copy/stop feedback; visually hidden. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <span className="rdm2-sr-only" role="status" aria-live="polite">
      {message}
    </span>
  )
}

/** Loading skeleton rows for the ledger while the first poll is in flight. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  const items: any[] = []
  for (let index = 0; index < rows; index += 1) {
    items.push(
      <div className="rdm2-skeleton-card" key={index} aria-hidden="true">
        <span className="rdm2-skeleton rdm2-skeleton-name" />
        <span className="rdm2-skeleton rdm2-skeleton-meta" />
        <span className="rdm2-skeleton rdm2-skeleton-meter" />
      </div>,
    )
  }
  return (
    <div className="rdm2-skeleton-list" aria-busy="true">
      {items}
    </div>
  )
}

/** A calm empty state: mark, sentence, optional next step. */
export function EmptyState({ icon, title, hint }: { icon?: any; title: string; hint?: string }) {
  return (
    <div className="rdm2-empty-state">
      {icon === undefined ? null : <span className="rdm2-empty-icon">{icon}</span>}
      <p className="rdm2-empty-title">{title}</p>
      {hint === undefined ? null : <p className="rdm2-empty-hint">{hint}</p>}
    </div>
  )
}

/** Visually hidden text (accessible names, state words). */
export function SrOnly({ children }: { children: any }) {
  return <span className="rdm2-sr-only">{children}</span>
}

/** A one-line empty/annotation note inside a surface. */
export function Note({ children }: { children: any }) {
  return <p className="rdm2-note">{children}</p>
}
