import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

const MAX_PLAINTEXT_BYTES = 1024 * 1024
const MAX_SEALED_BYTES = 2 * 1024 * 1024

export type SecurePersistenceCodec = {
  seal: (plaintext: string) => string
  unseal: (sealed: string) => string
}

type SafeStorageLike = {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
  encryptString: (plaintext: string) => Buffer
  decryptString: (ciphertext: Buffer) => string
}

function securePersistenceError(): Error {
  return new Error('Protected desktop persistence is unavailable.')
}

function assertBoundedUtf8(value: string, maximumBytes: number): void {
  if (!value || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw securePersistenceError()
  }
}

function decodeBoundedBase64(value: string): Buffer {
  if (
    !value ||
    value.length > Math.ceil((MAX_SEALED_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw securePersistenceError()
  }
  const decoded = Buffer.from(value, 'base64')
  if (!decoded.length || decoded.length > MAX_SEALED_BYTES) {
    throw securePersistenceError()
  }
  return decoded
}

export function createSafeStoragePersistenceCodec(
  safeStorage: SafeStorageLike
): SecurePersistenceCodec {
  const assertAvailable = (): void => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === 'basic_text'
    ) {
      throw securePersistenceError()
    }
  }

  return {
    seal(plaintext) {
      try {
        assertAvailable()
        assertBoundedUtf8(plaintext, MAX_PLAINTEXT_BYTES)
        const ciphertext = safeStorage.encryptString(plaintext)
        if (!ciphertext.length || ciphertext.length > MAX_SEALED_BYTES) {
          throw securePersistenceError()
        }
        return ciphertext.toString('base64')
      } catch {
        throw securePersistenceError()
      }
    },
    unseal(sealed) {
      try {
        assertAvailable()
        const plaintext = safeStorage.decryptString(decodeBoundedBase64(sealed))
        assertBoundedUtf8(plaintext, MAX_PLAINTEXT_BYTES)
        return plaintext
      } catch {
        throw securePersistenceError()
      }
    }
  }
}

export function writePrivateFileAtomically(
  filePath: string,
  contents: string,
  createNonce: () => string = () => randomBytes(16).toString('hex')
): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  const nonce = createNonce()
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw securePersistenceError()
  }
  const temporaryPath = `${filePath}.${process.pid}.${nonce}.tmp`
  let temporaryCreated = false
  try {
    const file = openSync(temporaryPath, 'wx', 0o600)
    temporaryCreated = true
    try {
      writeFileSync(file, contents, 'utf8')
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporaryPath, filePath)
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // Windows profile ACLs own access control.
    }
    try {
      const directoryFile = openSync(directory, 'r')
      try {
        fsyncSync(directoryFile)
      } finally {
        closeSync(directoryFile)
      }
    } catch {
      // Directory fsync is unavailable on Windows and some filesystems.
    }
  } finally {
    if (temporaryCreated) rmSync(temporaryPath, { force: true })
  }
}
