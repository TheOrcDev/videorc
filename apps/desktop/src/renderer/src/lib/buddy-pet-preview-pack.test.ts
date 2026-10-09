import { describe, expect, it, vi } from 'vitest'

import { identityTransform } from '../../../shared/buddy-motion'
import {
  containBottomBox,
  disposeBuddyPreviewPack,
  drawBuddyPreviewFrame,
  loadBuddyPreviewPack,
  type BuddyPreviewContext,
  type BuddyPreviewImage,
  type BuddyPreviewPackDeps
} from './buddy-pet-preview-pack'

vi.mock('@/assets/buddy/default/idle.webp', () => ({ default: 'bundled:idle.webp' }))

const encoder = new TextEncoder()

/** A synthetic two-cell pack: one gaze cell and one reaction, 256 px cells. */
const MANIFEST = {
  version: 1,
  name: 'Pebble',
  neutral: 'ahead',
  pivot: [0.5, 0.85],
  frames: [
    { id: 'ahead', kind: 'gaze', sheet: 'pet.webp', rect: [0, 0, 256, 256], gaze: [0, 0] },
    { id: 'laugh', kind: 'reaction', sheet: 'pet.webp', rect: [256, 0, 256, 256] }
  ]
}

function image(width: number, height: number, name = `${width}x${height}`): BuddyPreviewImage {
  return {
    source: { name } as unknown as CanvasImageSource,
    width,
    height,
    close: vi.fn()
  }
}

function deps(files: Record<string, Uint8Array | null>, sheet = image(512, 256)) {
  const scaled: BuddyPreviewImage[] = []
  const reads: string[] = []
  const fake: BuddyPreviewPackDeps = {
    readPackFile: vi.fn(async (_persona: string, _pack: string, file: string) => {
      reads.push(file)
      return files[file] ?? null
    }),
    decode: vi.fn(async () => sheet),
    loadUrl: vi.fn(async (url: string) => image(url.endsWith('laugh.webp') ? 400 : 200, 200, url)),
    scaleCell: vi.fn(async (_image, _rect, _box, pixelSize: number) => {
      const cell = image(pixelSize, pixelSize, `cell-${scaled.length}`)
      scaled.push(cell)
      return cell
    })
  }
  return { fake, scaled, reads, sheet }
}

