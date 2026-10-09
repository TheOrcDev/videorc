import { describe, expect, it, vi } from 'vitest'

import type { OverlayLayout } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import {
  OverlayEdits,
  overlayItemFromStageId,
  overlayStageId,
  overlayStageItems,
  stageRectToOverlay,
  withOverlayRect
} from './overlay-stage'

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
      buddy: { ...DEFAULT_OVERLAY_LAYOUT.buddy, showOnStream: true, showInRecording: false }
    }
    const items = overlayStageItems(layout, 'vertical')
    expect(items.map((item) => item.item)).toEqual(['highlight', 'captions', 'buddy'])
    expect(items[2]).toMatchObject({
      stageId: 'overlay:buddy',
      label: 'Golem',
      badge: 'stream only',
      rect: {
        x: layout.buddy.vertical.x,
        y: layout.buddy.vertical.y,
        width: layout.buddy.vertical.w,
        height: layout.buddy.vertical.h
      }
    })
    expect(items[0]!.badge).toBeNull()
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
