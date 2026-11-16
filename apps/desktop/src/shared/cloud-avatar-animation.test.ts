import { describe, expect, it } from 'vitest'

import { avatarHash, parseAvatarCapability, parseAvatarSnapshot } from './cloud-avatar'
import { parseConsumerCapability } from '../renderer/src/lib/room-media-v2'

/** Plan 249 S5: the additive extensions of S4's contract. */

/** A header-only PNG of any size (S4's parser walks chunks; pixels never matter here). */
export function syntheticPng(width: number, height: number): string {
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const bytes = [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...u32(13),
    ...u32(0x49484452),
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u32(0x49454e44),
    ...u32(0)
  ]
  return btoa(String.fromCharCode(...bytes))
}

const GAZE = [-1, -0.5, 0, 0.5, 1]
const cells = [
  ...GAZE.flatMap((y, row) =>
    GAZE.map((x, col) => ({ id: `look-${col}${row}`, kind: 'gaze', gaze: [x, y] }))
  ),
  ...['wave', 'blink', 'sleep'].map((id) => ({ id, kind: 'reaction', gaze: null }))
]
const meta = {
  neutral: 'look-22',
  pivot: [0.5, 0.9],
  headTop: 0.2,
  talk: [],
  cells: cells.map((cell, i) => ({
    ...cell,
    rect: [(i % 6) * 160, Math.floor(i / 6) * 160, 160, 160]
  }))
}

async function atlasSnapshot(patch: { kind?: string; atlas?: unknown; width?: number } = {}) {
  const width = patch.width ?? 960
  const png = syntheticPng(width, 800)
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
  return {
    version: 1,
    show: 'sh_avatar',
    publisherSid: 'PA_host',
    revision: 3,
    output: 'stream',
    orientation: 'h',
    expiresAt: 20_000,
    layers: [
      {
        kind: patch.kind ?? 'avatar',
        rect: { x: 0.82, y: 0.72, w: 0.15, h: 0.27 },
        asset: { png, hash: await avatarHash(bytes), width, height: 800 },
        expiresAt: patch.kind === 'bubble' ? 10_000 : null,
        atlas: 'atlas' in patch ? patch.atlas : meta
      }
    ]
  }
}
const page = {
  show: 'sh_avatar',
  publisherSid: 'PA_host',
  output: 'stream' as const,
  orientation: 'h' as const,
  now: 1000
}

describe('S5 extensions of the S4 avatar contract', () => {
  it('keeps animation and static support together without inferring either', () => {
    expect(
      parseAvatarCapability({
        version: 1,
        output: 'stream',
        orientation: 'h',
        animation: 1,
        static: { version: 1 }
      })
    ).toEqual({
      version: 1,
      output: 'stream',
      orientation: 'h',
      animation: 1,
      static: { version: 1 }
    })
  })
  it('graphics.animation is optional, exactly 1, and survives the consumer parser', () => {
    expect(
      parseAvatarCapability({ version: 1, output: 'stream', orientation: 'h', animation: 1 })
    ).toEqual({ version: 1, output: 'stream', orientation: 'h', animation: 1 })
    expect(
      parseAvatarCapability({ version: 1, output: 'stream', orientation: 'h' })
    ).not.toHaveProperty('animation')
    expect(
      parseAvatarCapability({ version: 1, output: 'stream', orientation: 'h', animation: 2 })
    ).toBeNull()
    expect(
      parseAvatarCapability({ version: 1, output: 'stream', orientation: 'h', animation: true })
    ).toBeNull()
    expect(
      parseConsumerCapability({
        v: 2,
        identity: 'EG_x',
        participantSid: 'PA_x',
        graphics: { version: 1, output: 'recording', orientation: 'v', animation: 1 }
      })?.graphics
    ).toEqual({ version: 1, output: 'recording', orientation: 'v', animation: 1 })
  })

  it('an avatar layer may carry atlas meta that matches its PNG; nothing else may', async () => {
    const parsed = parseAvatarSnapshot(await atlasSnapshot(), page)
    expect(parsed?.layers[0]?.atlas?.cells).toHaveLength(28)
    const { atlas: _omit, ...withoutAtlas } = (await atlasSnapshot()).layers[0]!
    const plain = parseAvatarSnapshot({ ...(await atlasSnapshot()), layers: [withoutAtlas] }, page)
    expect(plain?.layers[0]).not.toHaveProperty('atlas')
    expect(parseAvatarSnapshot(await atlasSnapshot({ kind: 'bubble' }), page)).toBeNull()
    expect(parseAvatarSnapshot(await atlasSnapshot({ width: 900 }), page)).toBeNull() // a cell off the sheet
    expect(
      parseAvatarSnapshot(await atlasSnapshot({ atlas: { ...meta, neutral: 'wave' } }), page)
    ).toBeNull()
    expect(parseAvatarSnapshot(await atlasSnapshot({ atlas: null }), page)).toBeNull()
  })
})
