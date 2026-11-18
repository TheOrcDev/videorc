import { extname, isAbsolute } from 'node:path'

import { SCREEN_IMAGE_EXTENSIONS, SCREEN_IMAGE_REFUSALS } from '../shared/screen-image-files'

export async function assertDroppedScreenImagePaths(
  paths: readonly string[],
  isFile: (path: string) => Promise<boolean>
): Promise<void> {
  for (const path of paths) {
    if (!isAbsolute(path) || !hasScreenImageExtension(path) || !(await isFile(path))) {
      throw new Error(SCREEN_IMAGE_REFUSALS.notImages)
    }
  }
}

function hasScreenImageExtension(path: string): boolean {
  const extension = extname(path).slice(1).toLowerCase()
  return (SCREEN_IMAGE_EXTENSIONS as readonly string[]).includes(extension)
}

export async function issueAllOrNone<Capability>(
  paths: readonly string[],
  issue: (path: string) => Promise<Capability>,
  revoke: (capability: Capability) => Promise<unknown>
): Promise<Capability[]> {
  const issued: Capability[] = []
  try {
    for (const path of paths) issued.push(await issue(path))
    return issued
  } catch (error) {
    const revoked = await Promise.allSettled(issued.map((capability) => revoke(capability)))
    for (const result of revoked) {
      if (result.status === 'rejected') {
        console.warn('[takeovers] could not revoke a capability', result.reason)
      }
    }
    throw error
  }
}

export function missingAsNotAFile(error: NodeJS.ErrnoException): null {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
  throw error
}

/**
 * The takeover capabilities main issued, so a batch that stops early (the
 * connection dropped, or the provider reset) can hand back the ones it never
 * used. Only ids from this list are revoked: the renderer can't end any other
 * capability this way. Bounded, oldest first out; a forgotten id still ends
 * at its TTL.
 */
export class ScreenImageCapabilityLedger {
  private readonly ids = new Set<string>()

  constructor(private readonly limit = 256) {}

  remember(capabilityId: string): void {
    this.ids.delete(capabilityId)
    this.ids.add(capabilityId)
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
  }

  /** The ids this ledger issued, each handed back once. */
  take(capabilityIds: readonly string[]): string[] {
    const taken: string[] = []
    for (const capabilityId of capabilityIds) {
      if (this.ids.delete(capabilityId)) taken.push(capabilityId)
    }
    return taken
  }
}
