// Windows refuses file symlinks without Developer Mode or an elevated token
// (EPERM). Tests that build symlinks to prove a macOS release gate skip with
// this reason on such a host instead of failing; any other error is left to
// the test so a real fault still shows.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `false` when this host can create file symlinks, else the skip reason. */
export function symlinkSkipReason() {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-symlink-probe-'))
  try {
    const target = join(directory, 'target')
    writeFileSync(target, '')
    symlinkSync(target, join(directory, 'link'))
    return false
  } catch (error) {
    return error?.code === 'EPERM' ? 'this host cannot create symlinks (EPERM)' : false
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
