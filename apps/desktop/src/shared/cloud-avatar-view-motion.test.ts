// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { avatarHash, parseAvatarSnapshot } from './cloud-avatar'
import { restingDraw, type AvatarAtlasMeta } from './cloud-avatar-motion'
import { createAvatarView, type AvatarMotionSource } from './cloud-avatar-view'

/**
 * Plan 249 S5: the one avatar view draws an atlas layer from any motion
 * source: a program page's receiver, or the desktop's Program preview fed by
 * the producer's own simulation. A source that does not describe the atlas
 * on screen (another hash, nothing running) leaves the neutral cell at rest.
 */
/** A header-only PNG (the view checks the decoded size, stubbed below). */
function syntheticPng(width: number, height: number): string {
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const chunk = (type: number, data: number[]) => [
    ...u32(data.length),
    ...u32(type),
    ...data,
    ...u32(0)
  ]
  const bytes = [
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk(0x49484452, [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...chunk(0x49454e44, [])
  ]
  return btoa(String.fromCharCode(...bytes))
}

const WIDTH = 960
const HEIGHT = 800
const RECT = { x: 0.82, y: 0.72, w: 0.15, h: 0.27 }
const meta = {
  neutral: 'look-22',
  pivot: [0.5, 0.9],
  headTop: 0.2,
  talk: [],
  cells: [
    { id: 'look-22', kind: 'gaze', gaze: [0, 0], rect: [0, 0, 160, 160] },
    { id: 'wave', kind: 'reaction', gaze: null, rect: [160, 0, 160, 160] }
  ]
}

const drawn: string[] = []
beforeEach(() => {
  drawn.length = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  URL.createObjectURL = () => 'blob:avatar'
  URL.revokeObjectURL = () => {}
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(WIDTH)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(HEIGHT)
  // A recording 2D context: which atlas cell each paint reads from.
  const context = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'drawImage'
          ? (_image: unknown, sx: number) => drawn.push(sx === 0 ? 'look-22' : 'wave')
          : () => {}
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function snapshot() {
  const png = syntheticPng(WIDTH, HEIGHT)
  const hash = await avatarHash(Uint8Array.from(atob(png), (c) => c.charCodeAt(0)))
  const parsed = parseAvatarSnapshot(
    {
      version: 1,
      show: 'sh_avatar',
      publisherSid: 'PA_host',
      revision: 1,
      output: 'stream',
      orientation: 'h',
      expiresAt: 20_000,
      layers: [
        {
          kind: 'avatar',
          rect: RECT,
          asset: { png, hash, width: WIDTH, height: HEIGHT },
          expiresAt: null,
          atlas: meta
        }
      ]
    },
    { show: 'sh_avatar', publisherSid: 'PA_host', output: 'stream', orientation: 'h', now: 1000 }
  )
  if (!parsed) throw new Error('fixture snapshot invalid')
  return { parsed, hash }
}

describe('createAvatarView with a motion source (plan 249 S5)', () => {
  it("paints the source's pose for its atlas and rests on the neutral cell otherwise", async () => {
    const { parsed, hash } = await snapshot()
    const atlasMeta = parsed.layers[0]!.atlas as AvatarAtlasMeta
    let describes = hash
    let advanced = 0
    const source: AvatarMotionSource = {
      advance: () => void (advanced += 1),
      draw: (orientation, atlasHash) =>
        atlasHash === describes
          ? { ...restingDraw(atlasMeta, RECT, orientation), cell: 'wave' }
          : null,
      sim: { tick: 42 }
    }
    const root = document.createElement('div')
    const view = createAvatarView(root, () => 1000, { receiver: source, orientation: 'h' })
    view.receiver.owner('PA_host')
    await expect(view.receiver.accept(parsed)).resolves.toBe(true)
    const canvas = root.querySelector<HTMLCanvasElement>('canvas[data-avatar-layer="avatar"]')!
    expect(canvas).not.toBeNull()
    // The whole output, never the sheet itself.
    expect([canvas.width, canvas.height]).toEqual([1920, 1080])
    expect(root.querySelector('img')).toBeNull()

    view.step()
    expect(advanced).toBe(1)
    expect(canvas.dataset.avatarCell).toBe('wave')
    expect(canvas.dataset.avatarTick).toBe('42')
    expect(drawn.at(-1)).toBe('wave')

    // Another atlas (a persona switch not yet on screen): the neutral cell at rest.
    describes = 'b'.repeat(64)
    view.step()
    expect(canvas.dataset.avatarCell).toBe('look-22')
    expect(drawn.at(-1)).toBe('look-22')
    view.close()
    expect(root.childElementCount).toBe(0)
  })
})
