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
  BUDDY_PET_FILE_MAX_BYTES,
  buddyAssetUrl,
  buddyBundledPackName,
  buddyPackRelativePath,
  isBuddyPackId,
  isBuddyPetFileName,
  parseBuddyAssetPath,
  parseBuddyDraftPath,
  parseBuddyPackPath
} from '../shared/buddy-assets'
import {
  BUDDY_ASSETS_FOLDER,
  importBuddyPetFolder,
  LEGACY_BUDDY_ASSETS_FOLDER,
  listBuddyPersonas,
  moveLegacyBuddyAssets,
  readBuddyImage,
  readBuddyPetFile,
  readBuddyCreationFile,
  removeBuddyPersona
} from './buddy-assets'

/** The smallest real PNG: 1×1, 8-bit RGBA, transparent (67 bytes). */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'buddy-assets-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** A stored persona image, as the backend writes a kept look (plan 169). */
async function storeImage(base: string, personaId: string, file: string): Promise<string> {
  await mkdir(join(base, personaId), { recursive: true })
  await writeFile(join(base, personaId, file), ONE_PIXEL_PNG)
  return `${personaId}/${file}`
}

describe('buddy avatar store (plan 164 S-A3, plan 169 D8)', () => {
  it('resolves a persona image to a protocol URL and lists the persona', async () => {
    const base = await root()
    const path = await storeImage(base, 'persona-1', 'laugh.png')
    expect(buddyAssetUrl(path)).toBe('videorc-asset://buddy/persona-1/laugh.png')
    expect(parseBuddyAssetPath(path)).toEqual({
      personaId: 'persona-1',
      state: 'laugh',
      extension: 'png',
      file: 'laugh.png'
    })
    expect(await listBuddyPersonas(base)).toEqual(['persona-1'])
  })

  it('takes a kept look by its tagged name, and reads it back (plan 169)', async () => {
    const base = await root()
    const path = await storeImage(base, 'persona-1', 'idle-3f2a1c4e.png')
    expect(parseBuddyAssetPath(path)).toEqual({
      personaId: 'persona-1',
      state: 'idle',
      extension: 'png',
      file: 'idle-3f2a1c4e.png'
    })
    expect(buddyAssetUrl(path)).toBe('videorc-asset://buddy/persona-1/idle-3f2a1c4e.png')
    expect(Buffer.from((await readBuddyImage(base, path))!)).toEqual(ONE_PIXEL_PNG)
    for (const bad of [
      'persona-1/idle-3F2A1C4E.png',
      'persona-1/idle-3f2a.png',
      'persona-1/idle-3f2a1c4e9.png',
      'persona-1/idler.png',
      'persona-1/idle-../x.png'
    ]) {
      expect(parseBuddyAssetPath(bad)).toBeNull()
    }
  })

  it('reads a stored image back as bytes and nothing outside the root (S-C2)', async () => {
    const base = await root()
    const path = await storeImage(base, 'persona-1', 'idle.png')
    const bytes = await readBuddyImage(base, path)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes!)).toEqual(ONE_PIXEL_PNG)
    // A state with no file, a path that is not a managed path, a traversal
    // and a draft picture are all null, never a throw.
    expect(await readBuddyImage(base, 'persona-1/laugh.png')).toBeNull()
    expect(await readBuddyImage(base, '../picked.png')).toBeNull()
    expect(await readBuddyImage(base, 'persona-1/idle.svg')).toBeNull()
    expect(await readBuddyImage(base, 42)).toBeNull()
    expect(
      await readBuddyImage(base, 'persona-1/drafts/3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8/idle.png')
    ).toBeNull()
  })

  it('refuses an image over the read cap', async () => {
    const base = await root()
    await mkdir(join(base, 'p'), { recursive: true })
    const huge = Buffer.alloc(5 * 1024 * 1024)
    ONE_PIXEL_PNG.copy(huge)
    await writeFile(join(base, 'p', 'idle.png'), huge)
    expect(await readBuddyImage(base, 'p/idle.png')).toBeNull()
  })

  it('refuses an id that is not a plain token, and removes a whole persona', async () => {
    const base = await root()
    await storeImage(base, 'p', 'idle.png')
    await removeBuddyPersona(base, 'p')
    expect(await listBuddyPersonas(base)).toEqual([])
    await expect(removeBuddyPersona(base, 'p')).resolves.toBeUndefined()
    await expect(removeBuddyPersona(base, 'a/b')).rejects.toThrow()
    await expect(removeBuddyPersona(base, '../escape')).rejects.toThrow(
      'The persona id is not a plain token.'
    )
  })

  it('never resolves a path that reaches outside the managed root', () => {
    for (const path of ['../idle.png', 'p/../x/idle.png', '/p/idle.png', 'p/idle.svg', 'p/idle']) {
      expect(parseBuddyAssetPath(path)).toBeNull()
      expect(buddyAssetUrl(path)).toBeNull()
    }
  })

  it("serves a draft look's pictures by their own path rule (plan 169 D8)", () => {
    const id = '3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8'
    const draft = `persona-1/drafts/${id}/talk.png`
    expect(parseBuddyDraftPath(draft)).toEqual({
      personaId: 'persona-1',
      requestId: id,
      state: 'talk'
    })
    // Never a persona image: the persona stores `<id>/<state>.<ext>` only.
    expect(parseBuddyAssetPath(draft)).toBeNull()
    expect(buddyAssetUrl(draft)).toBe(`videorc-asset://buddy/${draft}`)
    // A redone pose keeps its path; the panel versions the URL.
    expect(buddyAssetUrl(`${draft}?v=2`)).toBe(`videorc-asset://buddy/${draft}?v=2`)
    expect(buddyAssetUrl('persona-1/talk.png?v=2')).toBeNull()
    for (const bad of [
      `persona-1/drafts/${id}/talk.webp`,
      `persona-1/drafts/${id.toUpperCase()}/talk.png`,
      `persona-1/drafts/${id}/../talk.png`,
      `persona-1/drafts/x/talk.png`,
      `persona-1/drafts/${id}/failed.json`,
      `../drafts/${id}/idle.png`,
      `persona-1/drafts/.staging-${id}/idle.png`,
      `${draft}?v=x`
    ]) {
      expect(parseBuddyDraftPath(bad)).toBeNull()
      expect(buddyAssetUrl(bad)).toBeNull()
    }
  })
})

