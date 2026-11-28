import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')

function rustFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rustFiles(path)
    return path.endsWith('.rs') ? [path] : []
  })
}

// The GPUI app's version is the release's (apps/desktop/package.json's), the
// one a release bumps and the GPUI packagers stamp into the bundle. Its crate
// version (0.1.0) once reached videorc.com as `Videorc-Desktop/0.1.0`, which
// refuses managed shows and hand-off below 0.26.0.
describe('the GPUI app version comes from the release version source', () => {
  it('compiles apps/desktop/package.json in, and nothing reads the crate version', () => {
    const build = readFileSync(join(root, 'apps/videorc/build.rs'), 'utf8')
    assert.match(build, /\.\.\/desktop\/package\.json/)
    assert.match(build, /rustc-env=VIDEORC_APP_VERSION=/)
    const offenders = rustFiles(join(root, 'apps/videorc/src')).filter((file) =>
      readFileSync(file, 'utf8').includes('env!("CARGO_PKG_VERSION")')
    )
    assert.deepEqual(
      offenders.map((file) => file.slice(root.length + 1)),
      [],
      'use crate::APP_VERSION (the release version), not the crate version'
    )
  })

  it('is a release version videorc.com accepts for managed shows (>= 0.26.0)', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'))
    const [major, minor] = version.split('.').map(Number)
    assert.ok(major > 0 || minor >= 26, `apps/desktop/package.json version ${version}`)
  })
})
