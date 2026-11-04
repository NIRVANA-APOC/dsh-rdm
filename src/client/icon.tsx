// dsh-rdm sidebar glyph — "lane board" in one mark.
//
// The downloader is built around parallel worker connections: the panel draws a
// progress rail split into lanes. The sidebar entry repeats that idea as three
// staggered lane strokes dropping onto a broad chevron base. The chevron is the
// download tip — a U-tray read as a steaming cup at 16px and blurred the "save"
// idea, while the wide V stays an unmistakable download at one glance.
//
// Drawn in `currentColor` only: the sidebar row supplies the color and, when
// this panel is selected, the shell itself paints the active row background.
// The glyph has no plate of its own — the active treatment is a weight change on
// the base chevron, so the glyph never double-highlights the row.
//
// Geometry (viewBox 64): lanes at x 21 / 32 / 43 (11 units apart, ~1.25px of
// clearance at the 16px slot), staggered starts 11 / 6.5 / 14, one landing
// baseline at y 29; chevron base from (14,39) down to (50,39). strokeWidth 6
// renders as 1.5px at 16px, so no hairline; round caps keep the tips clean.

import React from 'react'

export interface IconProps {
  size?: number
  active?: boolean
}

const DEFAULT_SIZE = 18
const MIN_SIZE = 16
const MAX_SIZE = 48

export function Icon({ size, active }: IconProps) {
  const edge =
    typeof size === 'number' && isFinite(size)
      ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, size))
      : DEFAULT_SIZE
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={active ? 1 : 0.94}
      >
        {/* Base: the download tip / board the lanes land on. */}
        <path d="M14 39 32 51.5 50 39" strokeWidth={active ? 8.5 : 6} />
        {/* Three staggered lanes, parallel worker connections. */}
        <path d="M21 11V29" />
        <path d="M32 6.5V29" />
        <path d="M43 14V29" />
      </g>
    </svg>
  )
}
