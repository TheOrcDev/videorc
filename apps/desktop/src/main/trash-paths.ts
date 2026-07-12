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
