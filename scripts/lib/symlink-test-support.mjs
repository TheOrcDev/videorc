import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SYMLINK_TEST_SKIP = probeSymlinkSupport()

function probeSymlinkSupport() {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-symlink-test-support-'))
  const target = join(directory, 'target')
  const link = join(directory, 'link')
  try {
    writeFileSync(target, 'symlink test target')
    symlinkSync(target, link, 'file')
    return false
  } catch (error) {
    if (!['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error
    return 'symbolic-link creation is unavailable on this host'
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
