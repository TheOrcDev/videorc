import path from 'node:path'

type PathApi = Pick<typeof path, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

/**
 * Returns true only when an absolute candidate resolves to a child of an
 * absolute managed root. `path.relative` preserves each platform's separator,
 * volume, UNC, and case rules; string-prefix checks do not.
 */
export function isPathInsideRoot(
  candidate: string,
  root: string,
  pathApi: PathApi = path
): boolean {
  if (!pathApi.isAbsolute(candidate) || !pathApi.isAbsolute(root)) {
    return false
  }

  const relativePath = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate))
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relativePath)
  )
}

export function isPathInsideAnyRoot(
  candidate: string,
  roots: readonly string[],
  pathApi: PathApi = path
): boolean {
  return roots.some((root) => isPathInsideRoot(candidate, root, pathApi))
}
