import { describe, expect, it } from 'vitest'

import { MotionReceiver, type MotionInputs } from '../../../shared/cloud-avatar-motion'
import {
  ATLAS_MAX_BASE64,
  atlasGrid,
  buildCloudAvatarAtlas,
  type AtlasCanvas
} from './cloud-avatar-atlas'
import {
  cloudAvatarAtlasReason,
  CloudAvatarAtlasRefusal,
  CLOUD_AVATAR_ATLAS_FAILED
} from './cloud-avatar-refusal'
import type { BuddyPreviewImage, BuddyPreviewPack } from './buddy-pet-preview-pack'
import { RoomAvatarMotion } from './room-avatar-motion'

const GAZE = [-1, -0.5, 0, 0.5, 1]

function previewPack(): BuddyPreviewPack {
  const sheet: BuddyPreviewImage = { source: {} as CanvasImageSource, width: 2000, height: 2000 }
  const frames: BuddyPreviewPack['frames'] = []
  const cells = new Map<
    string,
    {
      image: BuddyPreviewImage
      rect: [number, number, number, number]
      box: [number, number, number, number]
    }
  >()
  GAZE.forEach((y, row) =>
    GAZE.forEach((x, col) => {
      const id = `look-${col}${row}`
      frames.push({ id, kind: 'gaze', gaze: [x, y] })
      cells.set(id, { image: sheet, rect: [col * 200, row * 200, 200, 200], box: [0, 0, 1, 1] })
    })
  )
  for (const [i, id] of [
    'wave',
    'blink',
    'sleep',
    'surprised',
    'talk-a',
    'talk-b',
    'laugh'
  ].entries()) {
    frames.push({ id, kind: 'reaction' })
    cells.set(id, { image: sheet, rect: [i * 200, 1200, 200, 200], box: [0, 0.1, 1, 0.9] })
  }
  // A frame reusing the neutral's source cell shares its atlas cell.
  frames.push({ id: 'calm', kind: 'reaction' })
  cells.set('calm', cells.get('look-22')!)
  return {
    packId: 'bundled:test',
    name: 'Test',
    neutral: 'look-22',
    pivot: [0.5, 0.9],
    frames,
    cells,
    reactions: [],
    gazeCount: 25,
    headTop: 0.18,
    notes: []
  }
}

/** A recording canvas whose PNG size shrinks with the cell size. */
function fakeCanvas(bytesPerPixel: number) {
  const draws: number[][] = []
  const make = (width: number, height: number): AtlasCanvas => ({
    drawCell: (_image, _rect, _box, at) => void draws.push(at),
    encode: async () => {
      const size = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
      const header = btoa(
        String.fromCharCode(
          137,
          80,
          78,
          71,
          13,
          10,
          26,
          10,
          0,
          0,
          0,
          13,
          73,
          72,
          68,
          82,
          ...size(width),
          ...size(height)
        )
      )
      return header + 'A'.repeat(Math.ceil((width * height * bytesPerPixel) / 4) * 4)
    }
  })
  return { make, draws }
}

describe('cloud avatar atlas', () => {
  it('packs distinct cells once, names the talk frames and validates against the PNG', async () => {
    const { make, draws } = fakeCanvas(0.05)
    const atlas = await buildCloudAvatarAtlas(previewPack(), {
      canvas: make,
      hash: async () => 'f'.repeat(64)
    })
    expect(draws.length).toBe(32) // 25 gaze + 7 reactions; `calm` shares the neutral's cell
    expect(atlas.pack.talk).toEqual(['talk-a', 'talk-b'])
    expect(atlas.meta.cells.find((c) => c.id === 'calm')!.rect).toEqual(
      atlas.meta.cells.find((c) => c.id === 'look-22')!.rect
    )
    expect(atlas.width).toBeLessThanOrEqual(1024)
    expect(atlas.png.length).toBeLessThanOrEqual(ATLAS_MAX_BASE64)
    expect(atlasGrid(32, 256)).toEqual({ cols: 6, rows: 6, cellPx: 170 })
  })

  it('steps the cell size down to fit S4 limits, and refuses rather than relaxing them', async () => {
    const fits = await buildCloudAvatarAtlas(previewPack(), {
      canvas: fakeCanvas(0.6).make,
      hash: async () => 'f'.repeat(64)
    })
    expect(fits.meta.cells[0].rect[2]).toBeLessThan(170)
    const refused = await buildCloudAvatarAtlas(previewPack(), {
      canvas: fakeCanvas(40).make,
      hash: async () => 'f'.repeat(64)
    }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CloudAvatarAtlasRefusal)
    // The streamer reads why under the Program preview, not in the console.
    expect(cloudAvatarAtlasReason(refused)).toBe(
      'The avatar shows still on cloud outputs: it is too detailed to animate there.'
    )
    expect(cloudAvatarAtlasReason(new Error('raster'))).toBe(CLOUD_AVATAR_ATLAS_FAILED)
  })
})

