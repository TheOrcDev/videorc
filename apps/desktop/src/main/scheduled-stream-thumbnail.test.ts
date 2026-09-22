import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importScheduledThumbnail, thumbnailFormat } from './scheduled-stream-thumbnail'

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
