import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

function workflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
}

const ci = workflow('ci.yml')
const windows = workflow('windows.yml')
const linux = workflow('linux.yml')
const scope = workflow('ci-change-scope.yml')
const alpha = workflow('release-windows-alpha.yml')
const gates = workflow('release-windows-gates.yml')
const linuxAlpha = workflow('release-linux-alpha.yml')
const rustJob = ci.slice(ci.indexOf('  rust:'), ci.indexOf('  rust-skip:'))
const jsJob = ci.slice(ci.indexOf('  js:'), ci.indexOf('  js-skip:'))

describe('release CI path-filter wiring', () => {
  it('keeps the macOS Rust and JS step bodies identical and only adds a fail-closed scope gate', () => {
    assert.match(ci, /uses: \.\/\.github\/workflows\/ci-change-scope\.yml/)
    assert.match(rustJob, /needs: scope/)
    assert.match(rustJob, /macos_rust == 'true'/)
    assert.match(ci, /rust-skip:[\s\S]*macos_rust != 'true'/)
    assert.match(rustJob, /name: Rust \(test \+ clippy \+ fmt\)/)
    assert.match(ci, /rust-skip:[\s\S]*name: Rust \(test \+ clippy \+ fmt\)/)
    assert.match(rustJob, /runs-on: macos-15/)
    assert.match(ci, /rust-skip:[\s\S]*runs-on: ubuntu-latest/)
    assert.match(rustJob, /name: Check out repository/)
    assert.match(rustJob, /name: Clippy/)
    assert.match(rustJob, /cargo clippy -p videorc-backend -- -D warnings/)
    assert.match(rustJob, /name: Test/)
    assert.match(rustJob, /cargo test -p videorc-backend/)
    assert.match(rustJob, /name: Short no-device process\/memory sentinel/)
    assert.match(jsJob, /name: JS \(format \+ lint \+ tests\)/)
    assert.match(jsJob, /outputs\.js == 'true'/)
    assert.match(ci, /js-skip:[\s\S]*outputs\.js != 'true'/)
    assert.match(jsJob, /pnpm test:scripts/)
  })

  it('preserves Windows and Linux required-check names while skipping only allow-listed diffs', () => {
    assert.match(windows, /uses: \.\/\.github\/workflows\/ci-change-scope\.yml/)
    assert.match(windows, /uses: \.\/\.github\/workflows\/release-windows-gates\.yml/)
    assert.match(windows, /windows_heavy == 'true'/)
    assert.match(windows, /windows_heavy != 'true'/)
    assert.match(windows, /name: gates \/ Windows release source gates/)
    assert.match(windows, /name: Windows installer artifact/)
    assert.match(windows, /name: Cache capture FFmpeg sources/)
    assert.match(windows, /windows-ffmpeg-capture-src-/)
    assert.match(windows, /name: Windows startup incident diagnostics/)

    assert.match(linux, /uses: \.\/\.github\/workflows\/ci-change-scope\.yml/)
    assert.match(linux, /name: Linux gates \(FFmpeg policy \+ Rust compile\/test\)/)
    assert.match(linux, /linux_heavy == 'true'/)
    assert.match(linux, /linux_heavy != 'true'/)

    assert.match(scope, /on:\n  workflow_call:/)
    assert.match(scope, /node scripts\/ci-change-scope\.mjs/)
    assert.match(scope, /jobs\.scope\.outputs\.windows_heavy/)
  })

  it('does not change Windows alpha signing, protected-main checks, or the reusable source-gate recipe', () => {
    assert.match(alpha, /environment: windows-alpha-release/)
    assert.match(alpha, /Reverify current protected-main source after approval/)
    assert.match(alpha, /name: Windows Rust source gates/)
    assert.match(alpha, /name: Cache capture FFmpeg sources/)
    assert.doesNotMatch(alpha, /ci-change-scope\.yml/)
    assert.match(gates, /runs-on: windows-latest/)
    assert.match(gates, /Source and audio ownership \(25 stability passes\)/)
    assert.match(linuxAlpha, /name: Run Linux clippy gate/)
    assert.match(linuxAlpha, /name: Run Linux unit gate/)
    assert.match(linuxAlpha, /CARGO_BUILD_JOBS: '2'/)
    assert.match(linuxAlpha, /status.*143/)
  })
})