describe('buddy pet pack store (plan 168 S-A2)', () => {
  const PACK = '0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a'

  it('accepts a pack path and refuses traversal and unknown files', () => {
    expect(parseBuddyPackPath(`persona-1/pets/${PACK}/manifest.json`)).toEqual({
      personaId: 'persona-1',
      packId: PACK,
      file: 'manifest.json'
    })
    for (const file of [
      'buddy.json',
      'build-report.json',
      'provenance.json',
      'mascot.webp',
      'gaze_up-2.png',
      'sources/gaze-level-v2.png'
    ]) {
      expect(parseBuddyPackPath(buddyPackRelativePath('p', PACK, file))?.file).toBe(file)
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
      `p/pets/bundled:buddy/manifest.json`,
      `p/idle.png`,
      42
    ]) {
      expect(parseBuddyPackPath(path)).toBeNull()
    }
  })

  it('names pack ids: lowercase uuids and bundled names only', () => {
    expect(isBuddyPackId(PACK)).toBe(true)
    expect(isBuddyPackId('bundled:buddy')).toBe(true)
    expect(buddyBundledPackName('bundled:buddy')).toBe('buddy')
    for (const id of [
      'bundled:',
      'bundled:../x',
      'bundled:Buddy',
      'buddy',
      PACK.toUpperCase(),
      ''
    ]) {
      expect(isBuddyPackId(id)).toBe(false)
    }
    expect(isBuddyPetFileName('sources/a.png')).toBe(true)
    expect(isBuddyPetFileName('sources/a.webp')).toBe(false)
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
    await mkdir(join(bundled, 'buddy'), { recursive: true })
    await writeFile(join(bundled, 'buddy', 'mascot.webp'), Buffer.from('RIFF0000WEBP'))

    const manifest = await readBuddyPetFile(roots, 'p', PACK, 'manifest.json')
    expect(Buffer.from(manifest!).toString()).toBe('{"version":1}')
    expect(await readBuddyPetFile(roots, 'p', PACK, 'sources/pilot.png')).not.toBeNull()
    expect(await readBuddyPetFile(roots, 'p', 'bundled:buddy', 'mascot.webp')).not.toBeNull()
    // Unknown files, other packs, other personas, traversal and bad ids.
    expect(await readBuddyPetFile(roots, 'p', PACK, 'notes.txt')).toBeNull()
    expect(await readBuddyPetFile(roots, 'p', PACK, 'buddy.json')).toBeNull()
    expect(await readBuddyPetFile(roots, 'q', PACK, 'manifest.json')).toBeNull()
    expect(await readBuddyPetFile(roots, '../p', PACK, 'manifest.json')).toBeNull()
    expect(await readBuddyPetFile(roots, 'p', 'bundled:../p', 'manifest.json')).toBeNull()
    expect(await readBuddyPetFile(roots, 'p', PACK, '../../idle.png')).toBeNull()
    expect(await readBuddyPetFile(roots, 'p', 'bundled:buddy', 'manifest.json')).toBeNull()
  })

  it('reads a downloaded official pack under the write root (plan 172 D4)', async () => {
    const write = await root()
    const bundled = await root()
    const folder = join(write, 'official', 'orc', '2')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), '{"version":1}')
    // The catalog names the version; the test pins it.
    const pinned = (packId: unknown): string | null =>
      packId === 'official:orc' ? 'official/orc/2' : null
    const manifest = await readBuddyPetFile(
      { write, bundled },
      'p',
      'official:orc',
      'manifest.json',
      pinned
    )
    expect(Buffer.from(manifest!).toString()).toBe('{"version":1}')
    expect(
      await readBuddyPetFile({ write, bundled }, 'p', 'official:goblin', 'manifest.json', pinned)
    ).toBeNull()
    // Without the pin, the catalog's version decides (not this folder's).
    expect(await readBuddyPetFile({ write, bundled }, 'p', 'official:orc', 'manifest.json')).toBe(
      null
    )
  })

  it('refuses an oversize file and a link that leaves the root', async () => {
    const write = await root()
    const outside = await root()
    const folder = join(write, 'p', 'pets', PACK)
    await mkdir(folder, { recursive: true })
    const huge = join(folder, 'mascot.webp')
    await writeFile(huge, '')
    await truncate(huge, BUDDY_PET_FILE_MAX_BYTES + 1)
    expect(await readBuddyPetFile({ write, bundled: outside }, 'p', PACK, 'mascot.webp')).toBeNull()
    await writeFile(join(outside, 'secret.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'secret.png'), join(folder, 'sheet.png'))
    expect(await readBuddyPetFile({ write, bundled: outside }, 'p', PACK, 'sheet.png')).toBeNull()
  })

  it('ships the bundled root as buddy-assets/bundled', () => {
    const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const builder = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/- from: resources\/buddy\n\s+to: buddy-assets\/bundled\n/)
    expect(existsSync(join(desktop, 'resources', 'buddy'))).toBe(true)
  })
})

