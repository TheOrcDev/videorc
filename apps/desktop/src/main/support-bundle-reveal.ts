import { lstatSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// Show in Finder for an exported support bundle (plan 174 S3.18, I-1). The
// backend writes every bundle to `support-bundles` beside its database
// (`default_support_bundle_directory` in support_bundle.rs), a folder Finder
// hides. The renderer hands back the path the export returned; main reveals
// it only when it is a bundle file directly inside that folder, so this
// channel can't be used to point the file manager anywhere else.

/** The name the backend gives every bundle: `videorc-support-bundle-20261011-093000Z.json`. */
const SUPPORT_BUNDLE_FILE_NAME = /^videorc-support-bundle-\d{8}-\d{6}Z\.json$/

/** Where the backend writes bundles for the database at `databasePath`. */
export function supportBundleDirectory(databasePath: string): string {
  return join(dirname(resolve(databasePath)), 'support-bundles')
}

/** A regular file, not a link to one (lstat never follows a symlink). */
export function isRegularFileNoFollow(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The bundle path to reveal, or a thrown error. Pure apart from
 * `isRegularFile`: the candidate must be an absolute path to a bundle file
 * directly inside the export folder of the backend's `databasePath`.
 */
export function supportBundleRevealPath(
  candidate: unknown,
  databasePath: unknown,
  isRegularFile: (path: string) => boolean = isRegularFileNoFollow
): string {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > 4096 ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    throw new Error('The support bundle path is invalid.')
  }
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) {
    throw new Error('The support bundle folder is unavailable.')
  }
  const path = resolve(candidate)
  if (
    dirname(path) !== supportBundleDirectory(databasePath) ||
    !SUPPORT_BUNDLE_FILE_NAME.test(basename(path))
  ) {
    throw new Error('Only an exported support bundle can be revealed.')
  }
  if (!isRegularFile(path)) {
    throw new Error('The support bundle is no longer there.')
  }
  return path
}
