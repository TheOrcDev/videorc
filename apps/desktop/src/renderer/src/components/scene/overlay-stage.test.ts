import { describe, expect, it, vi } from 'vitest'

import type { Banner, OverlayLayout, OverlayOrientation, OverlayRect } from '@/lib/backend'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-view'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import {
  BannerEdits,
  OverlayEdits,
  bannerIdFromStageId,
  bannerStageId,
  bannerStageItems,
  overlayEditsBlockedReason,
  overlayItemFromStageId,
  overlayStageId,
  overlayStageItems,
  stageItemSnapPeers,
  stageRectToOverlay,
  withOverlayRect,
  type BannerStageItem
} from './overlay-stage'
import { StageGesture } from './stage-gesture'
import { stageSnapTargets } from './stage-transform'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('overlay stage helpers', () => {
  it('round-trips the stage id and lists every item with its badge', () => {
    expect(overlayItemFromStageId(overlayStageId('buddy'))).toBe('buddy')
    expect(overlayItemFromStageId('overlay:nope')).toBeNull()
    expect(overlayItemFromStageId('source:camera')).toBeNull()
    expect(overlayItemFromStageId(null)).toBeNull()
    const layout: OverlayLayout = {
      ...DEFAULT_OVERLAY_LAYOUT,
      highlight: { ...DEFAULT_OVERLAY_LAYOUT.highlight, showOnStream: true, showInRecording: true },
      // Switched off on both outputs: drawn dimmed with an "off" chip (plan 174, C-13).
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: false, showInRecording: false },
      buddy: { ...DEFAULT_OVERLAY_LAYOUT.buddy, showOnStream: true, showInRecording: false }
    }
    const items = overlayStageItems(layout, 'vertical')
    expect(items.map((item) => item.item)).toEqual(['highlight', 'captions', 'buddy'])
    expect(items[2]).toMatchObject({
      stageId: 'overlay:buddy',
      label: 'Buddy',
      badge: 'stream only',
      off: false,
      rect: {
        x: layout.buddy.vertical.x,
        y: layout.buddy.vertical.y,
        width: layout.buddy.vertical.w,
        height: layout.buddy.vertical.h
      }
    })
    expect(items[0]).toMatchObject({ badge: null, off: false })
    expect(items[1]).toMatchObject({ label: 'Captions', badge: 'off', off: true })
  })

  it('clamps a released stage rect before it reaches the wire', () => {
    expect(stageRectToOverlay({ x: 0.9, y: -0.1, width: 0.3, height: 0.005 })).toStrictEqual({
      x: 0.7,
      y: 0,
      w: 0.3,
      h: 0.02
    })
    const next = withOverlayRect(DEFAULT_OVERLAY_LAYOUT, 'highlight', 'horizontal', {
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2
    })
    expect(next.highlight.horizontal).toStrictEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(next.highlight.vertical).toStrictEqual(DEFAULT_OVERLAY_LAYOUT.highlight.vertical)
    expect(DEFAULT_OVERLAY_LAYOUT.highlight.horizontal).not.toStrictEqual(next.highlight.horizontal)
  })
})

describe('OverlayEdits', () => {
  it('commits one clamped layout per released gesture and keeps the draft until it lands', async () => {
    const commit = vi.fn<(layout: OverlayLayout) => Promise<void>>().mockResolvedValue()
    const changed = vi.fn()
    const edits = new OverlayEdits(commit, changed)
    edits.submit(DEFAULT_OVERLAY_LAYOUT, 'highlight', 'horizontal', {
      x: 0.95,
      y: 0.05,
      width: 0.4,
      height: 0.2
    })
    expect(edits.draft).toStrictEqual({
      item: 'highlight',
      orientation: 'horizontal',
      rect: { x: 0.6, y: 0.05, width: 0.4, height: 0.2 }
    })
    await flush()
    expect(commit).toHaveBeenCalledTimes(1)
    const sent = commit.mock.calls[0]![0]
    expect(sent.highlight.horizontal).toStrictEqual({ x: 0.6, y: 0.05, w: 0.4, h: 0.2 })
    expect(sent.buddy).toStrictEqual(DEFAULT_OVERLAY_LAYOUT.buddy)
    // The draft stays until the committed layout echoes the rect.
    edits.observe(DEFAULT_OVERLAY_LAYOUT)
    expect(edits.draft).not.toBeNull()
    edits.observe(sent)
    expect(edits.draft).toBeNull()
  })

  it('drops the draft when the commit fails', async () => {
    const commit = vi
      .fn<(layout: OverlayLayout) => Promise<void>>()
      .mockRejectedValue(new Error('offline'))
    const edits = new OverlayEdits(commit, () => {})
    edits.submit(DEFAULT_OVERLAY_LAYOUT, 'buddy', 'vertical', {
      x: 0.1,
      y: 0.1,
      width: 0.3,
      height: 0.2
    })
    expect(edits.draft?.item).toBe('buddy')
    await flush()
    await flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(edits.draft).toBeNull()
  })
})