describe('buddy pet folder import (plan 168 S-A3)', () => {
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
    const result = await importBuddyPetFolder(
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
      importBuddyPetFolder(
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
    await expect(importBuddyPetFolder(empty, base, 'p', register)).rejects.toThrow(
      'it has no manifest.json'
    )
    const huge = await root()
    await writeFile(join(huge, 'manifest.json'), '{}')
    await writeFile(join(huge, 'mascot.webp'), '')
    await truncate(join(huge, 'mascot.webp'), BUDDY_PET_FILE_MAX_BYTES + 1)
    await expect(importBuddyPetFolder(huge, base, 'p', register)).rejects.toThrow(
      'Keep each file under 32 MB and the pack under 128 MB.'
    )
    await expect(importBuddyPetFolder(huge, base, '../p', register)).rejects.toThrow(
      'The persona id is not a plain token.'
    )
    await expect(
      importBuddyPetFolder(await pickedFolder(), base, 'p', register, () => 'not-a-uuid')
    ).rejects.toThrow('The pack id is not a uuid.')
    // Nothing was created for any refusal.
    expect(await listBuddyPersonas(base)).toEqual([])
  })
})

describe('buddy creation files for the creator wizard (plan 168 S-F5)', () => {
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
    await writeFile(join(folder, 'pack', 'buddy.json'), '{}')
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'sources/gaze-level-v2.png')).toEqual(
      new Uint8Array(ONE_PIXEL_PNG)
    )
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'pack/mascot.webp')).not.toBeNull()
    const manifest = await readBuddyCreationFile(write, 'p', BUILD, 'pack/manifest.json')
    expect(Buffer.from(manifest!).toString()).toBe('{"version":1}')
    // The state file, other pack files, other personas and ids, traversal.
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'build-state.json')).toBeNull()
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'pack/buddy.json')).toBeNull()
    expect(await readBuddyCreationFile(write, 'q', BUILD, 'pack/mascot.webp')).toBeNull()
    expect(await readBuddyCreationFile(write, '../p', BUILD, 'pack/mascot.webp')).toBeNull()
    expect(await readBuddyCreationFile(write, 'p', '../creations', 'pack/mascot.webp')).toBeNull()
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'sources/../build-state.json')).toBeNull()
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'sources/missing-v1.png')).toBeNull()
  })

  it('refuses a link that leaves the root', async () => {
    const write = await root()
    const outside = await root()
    const sources = join(write, 'p', 'creations', BUILD, 'sources')
    await mkdir(sources, { recursive: true })
    await writeFile(join(outside, 'secret.png'), ONE_PIXEL_PNG)
    await symlink(join(outside, 'secret.png'), join(sources, 'pilot-v1.png'))
    expect(await readBuddyCreationFile(write, 'p', BUILD, 'sources/pilot-v1.png')).toBeNull()
  })
})

