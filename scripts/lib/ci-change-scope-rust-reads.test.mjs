import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isAppTsPath } from './ci-change-scope.mjs'

// Plan 242 S15 guard. The app-ts scope lets a pull request skip every Rust
// job when it changes only desktop source "no Rust code reads". That is true
// only while RUST_READS_DESKTOP_* in ci-change-scope.mjs lists every desktop
// path a crate includes or reads. This test finds every Rust string literal
// naming an apps/desktop path (include_str!, include_bytes!, join(...),
// concat!, including calls split across lines) and fails if one would count
// as app-ts.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const RUST_STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g

export function desktopPathsInRust(source) {
  const paths = []
  for (const match of source.matchAll(RUST_STRING_LITERAL)) {
    const at = match[1].indexOf('apps/desktop')
    if (at >= 0) paths.push(match[1].slice(at).replace(/\/+$/, ''))
  }
  return paths
}

/** A file path, or a directory every file under which, counts as app-ts. */
function escapesRustScope(path) {
  return isAppTsPath(path) && isAppTsPath(`${path}/any-file`)
}

describe('ci-change-scope Rust reads guard', () => {
  it('covers every apps/desktop path a Rust crate names', () => {
    const files = execFileSync('git', ['ls-files', '--', 'crates/*.rs', 'crates/**/*.rs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
    assert.ok(files.length > 100, `expected the backend sources, found ${files.length}`)
    const uncovered = []
    let found = 0
    for (const file of files) {
      for (const path of desktopPathsInRust(readFileSync(`${repoRoot}/${file}`, 'utf8'))) {
        found++
        if (escapesRustScope(path)) uncovered.push(`${file}: ${path}`)
      }
    }
    assert.ok(found > 0, 'the scan found no desktop path at all; the pattern is broken')
    assert.deepEqual(
      uncovered,
      [],
      'Rust reads these desktop paths, but a pull request changing them would skip the Rust jobs. Add them to RUST_READS_DESKTOP_* in scripts/lib/ci-change-scope.mjs.'
    )
  })

  it('catches a planted read of a renderer file, even split across lines', () => {
    const planted = `
      const NEW: &str = include_str!(
          "../../../apps/desktop/src/renderer/src/lib/new-palette.ts"
      );
      const OK: &str = include_str!("../../../apps/desktop/src/renderer/src/styles.css");
      let dir = root.join("../../apps/desktop/src/shared");
    `
    const paths = desktopPathsInRust(planted)
    assert.deepEqual(paths, [
      'apps/desktop/src/renderer/src/lib/new-palette.ts',
      'apps/desktop/src/renderer/src/styles.css',
      'apps/desktop/src/shared'
    ])
    assert.deepEqual(paths.filter(escapesRustScope), [
      'apps/desktop/src/renderer/src/lib/new-palette.ts'
    ])
  })
})
