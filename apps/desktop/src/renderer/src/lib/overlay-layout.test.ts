import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_POLL_OVERLAY_ITEM,
  OVERLAY_ITEMS,
  type OverlayLayout
} from '../../../shared/backend'
import {
  validateBackendEventPayload,
  validateBackendRpcResult
} from '../../../shared/backend-rpc-contract'
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
  OVERLAY_ITEM_LABELS,
  OVERLAY_SNAP_LABELS,
  type OverlayAuxLeg
} from './overlay-layout'
import {
  START_NOTICE_LABELS,
  bannerStartNotices,
  overlayAndBannerStartNotices
} from './banner-start-notices'

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/high-risk-contracts.json', import.meta.url),
    'utf8'
  )
) as {
  // Plan 188 S3: written before the poll, the fixture may not carry it yet.
  overlayLayout: {
    defaults: Omit<OverlayLayout, 'poll'> & Partial<Pick<OverlayLayout, 'poll'>>
    placed: Omit<OverlayLayout, 'poll'> & Partial<Pick<OverlayLayout, 'poll'>>
  }
}

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
    // Read the way the Studio reads the backend: a fixture without `poll`
    // takes the poll's default place (plan 188 S3).
    const defaults = validateBackendRpcResult(
      'overlays.layout.get',
      fixtures.overlayLayout.defaults
    ) as OverlayLayout
    const placed = validateBackendRpcResult(
      'overlays.layout.get',
      fixtures.overlayLayout.placed
    ) as OverlayLayout
    expect(DEFAULT_OVERLAY_LAYOUT).toStrictEqual(defaults)
    expect(overlayLayoutsEqual(DEFAULT_OVERLAY_LAYOUT, defaults)).toBe(true)
    expect(overlayLayoutsEqual(DEFAULT_OVERLAY_LAYOUT, placed)).toBe(false)
  })

  it('places the poll top left on landscape and top centre in the portrait safe area (plan 188 D12)', () => {
    const { poll } = DEFAULT_OVERLAY_LAYOUT
    expect(poll).toStrictEqual(DEFAULT_POLL_OVERLAY_ITEM)
    expect(poll.horizontal).toStrictEqual(overlaySnapRect('poll', 'horizontal', 'top-left'))
    expect(poll.horizontal).toStrictEqual({ x: 0.0225, y: 0.04, w: 0.3, h: 0.4 })
    expect(poll.vertical).toStrictEqual(overlaySnapRect('poll', 'vertical', 'top-center'))
    expect(poll.vertical.x + poll.vertical.w / 2).toBeCloseTo(0.5, 6)
    // Inside the portrait safe area: 8% top, 22% bottom (plan 077).
    expect(poll.vertical.y).toBeCloseTo(0.08, 6)
    expect(poll.vertical.y + poll.vertical.h).toBeLessThanOrEqual(1 - 0.22)
    expect(poll.showOnStream && poll.showInRecording).toBe(true)
    // The one free landscape corner: off the highlight (bottom left) and the
    // Buddy (bottom right).
    for (const other of ['highlight', 'buddy'] as const) {
      const rect = DEFAULT_OVERLAY_LAYOUT[other].horizontal
      expect(poll.horizontal.y + poll.horizontal.h).toBeLessThanOrEqual(rect.y)
    }
    expect(OVERLAY_ITEM_LABELS.poll).toBe('Poll')
    expect(OVERLAY_SNAP_LABELS['top-center']).toBe('Top center')
  })

  it('keeps the three placements of a layout stored before the poll (plan 188 S3)', () => {
    const { poll: _none, ...legacy } = fixtures.overlayLayout.placed
    for (const read of [
      validateBackendRpcResult('overlays.layout.get', legacy),
      validateBackendEventPayload('overlays.layout', legacy)
    ] as OverlayLayout[]) {
      expect(read.highlight).toStrictEqual(legacy.highlight)
      expect(read.captions).toStrictEqual(legacy.captions)
      expect(read.buddy).toStrictEqual(legacy.buddy)
      expect(read.poll).toStrictEqual(DEFAULT_OVERLAY_LAYOUT.poll)
      expect(overlayLayoutsEqual(read, { ...legacy, poll: DEFAULT_POLL_OVERLAY_ITEM })).toBe(true)
    }
  })

  it('snaps every item to every corner inside the canvas', () => {
    for (const item of OVERLAY_ITEMS) {
      for (const orientation of ['horizontal', 'vertical'] as const) {
        const topLeft = overlaySnapRect(item, orientation, 'top-left')
        const topRight = overlaySnapRect(item, orientation, 'top-right')
        const bottomLeft = overlaySnapRect(item, orientation, 'bottom-left')
        const bottomRight = overlaySnapRect(item, orientation, 'bottom-right')
        const bottomCenter = overlaySnapRect(item, orientation, 'bottom-center')
        const topCenter = overlaySnapRect(item, orientation, 'top-center')
        for (const rect of [topLeft, topRight, bottomLeft, bottomRight, bottomCenter, topCenter]) {
          expect(overlayRectValid(rect)).toBe(true)
          expect(rect.w).toBe(topLeft.w)
          expect(rect.h).toBe(topLeft.h)
        }
        expect(topLeft.x).toBe(bottomLeft.x)
        expect(topRight.x + topRight.w).toBeCloseTo(1 - topLeft.x, 6)
        expect(bottomCenter.x + bottomCenter.w / 2).toBeCloseTo(0.5, 6)
        expect(topCenter.x).toBe(bottomCenter.x)
        expect(topCenter.y).toBe(topLeft.y)
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

describe('banner start notices (plan 186, D13 with the label `banners`)', () => {
  const SHARED =
    'Both the stream and the recording will include banners: this computer shares one encode for them.'
  const RECORDING = 'Recording will include banners while streaming vertical.'
  const HORIZONTAL = 'The horizontal stream will include banners while streaming vertical.'
  const banner = (shown: boolean, showOnStream: boolean, showInRecording: boolean) => ({
    shown,
    showOnStream,
    showInRecording
  })
  const both = { recordEnabled: true, streamEnabled: true }
  const streamOnly = banner(true, true, false)
  const recordingOnly = banner(true, false, true)

  it('pins the three sentences byte for byte (the Rust twin builds the same)', () => {
    expect(bannerStartNotices({ ...both, auxLeg: 'none' }, [streamOnly])).toStrictEqual([
      { item: 'banners', notice: SHARED }
    ])
    expect(
      bannerStartNotices({ ...both, auxLeg: 'vertical-simulcast' }, [streamOnly])
    ).toStrictEqual([{ item: 'banners', notice: RECORDING }])
    expect(
      bannerStartNotices({ ...both, auxLeg: 'vertical-simulcast' }, [recordingOnly])
    ).toStrictEqual([{ item: 'banners', notice: HORIZONTAL }])
    expect(START_NOTICE_LABELS.banners).toBe('Banners')
  })

  it('says each sentence once, however many showing banners need it', () => {
    expect(
      bannerStartNotices({ ...both, auxLeg: 'none' }, [streamOnly, recordingOnly, streamOnly])
    ).toStrictEqual([{ item: 'banners', notice: SHARED }])
    expect(
      bannerStartNotices({ ...both, auxLeg: 'vertical-simulcast' }, [
        recordingOnly,
        streamOnly,
        streamOnly
      ]).map((notice) => notice.notice)
    ).toStrictEqual([RECORDING, HORIZONTAL])
  })

  it('needs no sentence for hidden banners, agreeing switches, a split leg or one output', () => {
    const hidden = banner(false, true, false)
    const agreeing = [banner(true, true, true), banner(true, false, false)]
    expect(bannerStartNotices({ ...both, auxLeg: 'none' }, [hidden, ...agreeing])).toStrictEqual([])
    expect(bannerStartNotices({ ...both, auxLeg: 'stream' }, [streamOnly])).toStrictEqual([])
    expect(
      bannerStartNotices({ recordEnabled: false, streamEnabled: true, auxLeg: 'none' }, [
        streamOnly
      ])
    ).toStrictEqual([])
    expect(
      bannerStartNotices({ recordEnabled: true, streamEnabled: false, auxLeg: 'none' }, [
        recordingOnly
      ])
    ).toStrictEqual([])
  })

  it('follows the overlay items in the Go Live sheet', () => {
    const layout = withSwitches(DEFAULT_OVERLAY_LAYOUT, 'highlight', true, false)
    expect(
      overlayAndBannerStartNotices({ ...both, auxLeg: 'none' }, layout, [recordingOnly]).map(
        (notice) => notice.item
      )
    ).toStrictEqual(['highlight', 'banners'])
  })
})
