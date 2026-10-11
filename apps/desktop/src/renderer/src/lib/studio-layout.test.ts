import { describe, expect, it } from 'vitest'

import {
  STUDIO_GRID,
  STUDIO_INSPECTOR,
  STUDIO_PREVIEW_COLUMN,
  STUDIO_WIDE_MIN_PX,
  studioTransportRowClass
} from './studio-layout'

const WIDE = `@min-[${STUDIO_WIDE_MIN_PX}px]/studio:`

describe('Studio layout (plan 174 S3.3, B-10)', () => {
  it('keys on the page container, never the viewport', () => {
    for (const classes of [
      STUDIO_GRID,
      STUDIO_PREVIEW_COLUMN,
      STUDIO_INSPECTOR,
      studioTransportRowClass(false),
      studioTransportRowClass(true)
    ]) {
      expect(classes).not.toMatch(/(^|\s)(sm|md|lg|xl):/)
    }
    expect(STUDIO_GRID).toContain(`${WIDE}grid-cols-[minmax(0,1fr)_minmax(0,20rem)]`)
  })

  it('stays two columns in the smallest main window (960 px less the 208 px sidebar)', () => {
    expect(960 - 208).toBeGreaterThanOrEqual(STUDIO_WIDE_MIN_PX)
  })

  it('puts the transport first, on top of the inspector column when wide', () => {
    for (const docked of [false, true]) {
      const row = studioTransportRowClass(docked)
      expect(row).toContain('row-start-1')
      expect(row).toContain(`${WIDE}col-start-2`)
      expect(row).toContain(`${WIDE}row-start-1`)
    }
    expect(STUDIO_INSPECTOR).toContain(`${WIDE}row-start-2`)
    expect(STUDIO_PREVIEW_COLUMN).toContain(`${WIDE}row-span-2`)
  })

  it('pins the narrow transport row, except over a docked preview', () => {
    const pinned = studioTransportRowClass(false)
    expect(pinned).toMatch(/(^|\s)sticky(\s|$)/)
    expect(pinned).toContain('bg-glass-solid')
    expect(pinned).toContain(`${WIDE}static`)
    expect(studioTransportRowClass(true)).not.toMatch(/(^|\s)sticky(\s|$)/)
  })
})
