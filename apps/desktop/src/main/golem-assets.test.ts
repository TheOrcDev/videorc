import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { golemAssetUrl, golemImageFormat, parseGolemAssetPath } from '../shared/golem-assets'
import {
  importGolemImage,
  listGolemPersonas,
  readGolemImage,
  removeGolemPersona
} from './golem-assets'

/** The smallest real PNG: 1×1, 8-bit RGBA, transparent (67 bytes). */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

/** A JPEG SOI + SOF0 with dimensions, padded to `size` bytes. */
function jpegHeader(width: number, height: number, size = 64): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([255, 216, 255, 192, 0, 17, 8]).copy(bytes)
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'golem-assets-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const decodeOnePixel = (): { width: number; height: number } => ({ width: 1, height: 1 })

describe('golem avatar store (plan 164 S-A3)', () => {
  it('imports a 1×1 PNG into the persona folder and resolves a protocol URL', async () => {
    const base = await root()
    const source = join(base, 'picked.png')
    await writeFile(source, ONE_PIXEL_PNG)
    const result = await importGolemImage(source, base, 'persona-1', 'laugh', decodeOnePixel)
    expect(result).toEqual({
      personaId: 'persona-1',
      state: 'laugh',
      path: 'persona-1/laugh.png',
      url: 'videorc-asset://golem/persona-1/laugh.png',
      width: 1,
      height: 1
    })
    expect(await readFile(join(base, 'persona-1', 'laugh.png'))).toEqual(ONE_PIXEL_PNG)
    expect(golemAssetUrl(result.path)).toBe(result.url)
    expect(parseGolemAssetPath(result.path)).toEqual({
      personaId: 'persona-1',
      state: 'laugh',
      extension: 'png'
    })
    expect(await listGolemPersonas(base)).toEqual(['persona-1'])
  })

  it('reads a stored image back as bytes and nothing outside the root (S-C2)', async () => {
    const base = await root()
    const source = join(base, 'picked.png')
    await writeFile(source, ONE_PIXEL_PNG)
    const result = await importGolemImage(source, base, 'persona-1', 'idle', decodeOnePixel)
    const bytes = await readGolemImage(base, result.path)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes!)).toEqual(ONE_PIXEL_PNG)
    // A state with no file, a path that is not a managed path, and a
    // traversal are all null, never a throw.
    expect(await readGolemImage(base, 'persona-1/laugh.png')).toBeNull()
    expect(await readGolemImage(base, '../picked.png')).toBeNull()
    expect(await readGolemImage(base, 'persona-1/idle.svg')).toBeNull()
    expect(await readGolemImage(base, 42)).toBeNull()
  })

  it('rejects a 5 MB file with a named error and writes nothing', async () => {
    const base = await root()
    const source = join(base, 'huge.png')
    const huge = Buffer.alloc(5 * 1024 * 1024)
    ONE_PIXEL_PNG.copy(huge)
    await writeFile(source, huge)
    await expect(
      importGolemImage(source, base, 'persona-1', 'idle', decodeOnePixel)
    ).rejects.toThrow('Choose an image smaller than 4 MB.')
    await expect(readdir(join(base, 'persona-1'))).rejects.toThrow()
  })

  it('takes a JPEG for idle only, and refuses bytes that are not an image', async () => {
    const base = await root()
    const source = join(base, 'photo.jpg')
    await writeFile(source, jpegHeader(640, 480))
    const idle = await importGolemImage(source, base, 'p', 'idle', () => ({
      width: 640,
      height: 480
    }))
    expect(idle.path).toBe('p/idle.jpg')
    await expect(
      importGolemImage(source, base, 'p', 'talk', () => ({ width: 640, height: 480 }))
    ).rejects.toThrow('A JPEG has no transparency.')
    const text = join(base, 'notes.png')
    await writeFile(text, Buffer.from('<svg/>'))
    await expect(importGolemImage(text, base, 'p', 'idle', decodeOnePixel)).rejects.toThrow(
      'Choose a PNG, WebP or JPEG image.'
    )
    expect(() => golemImageFormat(new Uint8Array(0), 'idle')).toThrow('Choose an image file.')
  })

  it('keeps one file per state: a PNG upload replaces an earlier JPEG', async () => {
    const base = await root()
    const jpeg = join(base, 'photo.jpg')
    await writeFile(jpeg, jpegHeader(2, 2))
    await importGolemImage(jpeg, base, 'p', 'idle', () => ({ width: 2, height: 2 }))
    const png = join(base, 'art.png')
    await writeFile(png, ONE_PIXEL_PNG)
    const replaced = await importGolemImage(png, base, 'p', 'idle', decodeOnePixel)
    expect(replaced.path).toBe('p/idle.png')
    expect((await readdir(join(base, 'p'))).sort()).toEqual(['idle.png'])
  })

  it('refuses an id that is not a plain token, and removes a whole persona', async () => {
    const base = await root()
    const source = join(base, 'picked.png')
    await writeFile(source, ONE_PIXEL_PNG)
    await expect(
      importGolemImage(source, base, '../escape', 'idle', decodeOnePixel)
    ).rejects.toThrow('The persona id is not a plain token.')
    await importGolemImage(source, base, 'p', 'idle', decodeOnePixel)
    await removeGolemPersona(base, 'p')
    expect(await listGolemPersonas(base)).toEqual([])
    await expect(removeGolemPersona(base, 'p')).resolves.toBeUndefined()
    await expect(removeGolemPersona(base, 'a/b')).rejects.toThrow()
  })

  it('never resolves a path that reaches outside the managed root', () => {
    for (const path of ['../idle.png', 'p/../x/idle.png', '/p/idle.png', 'p/idle.svg', 'p/idle']) {
      expect(parseGolemAssetPath(path)).toBeNull()
      expect(golemAssetUrl(path)).toBeNull()
    }
  })
})