describe('overlay failures are reported (plan 174, C-6)', () => {
  it('reports a failed gesture once and drops its draft', async () => {
    const offline = new Error('Backend socket is not connected.')
    const commit = vi.fn<(layout: OverlayLayout) => Promise<void>>().mockRejectedValue(offline)
    const failed = vi.fn()
    const edits = new OverlayEdits(commit, () => {}, failed)
    edits.submit(DEFAULT_OVERLAY_LAYOUT, 'captions', 'horizontal', {
      x: 0.1,
      y: 0.8,
      width: 0.8,
      height: 0.1
    })
    await flush()
    await flush()
    expect(edits.draft).toBeNull()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith(offline)
  })

  it('stays quiet about a gesture a newer intent already replaced', async () => {
    let reject: (error: Error) => void = () => {}
    const commit = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectCommit) => {
          reject = rejectCommit
        })
    )
    const failed = vi.fn()
    const edits = new OverlayEdits(commit, () => {})
    edits.configure(commit, failed)
    edits.submit(DEFAULT_OVERLAY_LAYOUT, 'buddy', 'horizontal', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2
    })
    await flush()
    edits.invalidate()
    reject(new Error('superseded'))
    await flush()
    await flush()
    expect(failed).not.toHaveBeenCalled()
  })

  it('gives the overlay controls one reason while the backend is away', () => {
    expect(overlayEditsBlockedReason('connected')).toBeNull()
    for (const status of ['waiting', 'connecting', 'failed', 'closed'] as const) {
      expect(overlayEditsBlockedReason(status)).toBe(OFFLINE_LOCK_REASON)
    }
  })
})

// Plan 186: banners are stage items too, under the overlay items.

const banner = (id: string, extra: Partial<Banner> = {}): Banner => ({
  id,
  name: id === 'sponsor' ? 'Sponsor' : id,
  imageFile: `${id}.png`,
  thumbnailFile: `${id}.thumb.png`,
  width: 2400,
  height: 400,
  hasAlpha: true,
  sortOrder: 0,
  shown: true,
  // The 6:1 strip's default places: they fit the image exactly.
  horizontal: { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 },
  vertical: { x: 0.071111, y: 0.699583, w: 0.857778, h: 0.080417 },
  showOnStream: true,
  showInRecording: true,
  opacity: 1,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra
})

const LANDSCAPE = 16 / 9
/** A 16:9 canvas on screen, in CSS px: what the gesture projects the aspect in. */
const PIXELS = { width: 1600, height: 900 }
const modifiers = { shiftKey: false, altKey: false }
/** The rect's aspect in canvas pixels. */
const pixelAspect = (rect: OverlayRect, canvasAspect = LANDSCAPE): number =>
  (rect.w * canvasAspect) / rect.h

