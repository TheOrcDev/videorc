import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { importScheduledThumbnail, thumbnailFormat } from './scheduled-stream-thumbnail'

/** A PNG signature + IHDR dimensions, padded to `size` bytes. */
function pngHeader(width: number, height: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** A JPEG SOI + SOF0 with dimensions, padded to `size` bytes. */
function jpegHeader(width: number, height: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([255, 216, 255, 192, 0, 17, 8]).copy(bytes)
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

describe('scheduled thumbnail boundary', () => {
  it('rejects modified existing managed copies before registering authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-thumbnail-'))
    try {
      const bytes = Buffer.alloc(40)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
      bytes.writeUInt32BE(1280, 16)
      bytes.writeUInt32BE(720, 20)
      const source = join(root, 'source.png')
      await writeFile(source, bytes)
      const managed = join(root, 'managed')
      let registrations = 0
      const register = async () => {
        registrations++
      }
      const saved = await importScheduledThumbnail(
        source,
        managed,
        () => ({ width: 1280, height: 720 }),
        register
      )
      await writeFile(join(managed, `${saved.id}.png`), 'tampered')
      await expect(
        importScheduledThumbnail(source, managed, () => ({ width: 1280, height: 720 }), register)
      ).rejects.toThrow('contents changed')
      expect(registrations).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects empty, spoofed, oversized and animated images', () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from('<svg/>'),
      Buffer.alloc(2 * 1024 * 1024 + 1)
    ]) {
      expect(() => thumbnailFormat(bytes)).toThrow()
    }
    const png = Buffer.alloc(40)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.writeUInt32BE(1280, 16)
    png.writeUInt32BE(720, 20)
    expect(thumbnailFormat(png)).toBe('png')
    png.write('acTL', 26)
    expect(() => thumbnailFormat(png)).toThrow('Animated')
  })
  it('stores a source at or under 2 MB byte-identical and never fits it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-thumbnail-'))
    try {
      const bytes = pngHeader(1920, 1080, 1024 * 1024)
      const source = join(root, 'small.png')
      await writeFile(source, bytes)
      const fit = vi.fn(() => Buffer.alloc(0))
      const saved = await importScheduledThumbnail(
        source,
        join(root, 'managed'),
        () => ({ width: 1920, height: 1080 }),
        async () => undefined,
        fit
      )
      expect(saved.id).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(fit).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fits a source over 2 MB into a JPEG, stepping quality down until it fits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-thumbnail-'))
    try {
      const source = join(root, 'big.png')
      await writeFile(source, pngHeader(3840, 2160, 5 * 1024 * 1024))
      const fitted = jpegHeader(1280, 720, 300_000)
      const fit = vi.fn((_bytes: Buffer, quality: number) =>
        quality === 90 ? jpegHeader(1280, 720, 3 * 1024 * 1024) : fitted
      )
      const managed = join(root, 'managed')
      const saved = await importScheduledThumbnail(
        source,
        managed,
        () => ({ width: 1280, height: 720 }),
        async () => undefined,
        fit
      )
      expect(fit.mock.calls.map(([, quality]) => quality)).toEqual([90, 80])
      expect(saved.id).toBe(createHash('sha256').update(fitted).digest('hex'))
      expect(saved.width).toBeLessThanOrEqual(1280)
      expect((await readFile(join(managed, `${saved.id}.jpg`))).equals(fitted)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a source over 50 MB, over 20 megapixels, or one that never fits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-thumbnail-'))
    const managed = join(root, 'managed')
    const decode = () => ({ width: 1280, height: 720 })
    const register = async () => undefined
    try {
      const huge = join(root, 'huge.png')
      await writeFile(huge, pngHeader(1280, 720, 50 * 1024 * 1024 + 1))
      const fit = vi.fn(() => jpegHeader(1280, 720, 1000))
      await expect(importScheduledThumbnail(huge, managed, decode, register, fit)).rejects.toThrow(
        'smaller than 50 MB'
      )

      const dense = join(root, 'dense.png')
      await writeFile(dense, pngHeader(6000, 4200, 3 * 1024 * 1024))
      await expect(importScheduledThumbnail(dense, managed, decode, register, fit)).rejects.toThrow(
        '20 megapixels'
      )
      expect(fit).not.toHaveBeenCalled()

      const stubborn = join(root, 'stubborn.png')
      await writeFile(stubborn, pngHeader(3840, 2160, 3 * 1024 * 1024))
      await expect(
        importScheduledThumbnail(stubborn, managed, decode, register, () =>
          jpegHeader(1280, 720, 3 * 1024 * 1024)
        )
      ).rejects.toThrow('could not be reduced to 2 MB')

      // Without a fitter (the smoke import) the 2 MB cap still applies.
      await expect(importScheduledThumbnail(stubborn, managed, decode, register)).rejects.toThrow(
        'smaller than 2 MB'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks JPEG dimensions before native decoding', () => {
    const jpeg = Buffer.from([
      255, 216, 255, 192, 0, 17, 8, 2, 208, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])
    expect(thumbnailFormat(jpeg)).toBe('jpg')
    jpeg.writeUInt16BE(65535, 7)
    jpeg.writeUInt16BE(65535, 9)
    expect(() => thumbnailFormat(jpeg)).toThrow('megapixels')
  })
})