describe('loadBuddyPreviewPack: a pet pack', () => {
  it('reads the manifest and its sheets through main, cuts one cell per frame and frees the sheet', async () => {
    const { fake, scaled, reads, sheet } = deps({
      'manifest.json': encoder.encode(JSON.stringify(MANIFEST)),
      'pet.webp': new Uint8Array([1, 2, 3])
    })
    const pack = await loadBuddyPreviewPack(
      { personaId: 'p-1', packId: 'a2f6d3a8-9c47-4b6e-8f0d-1c2b3a4d5e6f', pixelSize: 320 },
      fake
    )
    expect(reads).toEqual(['manifest.json', 'pet.webp'])
    expect(fake.readPackFile).toHaveBeenCalledWith(
      'p-1',
      'a2f6d3a8-9c47-4b6e-8f0d-1c2b3a4d5e6f',
      'manifest.json'
    )
    expect(pack).toMatchObject({
      name: 'Pebble',
      neutral: 'ahead',
      pivot: [0.5, 0.85],
      reactions: ['laugh'],
      gazeCount: 1
    })
    expect(pack.frames).toEqual([
      { id: 'ahead', kind: 'gaze', gaze: [0, 0] },
      { id: 'laugh', kind: 'reaction' }
    ])
    expect(fake.scaleCell).toHaveBeenCalledWith(sheet, [256, 0, 256, 256], [0, 0, 1, 1], 320)
    expect(pack.cells.get('laugh')?.image).toBe(scaled[1])
    expect(sheet.close).toHaveBeenCalledTimes(1)
    disposeBuddyPreviewPack(pack)
    for (const cell of scaled) expect(cell.close).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing file, a bad manifest or a frame outside its sheet, with a plain reason', async () => {
    const missing = deps({ 'manifest.json': encoder.encode(JSON.stringify(MANIFEST)) })
    await expect(
      loadBuddyPreviewPack({ personaId: 'p', packId: 'bundled:buddy', pixelSize: 64 }, missing.fake)
    ).rejects.toThrow('This pack is missing pet.webp. Import it again.')

    const layered = deps({
      'manifest.json': encoder.encode(JSON.stringify({ ...MANIFEST, layers: { size: 256 } }))
    })
    await expect(
      loadBuddyPreviewPack({ personaId: 'p', packId: 'bundled:buddy', pixelSize: 64 }, layered.fake)
    ).rejects.toThrow('Two-layer packs')

    const small = deps(
      {
        'manifest.json': encoder.encode(JSON.stringify(MANIFEST)),
        'pet.webp': new Uint8Array([1])
      },
      image(300, 256)
    )
    await expect(
      loadBuddyPreviewPack({ personaId: 'p', packId: 'bundled:buddy', pixelSize: 64 }, small.fake)
    ).rejects.toThrow('Frame laugh is outside its sheet.')
    expect(small.sheet.close).toHaveBeenCalledTimes(1)

    const none = deps({})
    await expect(
      loadBuddyPreviewPack({ personaId: 'p', packId: 'bundled:buddy', pixelSize: 64 }, none.fake)
    ).rejects.toThrow('This pack has no manifest.json.')
  })

  it('stops and frees what it decoded when the load is cancelled', async () => {
    const controller = new AbortController()
    const { fake, sheet } = deps({
      'manifest.json': encoder.encode(JSON.stringify(MANIFEST)),
      'pet.webp': new Uint8Array([1])
    })
    fake.decode = vi.fn(async () => {
      controller.abort()
      return sheet
    })
    await expect(
      loadBuddyPreviewPack(
        { personaId: 'p', packId: 'bundled:buddy', pixelSize: 64, signal: controller.signal },
        fake
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sheet.close).toHaveBeenCalled()
  })
})

describe('the head top (D16, for the Test dialog bubble)', () => {
  it("measures the neutral cell's first row with alpha above 16, else 0", async () => {
    const files = {
      'manifest.json': encoder.encode(JSON.stringify(MANIFEST)),
      'pet.webp': new Uint8Array([1, 2, 3])
    }
    const { fake, scaled } = deps(files)
    const read = vi.fn((_cell, side: number) => {
      const data = new Uint8ClampedArray(side * side * 4)
      // A faint row (alpha 16) at 10 %, the silhouette from 25 %.
      for (let col = 0; col < side; col += 1)
        data[(Math.round(side * 0.1) * side + col) * 4 + 3] = 16
      data[(Math.round(side * 0.25) * side + side / 2) * 4 + 3] = 200
      return { width: side, height: side, data }
    })
    const pack = await loadBuddyPreviewPack(
      { personaId: 'p-1', packId: 'bundled:buddy', pixelSize: 320 },
      { ...fake, readCellPixels: read }
    )
    expect(pack.headTop).toBe(0.25)
    // The neutral cell, not the reaction.
    expect(read.mock.calls[0]?.[0]?.image).toBe(scaled[0])
    // A host that cannot read pixels anchors at the top of the box.
    const blind = await loadBuddyPreviewPack(
      { personaId: 'p-1', packId: 'bundled:buddy', pixelSize: 320 },
      { ...deps(files).fake, readCellPixels: () => null }
    )
    expect(blind.headTop).toBe(0)
  })
})

describe('loadBuddyPreviewPack: Still (D2 flat pack)', () => {
  it('builds idle as the one gaze cell and talk, laugh, think as reactions falling back to idle', async () => {
    const { fake } = deps({})
    const pack = await loadBuddyPreviewPack(
      {
        personaId: 'p-1',
        packId: 'still',
        stillImages: { idle: 'p-1/idle.png', laugh: 'p-1/laugh.webp' },
        pixelSize: 64
      },
      fake
    )
    expect(pack.frames).toEqual([
      { id: 'idle', kind: 'gaze', gaze: [0, 0] },
      { id: 'talk', kind: 'reaction' },
      { id: 'laugh', kind: 'reaction' },
      { id: 'think', kind: 'reaction' }
    ])
    expect(pack.reactions).toEqual(['talk', 'laugh', 'think'])
    expect(pack.pivot).toEqual([0.5, 0.9])
    // talk and think reuse the idle image; laugh is its own, contained bottom-aligned.
    expect(fake.loadUrl).toHaveBeenCalledTimes(2)
    expect(fake.scaleCell).toHaveBeenCalledWith(
      expect.objectContaining({ width: 400 }),
      [0, 0, 400, 200],
      [0, 0.5, 1, 0.5],
      64
    )
    expect(fake.readPackFile).not.toHaveBeenCalled()
  })

  it('shows the bundled default when the idle image will not load, and says so', async () => {
    const { fake } = deps({})
    fake.loadUrl = vi.fn(async (url: string) => {
      if (url.startsWith('videorc-asset://')) throw new Error('gone')
      return image(711, 640, url)
    })
    const pack = await loadBuddyPreviewPack(
      { personaId: 'p-1', packId: 'still', stillImages: { idle: 'p-1/idle.png' }, pixelSize: 64 },
      fake
    )
    expect(fake.loadUrl).toHaveBeenLastCalledWith('bundled:idle.webp')
    expect(pack.notes[0]).toBe('The idle image would not load; the default Buddy shows instead.')
    expect(pack.cells.size).toBe(4)
  })

  it('contains an image bottom-aligned in its square cell', () => {
    expect(containBottomBox(400, 200)).toEqual([0, 0.5, 1, 0.5])
    expect(containBottomBox(200, 400)).toEqual([0.25, 0, 0.5, 1])
    expect(containBottomBox(300, 300)).toEqual([0, 0, 1, 1])
  })
})

describe('drawBuddyPreviewFrame', () => {
  function recorder(): BuddyPreviewContext & { calls: unknown[][] } {
    const calls: unknown[][] = []
    const record =
      (name: string) =>
      (...args: unknown[]): void => {
        calls.push([name, ...args])
      }
    return {
      calls,
      setTransform: record('setTransform') as BuddyPreviewContext['setTransform'],
      transform: record('transform') as BuddyPreviewContext['transform'],
      translate: record('translate') as BuddyPreviewContext['translate'],
      clearRect: record('clearRect') as BuddyPreviewContext['clearRect'],
      drawImage: record('drawImage') as BuddyPreviewContext['drawImage'],
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low'
    }
  }

  it('clears, then draws the cell with the motion matrix about pivot × size inside the margin', () => {
    const context = recorder()
    const cell = { image: image(64, 64), rect: [0, 0, 64, 64], box: [0, 0, 1, 1] } as const
    const transform = {
      ...identityTransform([0.5, 0.9]),
      translateY: -4,
      scaleX: 1.1,
      scaleY: 1 / 1.1
    }
    drawBuddyPreviewFrame(context, { width: 240, height: 240 }, cell, transform, {
      size: 80,
      margin: 20,
      dpr: 2
    })
    expect(context.calls).toEqual([
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['clearRect', 0, 0, 240, 240],
      ['setTransform', 2, 0, 0, 2, 40, 40],
      ['translate', 40, 72],
      ['transform', 1.1, 0, 0, 1 / 1.1, 0, -4],
      ['translate', -40, -72],
      ['drawImage', cell.image.source, 0, 0, 64, 64, 0, 0, 80, 80]
    ])
    expect(context.imageSmoothingQuality).toBe('high')
  })

  it('only clears when the frame has no cell', () => {
    const context = recorder()
    drawBuddyPreviewFrame(
      context,
      { width: 10, height: 10 },
      undefined,
      identityTransform([0.5, 0.9]),
      {
        size: 6,
        margin: 2,
        dpr: 1
      }
    )
    expect(context.calls.map(([name]) => name)).toEqual(['setTransform', 'clearRect'])
  })
})
