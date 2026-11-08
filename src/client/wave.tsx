// The recorder strip — the review surfaces' signature element.
//
// A download has a pulse: measured bytes per second over time. This component
// draws that pulse as a 1.5px line with a 10 % fill, no grid, no axis, and a
// single live head dot that is the only moving part of the whole UI.
//
// Honesty rules (docs/design/0.2.0-agent-native.md §6.5):
//   * samples are right-anchored: a page that just opened starts at the right
//     edge with a short line, never a fake full chart;
//   * fewer than two samples, or no traffic at all, draw a flat hairline with
//     the `—` label — the recorder is idle, not broken;
//   * the fill is flat (10 % of the line colour), never a gradient;
//   * `prefers-reduced-motion` freezes the head dot (CSS media query).
//
// Preview harness support: `data-rdm2-wave` carries the sample count so a
// screenshot driver can assert the strip rendered real samples.

import React from 'react'

/** Samples per page strip: 120 s at 1 Hz. */
const PAGE_CAPACITY = 120

/** Viewbox is fixed; the SVG stretches with `preserveAspectRatio: none`. */
const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 100

export interface WaveformProps {
  /** Oldest..newest rate samples in bytes/second. Empty = no samples yet. */
  values: readonly number[]
  /** Samples that fit the drawn window (right-anchored). */
  capacity?: number
  /** Drawn height in pixels. */
  height?: number
  /** Compact per-record strip: no edge labels. */
  mini?: boolean
  /** Draw the pulsing head dot (only while the surface is actually receiving). */
  live?: boolean
  /** Left edge label: a clock time once the window is full, `—` before. */
  startLabel?: string
  /** Right edge label, typically the localized "now". */
  endLabel?: string
  /** Accessible name; the strip is an image, not a control. */
  ariaLabel: string
}

/** Build the line path, right-anchored into the fixed viewbox. */
function buildPaths(values: readonly number[], capacity: number): { line: string; area: string; headTop: number; headX: number } | null {
  if (values.length === 0) return null
  const count = Math.max(values.length, 2)
  const slots = Math.max(capacity, count)
  const peak = Math.max(1, ...values)
  const step = VIEW_WIDTH / (slots - 1)
  const offset = slots - count
  let line = ''
  let lastX = 0
  let lastY = VIEW_HEIGHT
  values.forEach((value, index) => {
    const x = (offset + index) * step
    // 8 % headroom so a peak never touches the top edge of the band.
    const ratio = Math.min(1, Math.max(0, value / peak))
    const y = VIEW_HEIGHT - ratio * (VIEW_HEIGHT * 0.92)
    line += index === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : ` L${x.toFixed(2)} ${y.toFixed(2)}`
    lastX = x
    lastY = y
  })
  const firstX = offset * step
  const area = `${line} L${lastX.toFixed(2)} ${VIEW_HEIGHT} L${firstX.toFixed(2)} ${VIEW_HEIGHT} Z`
  return { line, area, headTop: (lastY / VIEW_HEIGHT) * 100, headX: lastX }
}

/**
 * The aggregate recorder strip (full width) or a record's micro-strip.
 *
 * The head dot is positioned in HTML rather than SVG so the non-uniform
 * `preserveAspectRatio: none` scaling does not turn it into an ellipse.
 */
export function Waveform(props: WaveformProps) {
  const { values, capacity = PAGE_CAPACITY, height = 64, mini = false, live = false } = props
  const paths = buildPaths(values, capacity)
  const hasShape = paths !== null && values.length >= 2 && values.some((value) => value > 0)
  return (
    <div
      className="rdm2-wave"
      data-rdm2-wave={mini ? 'mini' : 'page'}
      data-rdm2-wave-samples={values.length}
      data-rdm2-wave-live={live ? 'true' : 'false'}
      style={{ height: `${height}px` }}
      role="img"
      aria-label={props.ariaLabel}
    >
      <div className="rdm2-wave-plot">
        <svg
          className="rdm2-wave-svg"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {/* Idle baseline: always present, one hairline, no grid. */}
          <line className="rdm2-wave-baseline" x1="0" y1={VIEW_HEIGHT} x2={VIEW_WIDTH} y2={VIEW_HEIGHT} />
          {paths !== null && hasShape ? (
            <>
              <path className="rdm2-wave-area" d={paths.area} />
              <path className="rdm2-wave-line" d={paths.line} vectorEffect="non-scaling-stroke" />
            </>
          ) : (
            <line className="rdm2-wave-flat" x1="0" y1={VIEW_HEIGHT} x2={VIEW_WIDTH} y2={VIEW_HEIGHT} />
          )}
        </svg>
        {paths !== null && hasShape && live ? (
          <span className="rdm2-wave-head" style={{ top: `${Math.min(96, paths.headTop)}%` }} aria-hidden="true" />
        ) : null}
      </div>
      {mini ? null : (
        <div className="rdm2-wave-labels" aria-hidden="true">
          <span className="rdm2-wave-label">{hasShape ? (props.startLabel ?? '—') : '—'}</span>
          <span className="rdm2-wave-label">{props.endLabel ?? ''}</span>
        </div>
      )}
    </div>
  )
}
