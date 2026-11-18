import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isSupportedBackgroundFile } from '../shared/background-import'
import {
  collectManagedBackgroundRecords,
  rehydrateManagedBackgrounds,
  type ManagedBackgroundCollectionDeps,
  type ManagedBackgroundRecord
} from './managed-background-registry'

function makeDeps(
  entries: string[] | Error,
  overrides: Partial<ManagedBackgroundCollectionDeps> & {
    good?: (entry: string) => string | null
  } = {}
) {
  const { good, ...rest } = overrides
  const readDirectory = vi.fn((_root: string) => {
    if (entries instanceof Error) {
      throw entries
    }
    return entries
  })
  const resolveRegularFile = vi.fn((_root: string, entry: string) =>
    good ? good(entry) : `/canon/${entry}`
  )
  const deps: ManagedBackgroundCollectionDeps = {
    bundled: [],
    posters: [],
    importedRoot: '/profile/background-assets',
    readDirectory,
    resolveRegularFile,
    isSupportedFile: isSupportedBackgroundFile,
    ...rest
  }
  return { deps, readDirectory, resolveRegularFile }
}

const byId = (records: ManagedBackgroundRecord[]) =>
  Object.fromEntries(records.map((record) => [record.assetId, record.path]))

describe('collectManagedBackgroundRecords', () => {
  it('lists the imported directory once and validates each candidate once', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `imp-${i}.png`)
    const { deps, readDirectory, resolveRegularFile } = makeDeps(entries, {
      bundled: [{ id: 'b1', assetPath: '/res/b1.png' }],
      posters: [{ id: 'p1', assetPath: '/res/p1.png' }]
    })
    const records = collectManagedBackgroundRecords(deps)
    expect(records).toHaveLength(102)
    expect(readDirectory).toHaveBeenCalledTimes(1)
    expect(resolveRegularFile).toHaveBeenCalledTimes(100)
    expect(byId(records)['imp-7']).toBe('/canon/imp-7.png')
    expect(byId(records).b1).toBe('/res/b1.png')
    expect(byId(records).p1).toBe('/res/p1.png')
  })

  it('treats a missing imported directory as empty and still returns shipped assets', () => {
    const { deps } = makeDeps(new Error('ENOENT'), {
      bundled: [{ id: 'b1', assetPath: '/res/b1.png' }]
    })
    expect(collectManagedBackgroundRecords(deps)).toEqual([{ assetId: 'b1', path: '/res/b1.png' }])
  })

  it('skips unsupported names, invalid ids and extensionless or dotfile entries', () => {
    const { deps, resolveRegularFile } = makeDeps([
      'notes.txt',
      '.hidden.png',
      'noextension',
      'bad id.png',
      `${'x'.repeat(129)}.png`,
      'ok_id-1.JPG'
    ])
    expect(collectManagedBackgroundRecords(deps)).toEqual([
      { assetId: 'ok_id-1', path: '/canon/ok_id-1.JPG' }
    ])
    expect(resolveRegularFile).toHaveBeenCalledTimes(1)
  })

  it('lets bundled beat poster beat imported on an id clash, without resolving shadowed files', () => {
    const { deps, resolveRegularFile } = makeDeps(['b1.png', 'p1.png', 'shared.png', 'fresh.png'], {
      bundled: [
        { id: 'b1', assetPath: '/res/b1.png' },
        { id: 'shared', assetPath: '/res/shared-bundled.png' }
      ],
      posters: [
        { id: 'p1', assetPath: '/res/p1.png' },
        { id: 'shared', assetPath: '/res/shared-poster.png' }
      ]
    })
    expect(byId(collectManagedBackgroundRecords(deps))).toEqual({
      b1: '/res/b1.png',
      shared: '/res/shared-bundled.png',
      p1: '/res/p1.png',
      fresh: '/canon/fresh.png'
    })
    expect(resolveRegularFile).toHaveBeenCalledTimes(1)
  })

  it('registers one record per imported id, taking the first file that validates', () => {
    const { deps } = makeDeps(['dup.png', 'dup.jpg', 'dup.webp', 'lone.png'], {
      good: (entry) => (entry === 'dup.png' || entry === 'lone.png' ? null : `/canon/${entry}`)
    })
    expect(collectManagedBackgroundRecords(deps)).toEqual([
      { assetId: 'dup', path: '/canon/dup.jpg' }
    ])
  })

  it('skips symlinks and non-files with real directory entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-bg-registry-'))
    try {
      writeFileSync(join(root, 'real.png'), 'x')
      symlinkSync(join(root, 'real.png'), join(root, 'link.png'))
      mkdirSync(join(root, 'folder.png'))
      const resolveRegularFile = (dir: string, name: string) => {
        const candidate = join(dir, name)
        if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) {
          return null
        }
        return realpathSync(candidate)
      }
      const records = collectManagedBackgroundRecords({
        bundled: [],
        posters: [],
        importedRoot: root,
        readDirectory: (dir) => readdirSync(dir),
        resolveRegularFile,
        isSupportedFile: isSupportedBackgroundFile
      })
      expect(records.map((record) => record.assetId)).toEqual(['real'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('rehydrateManagedBackgrounds', () => {
  it('registers every collected record once and waits for all of them', async () => {
    const { deps } = makeDeps(['a.png', 'b.png'], {
      bundled: [{ id: 'b1', assetPath: '/res/b1.png' }]
    })
    const registered: ManagedBackgroundRecord[] = []
    await rehydrateManagedBackgrounds({
      ...deps,
      register: async (record) => {
        registered.push(record)
      }
    })
    expect(registered.map((record) => record.assetId).sort()).toEqual(['a', 'b', 'b1'])
  })

  it('rejects when a registration is rejected, after attempting the others', async () => {
    const { deps } = makeDeps(['a.png', 'b.png'])
    const register = vi.fn(async ({ assetId }: ManagedBackgroundRecord) => {
      if (assetId === 'a') {
        throw new Error('backend refused')
      }
    })
    await expect(rehydrateManagedBackgrounds({ ...deps, register })).rejects.toThrow(
      'backend refused'
    )
    expect(register).toHaveBeenCalledTimes(2)
  })
})
