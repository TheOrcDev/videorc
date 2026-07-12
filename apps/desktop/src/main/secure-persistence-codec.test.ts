import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createSafeStoragePersistenceCodec,
  writePrivateFileAtomically
} from './secure-persistence-codec'

describe('safeStorage persistence codec', () => {
  it('round-trips only through the OS-protected storage adapter', () => {
    const codec = createSafeStoragePersistenceCodec({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'dpapi',
      encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, 'utf8'),
      decryptString: (ciphertext) => ciphertext.toString('utf8').replace(/^protected:/, '')
    })

    const sealed = codec.seal('single-use-secret')

    expect(sealed).not.toContain('single-use-secret')
    expect(codec.unseal(sealed)).toBe('single-use-secret')
  })

  it('fails closed when encryption is unavailable or Linux selected plaintext storage', () => {
    for (const safeStorage of [
      {
        isEncryptionAvailable: () => false,
        getSelectedStorageBackend: () => 'dpapi'
      },
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text'
      }
    ]) {
      const encryptString = vi.fn(() => Buffer.from('must-not-run'))
      const codec = createSafeStoragePersistenceCodec({
        ...safeStorage,
        encryptString,
        decryptString: () => 'must-not-run'
      })

      expect(() => codec.seal('secret')).toThrow('Protected desktop persistence is unavailable.')
      expect(encryptString).not.toHaveBeenCalled()
    }
  })

  it('rejects malformed ciphertext before calling safeStorage', () => {
    const decryptString = vi.fn(() => 'must-not-run')
    const codec = createSafeStoragePersistenceCodec({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'dpapi',
      encryptString: () => Buffer.from('ciphertext'),
      decryptString
    })

    expect(() => codec.unseal('not base64!')).toThrow(
      'Protected desktop persistence is unavailable.'
    )
    expect(decryptString).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'uses create-new random temp files without following or removing a colliding symlink',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'videorc-secure-persistence-'))
      const storePath = join(directory, 'state.json')
      const victimPath = join(directory, 'victim.txt')
      const nonce = '0'.repeat(32)
      const temporaryPath = `${storePath}.${process.pid}.${nonce}.tmp`
      writeFileSync(victimPath, 'untouched')
      symlinkSync(victimPath, temporaryPath)

      expect(() => writePrivateFileAtomically(storePath, 'secret', () => nonce)).toThrow()
      expect(readFileSync(victimPath, 'utf8')).toBe('untouched')
      expect(readFileSync(temporaryPath, 'utf8')).toBe('untouched')
    }
  )
})