describe('the golem-assets folder moves to buddy-assets once (plan 171 D3)', () => {
  it('moves the old folder with its files when buddy-assets does not exist', async () => {
    const userData = await root()
    const legacy = join(userData, LEGACY_BUDDY_ASSETS_FOLDER)
    await mkdir(join(legacy, 'p'), { recursive: true })
    await writeFile(join(legacy, 'p', 'idle.png'), ONE_PIXEL_PNG)

    expect(moveLegacyBuddyAssets(userData)).toEqual({ kind: 'moved' })
    expect(existsSync(legacy)).toBe(false)
    expect(await readFile(join(userData, BUDDY_ASSETS_FOLDER, 'p', 'idle.png'))).toEqual(
      ONE_PIXEL_PNG
    )
    // A second start finds nothing left to move.
    expect(moveLegacyBuddyAssets(userData)).toEqual({ kind: 'nothing' })
  })

  it('never merges into or overwrites an existing buddy-assets', async () => {
    const userData = await root()
    await mkdir(join(userData, LEGACY_BUDDY_ASSETS_FOLDER, 'old'), { recursive: true })
    await mkdir(join(userData, BUDDY_ASSETS_FOLDER, 'new'), { recursive: true })

    expect(moveLegacyBuddyAssets(userData)).toEqual({ kind: 'both-exist' })
    expect(await readdir(join(userData, LEGACY_BUDDY_ASSETS_FOLDER))).toEqual(['old'])
    expect(await readdir(join(userData, BUDDY_ASSETS_FOLDER))).toEqual(['new'])
  })

  it('does nothing without an old folder, or when the old name is a file or a link', async () => {
    const userData = await root()
    expect(moveLegacyBuddyAssets(userData)).toEqual({ kind: 'nothing' })
    await mkdir(join(userData, BUDDY_ASSETS_FOLDER))
    expect(moveLegacyBuddyAssets(userData)).toEqual({ kind: 'nothing' })

    const withFile = await root()
    await writeFile(join(withFile, LEGACY_BUDDY_ASSETS_FOLDER), 'not a folder')
    expect(moveLegacyBuddyAssets(withFile)).toEqual({ kind: 'nothing' })

    const withLink = await root()
    const elsewhere = await root()
    await symlink(elsewhere, join(withLink, LEGACY_BUDDY_ASSETS_FOLDER))
    expect(moveLegacyBuddyAssets(withLink)).toEqual({ kind: 'nothing' })
    expect(existsSync(join(withLink, BUDDY_ASSETS_FOLDER))).toBe(false)
  })
})