const INPUTS: MotionInputs = {
  avatarState: 'idle',
  rects: { h: { x: 0.82, y: 0.72, w: 0.125, h: 0.25 }, v: { x: 0.05, y: 0.82, w: 0.22, h: 0.125 } },
  cards: { h: null, v: null },
  atlasHash: 'a'.repeat(64),
  pack: {
    neutral: 'look-22',
    pivot: [0.5, 0.9],
    headTop: 0.2,
    talk: [],
    cells: [
      { id: 'look-22', kind: 'gaze', gaze: [0, 0] },
      { id: 'wave', kind: 'reaction', gaze: null }
    ]
  }
}

describe('RoomAvatarMotion', () => {
  it('sends only to authorized consumers, keyframes newcomers, and a consumer draws what the desktop simulates', async () => {
    let now = 1_700_000_000_000
    const sent: { bytes: Uint8Array; to: string[] }[] = []
    const motion = new RoomAvatarMotion(
      {
        show: 'show-1',
        publisherSid: 'PA_host',
        now: () => now,
        send: async (bytes, to) => void sent.push({ bytes, to }),
        random: () => new Uint8Array(12).fill(7)
      },
      { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      INPUTS
    )
    await motion.flush()
    expect(sent).toEqual([]) // nobody authorized yet
    motion.setConsumers(['EG_stream'])
    const receiver = new MotionReceiver({ show: 'show-1', now: () => now })
    receiver.owner('PA_host')
    for (let i = 0; i < 60; i += 1) {
      now += 100
      if (i === 10)
        motion.backend({
          avatarState: 'idle',
          event: { kind: 'reaction', chain: ['wave'], activity: true }
        })
      await motion.flush()
      for (const message of sent.splice(0)) {
        expect(message.to).toEqual(['EG_stream'])
        expect(receiver.receive(JSON.parse(new TextDecoder().decode(message.bytes)))).toBe(true)
      }
      receiver.advance()
    }
    // The consumer lags by the playout delay; stepped to the desktop's tick it draws the same thing.
    expect(receiver.sim!.tick).toBeLessThan(motion.sim.tick)
    receiver.sim!.advanceTo(motion.sim.tick)
    expect(receiver.sim!.draw('h')).toEqual(motion.sim.draw('h'))
    expect(receiver.sim!.draw('v')).toEqual(motion.sim.draw('v'))
    expect(motion.status()).toMatchObject({ consumers: 1, failed: null })
  })

  it('a failed send keeps going and forces a keyframe; close stops everything', async () => {
    let fail = true
    let calls = 0
    const motion = new RoomAvatarMotion(
      {
        show: 'show-1',
        publisherSid: 'PA_host',
        now: () => 1_700_000_000_000 + calls * 100,
        send: async () => {
          calls += 1
          if (fail) throw new Error('down')
        }
      },
      { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      INPUTS
    )
    motion.setConsumers(['EG_a'])
    await motion.flush()
    expect(motion.status().failed).toMatch(/^Couldn't send the avatar's motion/)
    fail = false
    await motion.flush()
    expect(motion.status().failed).toBeNull()
    motion.close()
    const before = calls
    await motion.flush()
    expect(calls).toBe(before)
  })
})
