import { basename, isAbsolute, join } from 'node:path'

export interface TrashPathDependencies {
  stat: (path: string) => Promise<unknown>
  trashItem: (path: string) => Promise<void>
}

/**
 * Move only positively-inspected paths to Trash. A missing file is already a
 * successful outcome, while permission/I/O failures stay in the durable
 * backend tombstone for a later retry instead of being mistaken for absence.
 */
export async function trashPaths(
  paths: unknown,
  dependencies: TrashPathDependencies
): Promise<{ failures: string[] }> {
  const list = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string') : []
  const failures: string[] = []
  for (const target of list) {
    try {
      await dependencies.stat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      failures.push(target)
      continue
    }
    try {
      await dependencies.trashItem(target)
    } catch {
      failures.push(target)
    }
  }
  return { failures }
}

/**
 * Smoke runs only (plan 209 S16): a stand-in for the system Trash inside the
 * run's own state directory (`VIDEORC_SMOKE_TRASH_DIR`), so `smoke:agent-mcp`
 * proves a Library delete moves the file away without filling the
 * developer's real Trash on every gate run. Null in a packaged app, without
 * the smoke command server, or for a relative directory.
 */
export function smokeTrashDirectory(
  value: string | undefined,
  { packaged, smokeCommandServer }: { packaged: boolean; smokeCommandServer: boolean }
): string | null {
  const directory = value?.trim()
  if (packaged || !smokeCommandServer || !directory || !isAbsolute(directory)) return null
  return directory
}

export interface SmokeTrashDependencies {
  mkdir: (path: string) => Promise<unknown>
  rename: (from: string, to: string) => Promise<void>
  now?: () => number
}

/** `trashItem` for the smoke stand-in: the file moves into `directory`,
 * under a name no other delete can take. */
export function smokeTrashItem(
  directory: string,
  { mkdir, rename, now = Date.now }: SmokeTrashDependencies
): (target: string) => Promise<void> {
  let sequence = 0
  return async (target) => {
    await mkdir(directory)
    sequence += 1
    await rename(target, join(directory, `${now()}-${sequence}-${basename(target)}`))
  }
}
