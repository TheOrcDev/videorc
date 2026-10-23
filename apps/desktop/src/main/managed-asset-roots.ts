import { join } from 'node:path'

/**
 * The folders main serves a backend-owned asset host from (release test 146,
 * plan 0005). The backend keeps Screens and Banners beside its database and
 * names that folder in READY; main used to assume `userData/<folder>`, which
 * is the same folder on macOS and Windows but not on Linux (`~/.videorc`
 * against `~/.config/Videorc`). The backend's folder comes first; the userData
 * folder stays as a fallback for files an older build may have left there and
 * for requests before READY.
 */
export function managedBackendAssetRootCandidates({
  backendRoot,
  userDataDir,
  folder
}: {
  backendRoot: string | null
  userDataDir: string
  folder: string
}): string[] {
  const legacy = join(userDataDir, folder)
  if (!backendRoot) return [legacy]
  return join(backendRoot) === legacy ? [legacy] : [join(backendRoot), legacy]
}
