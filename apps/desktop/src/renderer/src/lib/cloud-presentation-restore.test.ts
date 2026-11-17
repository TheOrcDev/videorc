import { describe, expect, it } from 'vitest'
import { restoredAvatarContent } from './cloud-presentation-restore'

const rect = { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }
const asset = { hash: 'a'.repeat(64), width: 64, height: 64, png: 'iVBORw0KGgo=' }

describe('restored avatar content (plan 249 S24)', () => {
  it('re-sends the kept avatar per orientation and output, never a bubble', () => {
    const content = restoredAvatarContent({
      controllerEpoch: 2,
      views: [
        {
          topic: 'avatar',
          output: 'stream',
          orientation: 'h',
          applied: false,
          layers: [
            { kind: 'avatar', rect, asset },
            { kind: 'bubble', rect, asset }
          ]
        },
        {
          topic: 'avatar',
          output: 'recording',
          orientation: 'v',
          layers: [{ kind: 'avatar', rect, asset }]
        },
        {
          topic: 'static',
          output: 'stream',
          orientation: 'h',
          layers: [{ kind: 'banner', rect, asset }]
        }
      ]
    })
    expect(content?.h).toEqual([{ kind: 'avatar', rect, asset, expiresAt: null }])
    expect(content?.v).toHaveLength(1)
    expect(content?.stream).toBe(true)
    expect(content?.recording).toBe(true)
  })
  it('the output flags carry over: an output turned off stays off', () => {
    const content = restoredAvatarContent({
      outputs: { avatar: { stream: false, recording: true } },
      views: [
        {
          topic: 'avatar',
          output: 'stream',
          orientation: 'h',
          layers: [{ kind: 'avatar', rect, asset }]
        },
        {
          topic: 'avatar',
          output: 'recording',
          orientation: 'h',
          layers: [{ kind: 'avatar', rect, asset }]
        }
      ]
    })
    expect(content?.stream).toBe(false)
    expect(content?.recording).toBe(true)
  })
  it('a kept clear, or pixels that did not come back, restore nothing', () => {
    expect(
      restoredAvatarContent({
        views: [{ topic: 'avatar', output: 'stream', orientation: 'h', layers: [] }]
      })
    ).toBeNull()
    const { png: _png, ...noPixels } = asset
    expect(
      restoredAvatarContent({
        views: [
          {
            topic: 'avatar',
            output: 'stream',
            orientation: 'h',
            layers: [{ kind: 'avatar', rect, asset: noPixels }]
          }
        ]
      })
    ).toBeNull()
  })
  it('a kept atlas comes back as the animated variant, at rest; a broken one is dropped', () => {
    const atlas = {
      neutral: 'n',
      pivot: [0.5, 0.9],
      headTop: 0.1,
      talk: [],
      cells: [{ id: 'n', kind: 'gaze', gaze: [0, 0], rect: [0, 0, 64, 64] }]
    }
    const view = (orientation: 'h' | 'v', layer: Record<string, unknown>) => ({
      topic: 'avatar' as const,
      output: 'stream' as const,
      orientation,
      layers: [{ kind: 'avatar', rect, asset, ...layer }]
    })
    const content = restoredAvatarContent({
      views: [view('h', { atlas }), view('v', {})]
    })
    expect(content?.animated?.h).toEqual([{ kind: 'avatar', rect, asset, expiresAt: null, atlas }])
    expect(content?.h).toEqual([])
    expect(content?.v).toHaveLength(1)
    expect(content?.animated?.v).toEqual([])
    // A cell outside its PNG: not drawn as a still either.
    const broken = { ...atlas, cells: [{ ...atlas.cells[0], rect: [0, 0, 128, 128] }] }
    expect(restoredAvatarContent({ views: [view('h', { atlas: broken })] })).toBeNull()
  })
})
