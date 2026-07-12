import { join, resolve } from 'node:path'

import { isPathInsideAnyRoot } from './managed-asset-paths'

// When a harness isolates the app's data dirs (VIDEORC_APP_DATA_DIR /
// VIDEORC_USER_DATA_DIR), the backend must be isolated WITH it: the backend
// resolves its own sqlite + secrets paths to ~/Library/Application
// Support/Videorc unless VIDEORC_DATABASE_PATH / VIDEORC_SECRETS_PATH override
// them. Without this, an "isolated" smoke's backend reads and writes the REAL
// user profile (2026-07-01: smoke test-pattern sessions landed in the user's
// DB and their preview showed the smoke's bars). Isolation must be all or
// nothing — main enforces it here for every backend spawn, independent of
// which harness (or hand-rolled env) launched the app.
export function backendIsolationEnv(
  env: Partial<
    Record<
      | 'VIDEORC_APP_DATA_DIR'
      | 'VIDEORC_USER_DATA_DIR'
      | 'VIDEORC_DATABASE_PATH'
      | 'VIDEORC_RECORDINGS_DIR'
      | 'VIDEORC_SECRETS_PATH',
      string
    >
  >
): Record<string, string> {
  const isolatedRoots = [env.VIDEORC_APP_DATA_DIR?.trim(), env.VIDEORC_USER_DATA_DIR?.trim()]
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(path))
  const isolatedRoot = isolatedRoots[0]
  if (!isolatedRoot) {
    return {}
  }

  const overrides: Record<string, string> = {}
  if (!pathStaysInsideIsolation(env.VIDEORC_DATABASE_PATH, isolatedRoots)) {
    overrides.VIDEORC_DATABASE_PATH = join(isolatedRoot, 'videorc.sqlite3')
  }
  if (!pathStaysInsideIsolation(env.VIDEORC_SECRETS_PATH, isolatedRoots)) {
    overrides.VIDEORC_SECRETS_PATH = join(isolatedRoot, 'videorc-secrets.json')
  }
  // F-016: recordings joined the isolation contract late — without this an
  // isolated smoke still dumped its capture files into the user's real
  // ~/Movies/Videorc/Recordings.
  if (!pathStaysInsideIsolation(env.VIDEORC_RECORDINGS_DIR, isolatedRoots)) {
    overrides.VIDEORC_RECORDINGS_DIR = join(isolatedRoot, 'recordings')
  }
  return overrides
}

function pathStaysInsideIsolation(value: string | undefined, roots: readonly string[]): boolean {
  const candidate = value?.trim()
  return Boolean(candidate && isPathInsideAnyRoot(candidate, roots))
}
