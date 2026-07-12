import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { SecurePersistenceCodec } from './secure-persistence-codec'
import { writePrivateFileAtomically } from './secure-persistence-codec'

type DirectoryAuthorityDocument = {
  version: 2
  entries: Array<{
    id: string
    canonicalPath: string
    displayName: string
    objectIdentity: DirectoryObjectIdentity
  }>
}

type LegacyDirectoryAuthorityDocument = {
  version: 1
  entries: Array<{ id: string; canonicalPath: string; displayName: string }>
}

type DirectoryObjectIdentity = {
  device: string
  inode: string
}

export type PersistentDirectoryHandle = {
  directoryHandleId: string
  displayName: string
}

export class PersistentDirectoryAuthority {
  constructor(
    private readonly filePath: string,
    private readonly codec: SecurePersistenceCodec,
    private readonly readFile: (path: string) => string | null
  ) {}

  remember(rawPath: string): PersistentDirectoryHandle {
    const selected = canonicalDirectory(rawPath)
    const canonicalPath = selected.canonicalPath
    const document = this.readDocument()
    const existing = document.entries.find(
      (entry) =>
        entry.canonicalPath === canonicalPath &&
        sameDirectoryObjectIdentity(entry.objectIdentity, selected.objectIdentity)
    )
    const entry =
      existing ??
      ({
        id: `directory:${randomUUID()}`,
        canonicalPath,
        displayName: basename(canonicalPath) || canonicalPath,
        objectIdentity: selected.objectIdentity
      } satisfies DirectoryAuthorityDocument['entries'][number])
    document.entries = [
      entry,
      ...document.entries.filter((candidate) => candidate.id !== entry.id)
    ].slice(0, 32)
    this.writeDocument(document)
    return { directoryHandleId: entry.id, displayName: entry.displayName }
  }

  resolve(handleId: unknown): string {
    if (
      typeof handleId !== 'string' ||
      !/^directory:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        handleId
      )
    ) {
      throw new Error('Directory handle is invalid.')
    }
    const entry = this.readDocument().entries.find((candidate) => candidate.id === handleId)
    if (!entry) {
      throw new Error('Directory handle is unknown. Choose the folder again.')
    }
    const resolved = canonicalDirectory(entry.canonicalPath)
    if (
      resolved.canonicalPath !== entry.canonicalPath ||
      !sameDirectoryObjectIdentity(resolved.objectIdentity, entry.objectIdentity)
    ) {
      throw new Error('Directory identity changed. Choose the folder again.')
    }
    return resolved.canonicalPath
  }

  private readDocument(): DirectoryAuthorityDocument {
    const sealed = this.readFile(this.filePath)
    if (!sealed) {
      return { version: 2, entries: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(this.codec.unseal(sealed))
    } catch {
      throw new Error('Protected directory authority is unavailable.')
    }
    // Version 1 remembered only a path. A path can be replaced by a junction
    // or a different directory while keeping the same spelling, so those
    // handles cannot be upgraded safely. Retire them and ask the user to pick
    // the folder again instead of silently granting authority to a new object.
    if (validLegacyDocument(parsed)) {
      return { version: 2, entries: [] }
    }
    if (!validDocument(parsed)) {
      throw new Error('Protected directory authority is unavailable.')
    }
    return parsed
  }

  private writeDocument(document: DirectoryAuthorityDocument): void {
    writePrivateFileAtomically(this.filePath, this.codec.seal(JSON.stringify(document)))
  }
}

function validDocument(value: unknown): value is DirectoryAuthorityDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Partial<DirectoryAuthorityDocument>
  return (
    document.version === 2 &&
    Array.isArray(document.entries) &&
    document.entries.length <= 32 &&
    document.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        /^directory:[0-9a-f-]{36}$/i.test(entry.id) &&
        typeof entry.canonicalPath === 'string' &&
        entry.canonicalPath.length <= 32_768 &&
        typeof entry.displayName === 'string' &&
        entry.displayName.length <= 1024 &&
        validDirectoryObjectIdentity(entry.objectIdentity)
    )
  )
}

function validLegacyDocument(value: unknown): value is LegacyDirectoryAuthorityDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Partial<LegacyDirectoryAuthorityDocument>
  return (
    document.version === 1 &&
    Array.isArray(document.entries) &&
    document.entries.length <= 32 &&
    document.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        /^directory:[0-9a-f-]{36}$/i.test(entry.id) &&
        typeof entry.canonicalPath === 'string' &&
        entry.canonicalPath.length <= 32_768 &&
        typeof entry.displayName === 'string' &&
        entry.displayName.length <= 1024
    )
  )
}

function validDirectoryObjectIdentity(value: unknown): value is DirectoryObjectIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Partial<DirectoryObjectIdentity>
  return (
    typeof identity.device === 'string' &&
    /^\d+$/.test(identity.device) &&
    typeof identity.inode === 'string' &&
    /^\d+$/.test(identity.inode)
  )
}

function sameDirectoryObjectIdentity(
  left: DirectoryObjectIdentity,
  right: DirectoryObjectIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode
}

function canonicalDirectory(rawPath: string): {
  canonicalPath: string
  objectIdentity: DirectoryObjectIdentity
} {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.trim() !== rawPath) {
    throw new Error('Directory path is invalid.')
  }
  const windows = rawPath.replaceAll('/', '\\').toLowerCase()
  if (
    windows.startsWith('\\\\?\\') ||
    windows.startsWith('\\\\.\\') ||
    windows.startsWith('\\??\\') ||
    windows.startsWith('\\device\\') ||
    windows.startsWith('\\\\') ||
    /^[a-z]:[^\\/]/i.test(rawPath) ||
    rawPath.split(/[\\/]/).includes('..') ||
    !isAbsolute(rawPath)
  ) {
    throw new Error('Directory path is outside the supported local namespace.')
  }
  const canonical = realpathSync(rawPath)
  const stats = statSync(canonical, { bigint: true })
  if (!stats.isDirectory()) {
    throw new Error('Selected resource is not a directory.')
  }
  return {
    canonicalPath: canonical,
    // Node maps these to the volume/file identity on Windows and dev/ino on
    // Unix. Decimal strings preserve the full 64-bit values in the encrypted
    // JSON document without lossy Number conversion.
    objectIdentity: { device: stats.dev.toString(), inode: stats.ino.toString() }
  }
}
