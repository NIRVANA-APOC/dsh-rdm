// Inline stroke icons for the review surfaces.
//
// One visual language: 16 px box, 1.5 px stroke, round caps and joins, no
// filled shapes. Colour always comes from `currentColor`, so a caller paints
// the mark with a theme token instead of a literal.

import React from 'react'

export interface GlyphProps {
  size?: number
  className?: string
}

interface GlyphFrameProps extends GlyphProps {
  children: any
}

function GlyphFrame({ size = 16, className, children }: GlyphFrameProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Downward arrow into a tray: the download mark. */
export function DownloadGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M8 2.4v7.1" />
      <path d="M4.9 6.7 8 9.8l3.1-3.1" />
      <path d="M2.9 11.4v1.2c0 .6.5 1 1 1h8.2c.5 0 1-.4 1-1v-1.2" />
    </GlyphFrame>
  )
}

/** A bare check mark: completed (the stat card supplies its tinted tile). */
export function CheckGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M2.8 8.4 6.2 11.6 13.2 4.2" />
    </GlyphFrame>
  )
}

/** A bare exclamation: failed (the stat card supplies its tinted tile). */
export function AlertGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M8 2.6v6.3" />
      <circle cx="8" cy="12.4" r="0.7" fill="currentColor" stroke="none" />
    </GlyphFrame>
  )
}

/** Two bars: pause. */
export function PauseGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <rect x="4.4" y="3.2" width="2.3" height="9.6" rx="0.9" />
      <rect x="9.3" y="3.2" width="2.3" height="9.6" rx="0.9" />
    </GlyphFrame>
  )
}

/** A triangle: resume. */
export function PlayGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M5.2 3.4v9.2l7.1-4.6z" />
    </GlyphFrame>
  )
}

/** A folder: open the containing directory. */
export function FolderGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M2.3 5.1c0-.7.5-1.2 1.2-1.2h2.6l1.4 1.5h4.9c.7 0 1.2.5 1.2 1.2v5c0 .7-.5 1.2-1.2 1.2H3.5c-.7 0-1.2-.5-1.2-1.2z" />
      <path d="M2.5 7.6h11" />
    </GlyphFrame>
  )
}

/** A page with a folded corner: open the file. */
export function FileGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M4 2.4h4.6L12 5.8v7.5c0 .2-.2.3-.4.3H4c-.2 0-.4-.1-.4-.3V2.7c0-.2.2-.3.4-.3z" />
      <path d="M8.5 2.6v3.3h3.3" />
    </GlyphFrame>
  )
}

/** A bin: delete the record. */
export function TrashGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M2.8 4.2h10.4" />
      <path d="M6.3 4.2V3c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.2" />
      <path d="M4.2 4.4l.6 8.2c0 .6.5 1 1 1h4.4c.5 0 1-.4 1-1l.6-8.2" />
      <path d="M6.6 7v4.2M9.4 7v4.2" />
    </GlyphFrame>
  )
}

/** Two offset pages: copy. */
export function CopyGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <rect x="5.4" y="5.4" width="8.1" height="8.1" rx="1.6" />
      <path d="M10.5 5.2V3.9c0-.8-.6-1.4-1.4-1.4H3.9c-.8 0-1.4.6-1.4 1.4v5.2c0 .8.6 1.4 1.4 1.4h1.3" />
    </GlyphFrame>
  )
}

/** A lens: the text filter. */
export function SearchGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.2 10.2 13.6 13.6" />
    </GlyphFrame>
  )
}

/** Chevron, rotated by CSS where needed. */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="m4.4 6.2 3.6 3.6 3.6-3.6" />
    </GlyphFrame>
  )
}

/** A cross: close or dismiss. */
export function CloseGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </GlyphFrame>
  )
}

/** A chain link: the pasted download URL. */
export function LinkGlyph(props: GlyphProps) {
  return (
    <GlyphFrame {...props}>
      <path d="M6.6 9.4a3 3 0 0 0 4.2 0l1.6-1.6a3 3 0 0 0-4.2-4.2L7.1 4.7" />
      <path d="M9.4 6.6a3 3 0 0 0-4.2 0L3.6 8.2a3 3 0 0 0 4.2 4.2l1.1-1.1" />
    </GlyphFrame>
  )
}
