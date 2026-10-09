import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GOLEM_PET_FILE_MAX_BYTES,
  golemAssetUrl,
  golemBundledPackName,
  golemImageFormat,
  golemPackRelativePath,
  isGolemPackId,
  isGolemPetFileName,
  parseGolemAssetPath,
  parseGolemPackPath
} from '../shared/golem-assets'
import {
  importGolemImage,
  importGolemPetFolder,
  listGolemPersonas,
  readGolemImage,
  readGolemPetFile,
  readGolemCreationFile,
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

describe('golem pet pack store (plan 168 S-A2)', () => {
  const PACK = '0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a'

  it('accepts a pack path and refuses traversal and unknown files', () => {
    expect(parseGolemPackPath(`persona-1/pets/${PACK}/manifest.json`)).toEqual({
      personaId: 'persona-1',
      packId: PACK,
      file: 'manifest.json'
    })
    for (const file of [
      'golem.json',
      'build-report.json',
      'provenance.json',
      'mascot.webp',
      'gaze_up-2.png',
      'sources/gaze-level-v2.png'
    ]) {
      expect(parseGolemPackPath(golemPackRelativePath('p', PACK, file))?.file).toBe(file)
    }
    for (const path of [
      `p/pets/${PACK}/../manifest.json`,
      `p/pets/${PACK}/sources/../../x.png`,
      `p/pets/../${PACK}/manifest.json`,
      `../p/pets/${PACK}/manifest.json`,
      `/p/pets/${PACK}/manifest.json`,
      `p/pets/${PACK}/mascot.avif`,
      `p/pets/${PACK}/thumb.svg`,
      `p/pets/${PACK}/notes.json`,
      `p/pets/${PACK}/sources/pilot.webp`,
      `p/pets/${PACK}/sources/deep/pilot.png`,
      `p/pets/${PACK}/.DS_Store`,
      `p/pets/${PACK.toUpperCase()}/manifest.json`,
      `p/pets/bundled:golem/manifest.json`,
      `p/idle.png`,
      42
    ]) {
      expect(parseGolemPackPath(path)).toBeNull()
    }
  })

  it('names pack ids: lowercase uuids and bundled names only', () => {
    expect(isGolemPackId(PACK)).toBe(true)
    expect(isGolemPackId('bundled:golem')).toBe(true)
    expect(golemBundledPackName('bundled:golem')).toBe('golem')
    for (const id of [
      'bundled:',
      'bundled:../x',
      'bundled:Golem',
      'golem',
      PACK.toUpperCase(),
      ''
    ]) {
      expect(isGolemPackId(id)).toBe(false)
    }
    expect(isGolemPetFileName('sources/a.png')).toBe(true)
    expect(isGolemPetFileName('sources/a.webp')).toBe(false)
  })

  it('reads pack files from the write root and the bundled root, nothing else', async () => {
    const write = await root()
    const bundled = await root()
    const roots = { write, bundled }
    const folder = join(write, 'p', 'pets', PACK)
    await mkdir(join(folder, 'sources'), { recursive: true })
    await writeFile(join(folder, 'manifest.json'), '{"version":1}')
    await writeFile(join(folder, 'sources', 'pilot.png'), ONE_PIXEL_PNG)
    await writeFile(join(folder, 'notes.txt'), 'not a pack file')
    await mkdir(join(bundled, 'golem'), { recursive: true })
    await writeFile(join(bundled, 'golem', 'mascot.webp'), Buffer.from('RIFF0000WEBP'))

    const manifest = await readGolemPetFile(roots, 'p', PACK, 'manifest.json')
    expect(Buffer.from(manifest!).toString()).toBe('{"version":1}')
    expect(await readGolemPetFile(roots, 'p', PACK, 'sources/pilot.png')).not.toBeNull()
    expect(await readGolemPetFile(roots, 'p', 'bundled:golem', 'mascot.webp')).not.toBeNull()
    // Unknown files, other packs, other personas, traversal and bad ids.
    expect(await readGolemPetFile(roots, 'p', PACK, 'notes.txt')).toBeNull()
    expect(await readGolemPetFile(roots, 'p', PACK, 'golem.json')).toBeNull()
    expect(await readGolemPetFile(roots, 'q', PACK, 'manifest.json')).toBeNull()
    expect(await readGolemPetFile(roots, '../p', PACK, 'manifest.json')).toBeNull()
    expect(await readGolemPetFile(roots, 'p', 'bundled:../p', 'manifest.json')).toBeNull()
    expect(await readGolemPetFile(roots, 'p', PACK, '../../idle.png')).toBeNull()
    expect(await readGolemPetFile(roots, 'p', 'bundled:golem', 'manifest.json')).toBeNull()
  })

  it('refuses an oversize file and a link that leaves the root', async () => {
    const write = await root()
    const outside = await root()
    const folder = join(write, 'p', 'pets', PACK)
    await mkdir(folder, { recursive: true })
    const huge = join(folder, 'mascot.webp')
    await writeFile(huge, '')
    await truncate(huge, GOLEM_PET_FILE_MAX_BYTES + 1)
    expect(await readGolemPetFile({ write, bundled: outside }, 'p', PACK, 'mascot.webp')).toBeNull()
    await writeFile(join(outside, 'secret.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'secret.png'), join(folder, 'sheet.png'))
    expect(await readGolemPetFile({ write, bundled: outside }, 'p', PACK, 'sheet.png')).toBeNull()
  })

  it('ships the bundled root as golem-assets/bundled', () => {
    const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const builder = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/- from: resources\/golem\n\s+to: golem-assets\/bundled\n/)
    expect(existsSync(join(desktop, 'resources', 'golem'))).toBe(true)
  })
})

describe('golem pet folder import (plan 168 S-A3)', () => {
  const PACK = '0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a'
  const summary = {
    packId: PACK,
    name: 'Synthetic Pip',
    cellSize: 128,
    gazeCount: 2,
    reactions: ['laugh'],
    source: 'page-pet-import' as const,
    hasTalk: false
  }

  /** A picked folder: pack files, files that are not, and a link. */
  async function pickedFolder(): Promise<string> {
    const source = await root()
    await writeFile(join(source, 'manifest.json'), '{"version":1}')
    await writeFile(join(source, 'mascot.webp'), Buffer.from('RIFF0000WEBP'))
    await writeFile(join(source, 'build-report.json'), '{}')
    await writeFile(join(source, 'gaze-review.json'), '{}')
    await writeFile(join(source, '.DS_Store'), 'x')
    await mkdir(join(source, 'sources'))
    await writeFile(join(source, 'sources', 'pilot.png'), ONE_PIXEL_PNG)
    await writeFile(join(source, 'sources', 'notes.txt'), 'x')
    await mkdir(join(source, 'extra'))
    await writeFile(join(source, 'extra', 'other.png'), ONE_PIXEL_PNG)
    const outside = await root()
    await writeFile(join(outside, 'secret.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'secret.png'), join(source, 'linked.png'))
    return source
  }

  it('copies the pack files, skips the rest and registers the folder token', async () => {
    const base = await root()
    const source = await pickedFolder()
    const tokens: string[] = []
    const result = await importGolemPetFolder(
      source,
      base,
      'persona-1',
      async (token) => {
        tokens.push(token)
        return summary
      },
      () => PACK
    )
    expect(tokens).toEqual([`persona-1/pets/${PACK}`])
    expect(result).toEqual({
      pack: summary,
      skippedFiles: ['.DS_Store', 'extra', 'gaze-review.json', 'linked.png', 'sources/notes.txt']
    })
    const folder = join(base, 'persona-1', 'pets', PACK)
    expect((await readdir(folder)).sort()).toEqual([
      'build-report.json',
      'manifest.json',
      'mascot.webp',
      'sources'
    ])
    expect(await readdir(join(folder, 'sources'))).toEqual(['pilot.png'])
    expect(await readFile(join(folder, 'manifest.json'), 'utf8')).toBe('{"version":1}')
  })

  it('removes the copy when the backend refuses the pack', async () => {
    const base = await root()
    const source = await pickedFolder()
    await expect(
      importGolemPetFolder(
        source,
        base,
        'persona-1',
        async () => {
          throw new Error('Two-layer packs (separate head and body) are not supported.')
        },
        () => PACK
      )
    ).rejects.toThrow('Two-layer packs')
    expect(await readdir(join(base, 'persona-1', 'pets'))).toEqual([])
  })

  it('refuses a folder without a manifest, an oversize file and a bad persona', async () => {
    const base = await root()
    const register = async (): Promise<typeof summary> => summary
    const empty = await root()
    await writeFile(join(empty, 'mascot.webp'), Buffer.from('RIFF0000WEBP'))
    await expect(importGolemPetFolder(empty, base, 'p', register)).rejects.toThrow(
      'it has no manifest.json'
    )
    const huge = await root()
    await writeFile(join(huge, 'manifest.json'), '{}')
    await writeFile(join(huge, 'mascot.webp'), '')
    await truncate(join(huge, 'mascot.webp'), GOLEM_PET_FILE_MAX_BYTES + 1)
    await expect(importGolemPetFolder(huge, base, 'p', register)).rejects.toThrow(
      'Keep each file under 32 MB and the pack under 128 MB.'
    )
    await expect(importGolemPetFolder(huge, base, '../p', register)).rejects.toThrow(
      'The persona id is not a plain token.'
    )
    await expect(
      importGolemPetFolder(await pickedFolder(), base, 'p', register, () => 'not-a-uuid')
    ).rejects.toThrow('The pack id is not a uuid.')
    // Nothing was created for any refusal.
    expect(await listGolemPersonas(base)).toEqual([])
  })
})

describe('golem creation files for the creator wizard (plan 168 S-F5)', () => {
  const BUILD = '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90'

  it('reads sources and the build, and nothing else of the creation', async () => {
    const write = await root()
    const folder = join(write, 'p', 'creations', BUILD)
    await mkdir(join(folder, 'sources'), { recursive: true })
    await mkdir(join(folder, 'pack'), { recursive: true })
    await writeFile(join(folder, 'sources', 'gaze-level-v2.png'), ONE_PIXEL_PNG)
    await writeFile(join(folder, 'pack', 'mascot.webp'), ONE_PIXEL_PNG)
    await writeFile(join(folder, 'pack', 'manifest.json'), '{"version":1}')
    await writeFile(join(folder, 'build-state.json'), '{}')
    await writeFile(join(folder, 'pack', 'golem.json'), '{}')
    expect(await readGolemCreationFile(write, 'p', BUILD, 'sources/gaze-level-v2.png')).toEqual(
      new Uint8Array(ONE_PIXEL_PNG)
    )
    expect(await readGolemCreationFile(write, 'p', BUILD, 'pack/mascot.webp')).not.toBeNull()
    const manifest = await readGolemCreationFile(write, 'p', BUILD, 'pack/manifest.json')
    expect(Buffer.from(manifest!).toString()).toBe('{"version":1}')
    // The state file, other pack files, other personas and ids, traversal.
    expect(await readGolemCreationFile(write, 'p', BUILD, 'build-state.json')).toBeNull()
    expect(await readGolemCreationFile(write, 'p', BUILD, 'pack/golem.json')).toBeNull()
    expect(await readGolemCreationFile(write, 'q', BUILD, 'pack/mascot.webp')).toBeNull()
    expect(await readGolemCreationFile(write, '../p', BUILD, 'pack/mascot.webp')).toBeNull()
    expect(await readGolemCreationFile(write, 'p', '../creations', 'pack/mascot.webp')).toBeNull()
    expect(await readGolemCreationFile(write, 'p', BUILD, 'sources/../build-state.json')).toBeNull()
    expect(await readGolemCreationFile(write, 'p', BUILD, 'sources/missing-v1.png')).toBeNull()
  })

  it('refuses a link that leaves the root', async () => {
    const write = await root()
    const outside = await root()
    const sources = join(write, 'p', 'creations', BUILD, 'sources')
    await mkdir(sources, { recursive: true })
    await writeFile(join(outside, 'secret.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'secret.png'), join(sources, 'pilot-v1.png'))
    expect(await readGolemCreationFile(write, 'p', BUILD, 'sources/pilot-v1.png')).toBeNull()
  })
})
