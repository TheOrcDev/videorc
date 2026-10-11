import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OVERLAY_ITEMS, type OverlayLayout } from '../../../shared/backend'
import {
  DEFAULT_OVERLAY_LAYOUT,
  clampOverlayRect,
  overlayItemOutputBadge,
  overlayLayoutNeedsSplit,
  overlayLayoutsEqual,
  overlayLegPlan,
  overlayOrientationForCanvas,
  overlayRectBottomGravity,
  overlayRectValid,
  overlaySnapRect,
  overlayStartNotices,
  type OverlayAuxLeg
} from './overlay-layout'

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/high-risk-contracts.json', import.meta.url),
    'utf8'
  )
) as { overlayLayout: { defaults: OverlayLayout; placed: OverlayLayout } }

function withSwitches(
  layout: OverlayLayout,
  item: keyof OverlayLayout,
  showOnStream: boolean,
  showInRecording: boolean
): OverlayLayout {
  return { ...layout, [item]: { ...layout[item], showOnStream, showInRecording } }
}

describe('overlay layout defaults and snaps', () => {
  it('mirrors the Rust defaults pinned by the shared fixture', () => {
    expect(DEFAULT_OVERLAY_LAYOUT).toStrictEqual(fixtures.overlayLayout.defaults)
    expect(overlayLayoutsEqual(DEFAULT_OVERLAY_LAYOUT, fixtures.overlayLayout.defaults)).toBe(true)
    expect(overlayLayoutsEqual(DEFAULT_OVERLAY_LAYOUT, fixtures.overlayLayout.placed)).toBe(false)
  })

  it('snaps every item to every corner inside the canvas', () => {
    for (const item of OVERLAY_ITEMS) {
      for (const orientation of ['horizontal', 'vertical'] as const) {
        const topLeft = overlaySnapRect(item, orientation, 'top-left')
        const topRight = overlaySnapRect(item, orientation, 'top-right')
        const bottomLeft = overlaySnapRect(item, orientation, 'bottom-left')
        const bottomRight = overlaySnapRect(item, orientation, 'bottom-right')
        const bottomCenter = overlaySnapRect(item, orientation, 'bottom-center')
        for (const rect of [topLeft, topRight, bottomLeft, bottomRight, bottomCenter]) {
          expect(overlayRectValid(rect)).toBe(true)
          expect(rect.w).toBe(topLeft.w)
          expect(rect.h).toBe(topLeft.h)
        }
        expect(topLeft.x).toBe(bottomLeft.x)
        expect(topRight.x + topRight.w).toBeCloseTo(1 - topLeft.x, 6)
        expect(bottomCenter.x + bottomCenter.w / 2).toBeCloseTo(0.5, 6)
        expect(overlayRectBottomGravity(topLeft)).toBe(false)
        expect(overlayRectBottomGravity(bottomRight)).toBe(true)
      }
    }
    // The default highlight corner is the pre-plan-164 bottom-left card.
    expect(overlaySnapRect('highlight', 'horizontal', 'bottom-left')).toStrictEqual(
      DEFAULT_OVERLAY_LAYOUT.highlight.horizontal
    )
  })

  it('clamps dragged rects into the canvas and above the minimum size', () => {
    expect(clampOverlayRect({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 })).toStrictEqual({
      x: 0.7,
      y: 0.7,
      w: 0.3,
      h: 0.3
    })
    expect(clampOverlayRect({ x: -0.2, y: 0.1, w: 0.001, h: 0.5 })).toStrictEqual({
      x: 0,
      y: 0.1,
      w: 0.02,
      h: 0.5
    })
    expect(overlayRectValid({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(overlayRectValid({ x: 0.5, y: 0, w: 0.6, h: 0.2 })).toBe(false)
    expect(overlayRectValid({ x: Number.NaN, y: 0, w: 0.6, h: 0.2 })).toBe(false)
    expect(overlayOrientationForCanvas(1920, 1080)).toBe('horizontal')
    expect(overlayOrientationForCanvas(1080, 1920)).toBe('vertical')
  })
})

describe('overlay leg plan (D12)', () => {
  const plan = (primary: boolean, aux: boolean, needsSplit: boolean) => ({
    primary,
    aux,
    needsSplit
  })
  const switches: Array<[boolean, boolean]> = [
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ]
  const legs: OverlayAuxLeg[] = ['none', 'stream', 'vertical-simulcast']

  it('matches the Rust table for every session shape and switch pair', () => {
    for (const auxLeg of legs) {
      for (const [onStream, inRecording] of switches) {
        expect(overlayLegPlan(false, false, auxLeg, onStream, inRecording)).toStrictEqual(
          plan(false, false, false)
        )
        expect(overlayLegPlan(true, false, auxLeg, onStream, inRecording)).toStrictEqual(
          plan(inRecording, false, false)
        )
      }
    }
    for (const [onStream, inRecording] of switches) {
      expect(overlayLegPlan(false, true, 'none', onStream, inRecording)).toStrictEqual(
        plan(onStream, false, false)
      )
      expect(overlayLegPlan(false, true, 'stream', onStream, inRecording)).toStrictEqual(
        plan(onStream, false, false)
      )
      expect(
        overlayLegPlan(false, true, 'vertical-simulcast', onStream, inRecording)
      ).toStrictEqual(plan(onStream, onStream, false))
      expect(overlayLegPlan(true, true, 'stream', onStream, inRecording)).toStrictEqual(
        plan(inRecording, onStream, false)
      )
    }
    expect(overlayLegPlan(true, true, 'none', false, false)).toStrictEqual(
      plan(false, false, false)
    )
    expect(overlayLegPlan(true, true, 'none', true, true)).toStrictEqual(plan(true, false, false))
    expect(overlayLegPlan(true, true, 'none', true, false)).toStrictEqual(plan(false, true, true))
    expect(overlayLegPlan(true, true, 'none', false, true)).toStrictEqual(plan(true, false, true))
    expect(overlayLegPlan(true, true, 'vertical-simulcast', false, false)).toStrictEqual(
      plan(false, false, false)
    )
    expect(overlayLegPlan(true, true, 'vertical-simulcast', true, false)).toStrictEqual(
      plan(true, true, false)
    )
    expect(overlayLegPlan(true, true, 'vertical-simulcast', false, true)).toStrictEqual(
      plan(true, false, false)
    )
    expect(overlayLegPlan(true, true, 'vertical-simulcast', true, true)).toStrictEqual(
      plan(true, true, false)
    )
  })

  it('flags a split need for any item, not only captions', () => {
    const shared = { recordEnabled: true, streamEnabled: true, auxLeg: 'none' as const }
    expect(overlayLayoutNeedsSplit(shared, DEFAULT_OVERLAY_LAYOUT)).toBe(false)
    expect(
      overlayLayoutNeedsSplit(shared, withSwitches(DEFAULT_OVERLAY_LAYOUT, 'buddy', true, false))
    ).toBe(true)
    expect(
      overlayLayoutNeedsSplit(
        { ...shared, auxLeg: 'stream' },
        withSwitches(DEFAULT_OVERLAY_LAYOUT, 'buddy', true, false)
      )
    ).toBe(false)
  })
})

describe('overlay start notices (D13)', () => {
  const layout = withSwitches(
    withSwitches(
      withSwitches(DEFAULT_OVERLAY_LAYOUT, 'highlight', true, false),
      'buddy',
      false,
      true
    ),
    'captions',
    true,
    false
  )

  it('says nothing when every switch pair can be honoured', () => {
    expect(
      overlayStartNotices(
        { recordEnabled: true, streamEnabled: true, auxLeg: 'none' },
        DEFAULT_OVERLAY_LAYOUT
      )
    ).toStrictEqual([])
    expect(
      overlayStartNotices({ recordEnabled: true, streamEnabled: true, auxLeg: 'stream' }, layout)
    ).toStrictEqual([])
    expect(
      overlayStartNotices({ recordEnabled: false, streamEnabled: true, auxLeg: 'none' }, layout)
    ).toStrictEqual([])
    expect(
      overlayStartNotices({ recordEnabled: true, streamEnabled: false, auxLeg: 'none' }, layout)
    ).toStrictEqual([])
  })

  it('names the shared-encode fallback for highlight and Buddy, never captions', () => {
    expect(
      overlayStartNotices({ recordEnabled: true, streamEnabled: true, auxLeg: 'none' }, layout)
    ).toStrictEqual([
      {
        item: 'highlight',
        notice:
          'Both the stream and the recording will include highlights: this computer shares one encode for them.'
      },
      {
        item: 'buddy',
        notice:
          'Both the stream and the recording will include the Buddy: this computer shares one encode for them.'
      }
    ])
  })

  it('names what the recording and the horizontal stream share beside a vertical leg', () => {
    expect(
      overlayStartNotices(
        { recordEnabled: true, streamEnabled: true, auxLeg: 'vertical-simulcast' },
        layout
      ).map((notice) => notice.notice)
    ).toStrictEqual([
      'Recording will include highlights while streaming vertical.',
      'Recording will include captions while streaming vertical.',
      'The horizontal stream will include the Buddy while streaming vertical.'
    ])
  })

  it('badges an item whose switches differ', () => {
    expect(overlayItemOutputBadge(layout.highlight)).toBe('stream only')
    expect(overlayItemOutputBadge(layout.buddy)).toBe('recording only')
    expect(overlayItemOutputBadge(DEFAULT_OVERLAY_LAYOUT.buddy)).toBeNull()
  })
})
