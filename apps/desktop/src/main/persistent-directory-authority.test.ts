import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DirectoryUnavailableError,
  outputDirectoryUnavailableMessage,
  PersistentDirectoryAuthority
} from './persistent-directory-authority'

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

  it('names the folder when it was deleted or its drive was unmounted', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const drive = join(root, 'USB STICK')
    const selected = join(drive, 'Videorc')
    mkdirSync(selected, { recursive: true })

    const authority = new PersistentDirectoryAuthority(store, identityCodec, readText)
    const handle = authority.remember(selected)
    // An unmounted removable drive takes its mount point with it
    // (/run/media/<user>/<label>, /Volumes/<label>), so the whole path is gone.
    rmSync(drive, { recursive: true })

    let thrown: unknown
    try {
      authority.resolve(handle.directoryHandleId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DirectoryUnavailableError)
    expect((thrown as DirectoryUnavailableError).displayName).toBe('Videorc')
    expect((thrown as Error).message).not.toMatch(/ENOENT|realpath/)
  })

  it('treats a file left where a parent folder was as an unavailable folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-directory-authority-'))
    const store = join(root, 'authority.json')
    const parent = join(root, 'media')
    const selected = join(parent, 'recordings')
    mkdirSync(selected, { recursive: true })

    const authority = new PersistentDirectoryAuthority(store, identityCodec, readText)
    const handle = authority.remember(selected)
    rmSync(parent, { recursive: true })
    writeFileSync(parent, 'not a folder')

    expect(() => authority.resolve(handle.directoryHandleId)).toThrow(DirectoryUnavailableError)
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

describe('outputDirectoryUnavailableMessage', () => {
  it('names the folder and both ways out, without a filesystem error code', () => {
    const message = outputDirectoryUnavailableMessage('Videorc')
    expect(message).toBe(
      'Videorc can’t find your recordings folder “Videorc”. If it’s on a drive, reconnect the drive. Otherwise choose a folder in Output → Where recordings go.'
    )
  })
})