describe('banners on the stage (plan 186)', () => {
  it('pins the banner stage id the backend draft matches', () => {
    expect(bannerStageId('3f1c')).toBe('banner:3f1c')
    expect(bannerIdFromStageId('banner:3f1c')).toBe('3f1c')
    expect(bannerIdFromStageId('banner:')).toBeNull()
    expect(bannerIdFromStageId('overlay:buddy')).toBeNull()
    expect(overlayItemFromStageId('banner:3f1c')).toBeNull()
  })

  it('lists the showing banners and the selected one, in Assets order', () => {
    const banners = [
      banner('sponsor', { sortOrder: 0, showInRecording: false }),
      banner('logo', { sortOrder: 1, shown: false, width: 512, height: 512 }),
      banner('follow', { sortOrder: 2, shown: false }),
      banner('frame', { sortOrder: 3, showOnStream: false, showInRecording: false })
    ]
    expect(bannerStageItems(banners, null, 'horizontal', LANDSCAPE).map((item) => item.id)).toEqual(
      ['sponsor', 'frame']
    )
    const items = bannerStageItems(banners, 'logo', 'horizontal', LANDSCAPE)
    expect(items.map((item) => item.id)).toEqual(['sponsor', 'logo', 'frame'])
    expect(items[0]).toMatchObject({
      kind: 'banner',
      stageId: 'banner:sponsor',
      label: 'Sponsor',
      badge: 'stream only',
      off: false,
      aspectLocked: true,
      rect: { x: 0.2, y: 0.782222, width: 0.6, height: 0.177778 }
    })
    // A selected hidden banner is dimmed and says so (the plan 174 "off" treatment).
    expect(items[1]).toMatchObject({ badge: 'hidden', off: true })
    expect(items[2]).toMatchObject({ badge: 'off', off: true })
  })

  it("draws a banner's rect around its image, in canvas units", () => {
    // The logo's place is wider than the logo: the rect hugs the square
    // picture at the place's right edge (its gravity).
    const [logo] = bannerStageItems(
      [
        banner('logo', {
          width: 512,
          height: 512,
          horizontal: { x: 0.5, y: 0.04, w: 0.48, h: 0.2 }
        })
      ],
      null,
      'horizontal',
      LANDSCAPE
    )
    expect(logo!.rect).toStrictEqual({ x: 0.8675, y: 0.04, width: 0.1125, height: 0.2 })
    // On the vertical stream the vertical rect is placed, in 9:16 units.
    const [vertical] = bannerStageItems([banner('sponsor')], null, 'vertical', 9 / 16)
    expect(vertical!.rect.width).toBe(0.857778)
    expect(pixelAspect(stageRectToOverlay(vertical!.rect), 9 / 16)).toBeCloseTo(6, 3)
  })

  it("takes the pointer on a banner's whole picture, unless it frames the canvas", () => {
    const [strip, frame] = bannerStageItems(
      [
        banner('sponsor'),
        banner('frame', { width: 1920, height: 1080, horizontal: { x: 0, y: 0, w: 1, h: 1 } })
      ],
      null,
      'horizontal',
      LANDSCAPE
    )
    expect(strip!.grabsBody).toBe(true)
    expect(frame!.grabsBody).toBe(false)
    // An overlay item is a zone over the sources: its label chip takes the pointer.
    for (const item of overlayStageItems(DEFAULT_OVERLAY_LAYOUT, 'horizontal'))
      expect(item.grabsBody).toBe(false)
  })

  it('snaps a banner to the other banners, never to the overlay zones', () => {
    const items = [
      ...bannerStageItems([banner('sponsor'), banner('logo')], null, 'horizontal', LANDSCAPE),
      ...overlayStageItems(DEFAULT_OVERLAY_LAYOUT, 'horizontal')
    ]
    expect(stageItemSnapPeers(items[0]!, items).map((item) => item.stageId)).toEqual([
      'banner:logo'
    ])
    // An overlay item still snaps to every other item, banners included.
    expect(stageItemSnapPeers(items[2]!, items).map((item) => item.stageId)).toEqual([
      'banner:sponsor',
      'banner:logo',
      'overlay:captions',
      'overlay:buddy'
    ])
  })

  it('drags the default banner across the canvas with the pointer', () => {
    // The default strip sits centred at the bottom, its right edge 1 px from
    // the Buddy's left edge on a small canvas: the drag the owner could not
    // make. The stage's real targets (a screen filling the canvas, the peers),
    // Snap on as in every preset layout, 1 CSS px per sample.
    const items = [
      ...bannerStageItems([banner('sponsor')], 'sponsor', 'horizontal', LANDSCAPE),
      ...overlayStageItems(DEFAULT_OVERLAY_LAYOUT, 'horizontal')
    ]
    const entry = items[0]!
    const pixels = { width: 458, height: 257.625 }
    const origin = { x: 0.5, y: 0.85 }
    const gesture = new StageGesture(
      entry.stageId,
      1,
      'move',
      entry.rect,
      origin,
      pixels,
      stageSnapTargets([
        { x: 0, y: 0, width: 1, height: 1 },
        ...stageItemSnapPeers(entry, items).map((item) => item.rect)
      ]),
      true,
      entry.aspectLocked,
      entry.aspectLocked
    )
    let x = entry.rect.x
    for (let step = 1; step <= 80; step++) {
      const next = gesture.sample({ x: origin.x + step / pixels.width, y: origin.y }, modifiers)
        .rect.x
      expect(next).toBeGreaterThanOrEqual(x - 1e-9)
      x = next
    }
    // Held by the centre for the release distance, then with the pointer.
    expect((x - entry.rect.x) * pixels.width).toBeGreaterThanOrEqual(80 - 10 - 1e-6)
  })

  it('commits one banners.update per drag, with an aspect-locked, clamped rect', async () => {
    const [entry] = bannerStageItems([banner('sponsor')], 'sponsor', 'horizontal', LANDSCAPE)
    const item = entry as BannerStageItem
    // The stage's gesture: a corner pulled up and left, Shift held for part of
    // it. A banner is aspect-locked and forced, so Shift never frees it.
    const gesture = new StageGesture(
      item.stageId,
      1,
      'nw',
      item.rect,
      { x: item.rect.x, y: item.rect.y },
      PIXELS,
      stageSnapTargets([]),
      false,
      item.aspectLocked,
      item.aspectLocked
    )
    gesture.sample({ x: item.rect.x - 0.05, y: item.rect.y - 0.3 }, modifiers)
    const released = gesture.sample(
      { x: item.rect.x - 0.15, y: item.rect.y - 0.02 },
      { shiftKey: true, altKey: false }
    ).rect
    const commit = vi.fn<
      (id: string, patch: Partial<Record<OverlayOrientation, OverlayRect>>) => Promise<unknown>
    >(async () => banner('sponsor'))
    const changed = vi.fn()
    const edits = new BannerEdits(commit, changed)
    edits.submit(item.id, 'horizontal', released)
    expect(edits.stageDraft('horizontal')?.stageId).toBe('banner:sponsor')
    expect(edits.stageDraft('vertical')).toBeNull()
    await flush()
    expect(commit).toHaveBeenCalledTimes(1)
    const [id, patch] = commit.mock.calls[0]!
    expect(id).toBe('sponsor')
    expect(Object.keys(patch)).toEqual(['horizontal'])
    const rect = patch.horizontal!
    // Bigger, still the image's 6:1 in canvas pixels, inside the canvas.
    expect(rect.w).toBeGreaterThan(0.6)
    expect(pixelAspect(rect)).toBeCloseTo(6, 2)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(1)
    expect(rect.y + rect.h).toBeLessThanOrEqual(1)
    expect(rect).toStrictEqual(stageRectToOverlay(released))
    // The update's reply is in the banner list: the draft is done.
    expect(edits.draft).toBeNull()
  })

  it('clamps a drag past the canvas edge before it reaches the wire', async () => {
    const commit = vi.fn(async () => banner('sponsor'))
    const edits = new BannerEdits(commit, () => {})
    edits.submit('sponsor', 'vertical', { x: 0.4, y: 0.98, width: 0.8, height: 0.001 })
    await flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('sponsor', {
      vertical: { x: 0.2, y: 0.98, w: 0.8, h: 0.02 }
    })
  })

  it('keeps the released rect until the list echoes it, and drops it on a failure', async () => {
    let finish: (value: Banner | null) => void = () => {}
    const commit = vi.fn(
      () =>
        new Promise<Banner | null>((resolve) => {
          finish = resolve
        })
    )
    const edits = new BannerEdits(commit, () => {})
    edits.submit('sponsor', 'horizontal', { x: 0.1, y: 0.1, width: 0.3, height: 0.05 })
    await flush()
    edits.observe([banner('sponsor')])
    expect(edits.draft).not.toBeNull()
    edits.observe([banner('sponsor', { horizontal: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 } })])
    expect(edits.draft).toBeNull()
    finish(banner('sponsor'))
    await flush()

    // A failed update (the hook has already said why) drops the draft.
    const failing = new BannerEdits(
      async () => null,
      () => {}
    )
    failing.submit('sponsor', 'horizontal', { x: 0.1, y: 0.1, width: 0.3, height: 0.05 })
    expect(failing.draft).not.toBeNull()
    await flush()
    await flush()
    expect(failing.draft).toBeNull()

    // A banner deleted meanwhile takes its draft with it.
    const orphan = new BannerEdits(
      () => new Promise(() => {}),
      () => {}
    )
    orphan.submit('gone', 'horizontal', { x: 0.1, y: 0.1, width: 0.3, height: 0.05 })
    orphan.observe([banner('sponsor')])
    expect(orphan.draft).toBeNull()
  })
})
