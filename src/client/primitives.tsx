// Small shared marks for the review surfaces: status glyph, verification seal,
// server-fact chip, byte meter, ETA confidence bars and the polite live region.
//
// All colour comes from CSS custom properties defined once on `.rdm2`; this
// file only carries structure and accessible names.

import React from 'react'
import type { ChipModel, SealModel } from './model'
import { REVIEW_CSS } from './review-css'

/** The one keyed style element both surfaces render (CSS lives in review-css.ts). */
export function ReviewStyle() {
  return <style data-rdm2-styles="">{REVIEW_CSS}</style>
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

/** The thin byte meter under a record's name line (not connection lanes). */
export function ByteMeter({ fraction, tone }: { fraction: number; tone: 'live' | 'paused' | 'done' | 'failed' | 'idle' }) {
  const width = `${Math.max(0, Math.min(1, fraction)) * 100}%`
  return (
    <div className="rdm2-meter" data-tone={tone} role="presentation">
      <span className="rdm2-meter-fill" style={{ width }} />
    </div>
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
export function SkeletonRows({ rows = 2 }: { rows?: number }) {
  const items: any[] = []
  for (let index = 0; index < rows; index += 1) {
    items.push(
      <div className="rdm2-skeleton-row" key={index} aria-hidden="true">
        <span className="rdm2-skeleton rdm2-skeleton-name" />
        <span className="rdm2-skeleton rdm2-skeleton-meter" />
        <span className="rdm2-skeleton rdm2-skeleton-meta" />
      </div>,
    )
  }
  return (
    <div className="rdm2-skeleton-list" aria-busy="true">
      {items}
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
