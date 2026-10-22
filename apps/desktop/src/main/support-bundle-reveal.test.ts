import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isRegularFileNoFollow,
  supportBundleDirectory,
  supportBundleRevealPath
} from './support-bundle-reveal'

// Plan 174 S3.18 (I-1): Show in Finder for a support bundle reveals only a
// bundle file inside the backend's export folder, never any other path.

const always = (): boolean => true
// resolve(): absolute on every platform (a drive letter on Windows).
const appData = resolve('/', 'Users', 'me', 'Library', 'Application Support', 'Videorc')
const database = join(appData, 'videorc.sqlite3')
const folder = join(appData, 'support-bundles')
const bundle = join(folder, 'videorc-support-bundle-20261011-093000Z.json')

describe('supportBundleRevealPath', () => {
  it('derives the export folder the way the backend does', () => {
    expect(supportBundleDirectory(database)).toBe(folder)
  })

  it('reveals a bundle file inside the export folder', () => {
    expect(supportBundleRevealPath(bundle, database, always)).toBe(bundle)
  })

  it('refuses anything that is not an exported bundle there', () => {
    const refused = [
      join(folder, '..', 'videorc.sqlite3'),
      join(folder, '..', 'support-bundles', '..', 'secrets.json'),
      join(folder, 'notes.txt'),
      join(folder, 'nested', 'videorc-support-bundle-20261011-093000Z.json'),
      join('/', 'tmp', 'videorc-support-bundle-20261011-093000Z.json'),
      'videorc-support-bundle-20261011-093000Z.json',
      '',
      `${bundle}\0`,
      42,
      null
    ]
    for (const candidate of refused) {
      expect(
        () => supportBundleRevealPath(candidate, database, always),
        String(candidate)
      ).toThrow()
    }
  })

  it('refuses when the backend gave no usable database path', () => {
    expect(() => supportBundleRevealPath(bundle, 'managed-app-data', always)).toThrow(
      'The support bundle folder is unavailable.'
    )
    expect(() => supportBundleRevealPath(bundle, undefined, always)).toThrow()
  })

  it('refuses a bundle that is gone', () => {
    expect(() => supportBundleRevealPath(bundle, database, () => false)).toThrow(
      'The support bundle is no longer there.'
    )
  })
})

describe('isRegularFileNoFollow', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'videorc-bundle-reveal-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // Windows needs a privilege to make a symlink; the rule is the same there.
  it.skipIf(process.platform === 'win32')(
    'accepts a file, never a folder, a missing path or a symlink',
    () => {
      const file = join(root, 'videorc-support-bundle-20261011-093000Z.json')
      writeFileSync(file, '{}')
      mkdirSync(join(root, 'folder'))
      const link = join(root, 'link.json')
      symlinkSync(file, link)
      expect(isRegularFileNoFollow(file)).toBe(true)
      expect(isRegularFileNoFollow(join(root, 'folder'))).toBe(false)
      expect(isRegularFileNoFollow(join(root, 'missing.json'))).toBe(false)
      expect(isRegularFileNoFollow(link)).toBe(false)
    }
  )
})
