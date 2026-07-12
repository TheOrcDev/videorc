import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PersistentDirectoryAuthority } from './persistent-directory-authority'

const identityCodec = {
  seal: (value: string): string => value,
  unseal: (value: string): string => value
}
const readText = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null

describe('persistent directory authority', () => {
  it('restores an opaque saved selection after a main/backend restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const selected = join(root, 'recordings')
    mkdirSync(selected)

    const first = new PersistentDirectoryAuthority(store, identityCodec, readText)
    const handle = first.remember(selected)
    const restarted = new PersistentDirectoryAuthority(store, identityCodec, readText)

    expect(handle.displayName).toBe('recordings')
    expect(restarted.resolve(handle.directoryHandleId)).toBe(realpathSync(selected))
  })

  it('fails closed for forged and unavailable handles', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const authority = new PersistentDirectoryAuthority(
      join(root, 'authority.json'),
      identityCodec,
      readText
    )
    expect(() => authority.resolve('directory:00000000-0000-4000-8000-000000000000')).toThrow(
      /unknown/
    )
    expect(() => authority.resolve('../recordings')).toThrow(/invalid/)
  })

  it('rejects a different directory object installed at the remembered path', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const selected = join(root, 'recordings')
    const moved = join(root, 'recordings-original')
    mkdirSync(selected)

    const authority = new PersistentDirectoryAuthority(store, identityCodec, readText)
    const handle = authority.remember(selected)
    renameSync(selected, moved)
    mkdirSync(selected)

    expect(() => authority.resolve(handle.directoryHandleId)).toThrow(/identity changed/)
  })

  it('rejects a symlink or junction installed at the remembered path', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const selected = join(root, 'recordings')
    const moved = join(root, 'recordings-original')
    const outside = join(root, 'outside')
    mkdirSync(selected)
    mkdirSync(outside)

    const authority = new PersistentDirectoryAuthority(store, identityCodec, readText)
    const handle = authority.remember(selected)
    renameSync(selected, moved)
    symlinkSync(outside, selected, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => authority.resolve(handle.directoryHandleId)).toThrow(/identity changed/)
  })

  it('retires legacy path-only handles instead of silently upgrading their authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const selected = join(root, 'recordings')
    mkdirSync(selected)
    const id = 'directory:00000000-0000-4000-8000-000000000000'
    writeFileSync(
      store,
      JSON.stringify({
        version: 1,
        entries: [{ id, canonicalPath: realpathSync(selected), displayName: 'recordings' }]
      })
    )

    const authority = new PersistentDirectoryAuthority(store, identityCodec, readText)
    expect(() => authority.resolve(id)).toThrow(/unknown/)
  })
})
