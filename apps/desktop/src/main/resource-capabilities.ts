import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'

export type ResourceCapabilityKind =
  | 'input-file'
  | 'output-directory'
  | 'open-path'
  | 'reveal-path'
  | 'trash-path'
  | 'background-asset'

export type ResourceSelection = {
  capabilityId: string
  kind: ResourceCapabilityKind
  displayName: string
}

type RememberedResource = {
  kind: ResourceCapabilityKind
  canonicalPath: string
  expiresAtMs: number
}

/**
 * Main-only mirror for capabilities issued to the Rust backend. It exists so
 * UI conveniences such as "Show output folder" can resolve an opaque picker
 * result without ever accepting a renderer-provided path.
 */
export class MainResourceCapabilityRegistry {
  private readonly resources = new Map<string, RememberedResource>()

  remember(
    capabilityId: string,
    kind: ResourceCapabilityKind,
    rawPath: string,
    ttlMs: number,
    nowMs = Date.now()
  ): ResourceSelection {
    if (
      !/^resource:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        capabilityId
      )
    ) {
      throw new Error('Backend returned an invalid resource capability id.')
    }
    const canonicalPath = canonicalResourcePath(rawPath, kind)
    this.prune(nowMs)
    this.resources.set(capabilityId, {
      kind,
      canonicalPath,
      expiresAtMs: nowMs + Math.max(1, ttlMs)
    })
    return { capabilityId, kind, displayName: basename(canonicalPath) || canonicalPath }
  }

  resolve(capabilityId: unknown, expectedKind: ResourceCapabilityKind, nowMs = Date.now()): string {
    if (typeof capabilityId !== 'string') {
      throw new Error('Resource capability id is required.')
    }
    const resource = this.resources.get(capabilityId)
    if (!resource || resource.expiresAtMs <= nowMs) {
      this.resources.delete(capabilityId)
      throw new Error('Resource capability is unknown or expired. Pick the resource again.')
    }
    if (resource.kind !== expectedKind) {
      throw new Error('Resource capability kind mismatch.')
    }
    return resource.canonicalPath
  }

  revoke(capabilityId: string): void {
    this.resources.delete(capabilityId)
  }

  clear(): void {
    this.resources.clear()
  }

  private prune(nowMs: number): void {
    for (const [id, resource] of this.resources) {
      if (resource.expiresAtMs <= nowMs) {
        this.resources.delete(id)
      }
    }
  }
}

function canonicalResourcePath(rawPath: string, kind: ResourceCapabilityKind): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.trim() !== rawPath) {
    throw new Error('Resource path is invalid.')
  }
  const windows = rawPath.replaceAll('/', '\\').toLowerCase()
  if (
    windows.startsWith('\\\\?\\') ||
    windows.startsWith('\\\\.\\') ||
    windows.startsWith('\\??\\') ||
    windows.startsWith('\\device\\') ||
    windows.startsWith('\\\\') ||
    /^[a-z]:[^\\/]/i.test(rawPath)
  ) {
    throw new Error('Windows device, UNC, and drive-relative paths are not supported.')
  }
  if (!isAbsolute(rawPath) || rawPath.split(/[\\/]/).includes('..')) {
    throw new Error('Resource path must be absolute and traversal-free.')
  }
  const canonical = realpathSync(rawPath)
  const stats = statSync(canonical)
  if ((kind === 'input-file' || kind === 'background-asset') && !stats.isFile()) {
    throw new Error('Resource must be a regular file.')
  }
  if (kind === 'output-directory' && !stats.isDirectory()) {
    throw new Error('Resource must be a directory.')
  }
  return canonical
}
