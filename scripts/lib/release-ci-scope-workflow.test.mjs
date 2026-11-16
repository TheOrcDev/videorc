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
const rustJob = ci.slice(ci.indexOf('  rust:'), ci.indexOf('\n  sentinel:'))
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
    assert.match(rustJob, /cargo clippy -p videorc-backend --all-targets -- -D warnings/)
    assert.match(rustJob, /name: Test/)
    assert.match(rustJob, /cargo test -p videorc-backend/)
    // Plan 242 S14: the app sentinel runs in its own job beside the Rust tests.
    assert.doesNotMatch(rustJob, /smoke:process-memory:sentinel/)
    const sentinelJob = ci.slice(ci.indexOf('\n  sentinel:'), ci.indexOf('\n  rust-skip:'))
    assert.match(sentinelJob, /name: macOS app sentinel/)
    assert.match(sentinelJob, /runs-on: macos-15/)
    assert.match(sentinelJob, /macos_sentinel == 'true'/)
    assert.match(sentinelJob, /name: Short no-device process\/memory sentinel/)
    assert.match(sentinelJob, /cargo build -p videorc-backend --bin videorc-backend/)
    assert.match(sentinelJob, /shared-key: rust\n\s+save-if: false/)
    assert.match(sentinelJob, /\[profile\.dev\.package\.videorc-backend\]\n\s+opt-level = 0/)
    assert.match(rustJob, /name: Videorc Camera extension build and Swift tests/)
    assert.match(scope, /macos_sentinel:/)
    assert.match(jsJob, /name: JS \(format \+ lint \+ tests\)/)
    assert.match(jsJob, /outputs\.js == 'true'/)
    assert.match(ci, /js-skip:[\s\S]*outputs\.js != 'true'/)
  })

  it('runs every old JS gate command in a parallel job behind the JS check (plan 242 S8)', () => {
    // A top-level job runs from its key to the next two-space-indented key.
    const job = (id) => {
      const start = ci.indexOf(`\n  ${id}:\n`)
      const next = /\n  [a-z][\w-]*:\n/g
      next.lastIndex = start + 1
      const end = next.exec(ci)?.index ?? ci.length
      return ci.slice(start, end)
    }
    const checks = job('js-checks')
    const build = job('js-build')
    const node = job('js-node')
    const vitest = job('js-vitest')
    for (const [part, commands] of [
      [checks, ['pnpm audit:js', 'pnpm format:check', 'pnpm lint', 'pnpm typecheck']],
      [build, ['pnpm build', 'pnpm check:renderer-assets']],
      [node, ['pnpm test:scripts', 'pnpm smoke:sources']],
      [vitest, ['pnpm --filter @videorc/desktop exec vitest run --shard=${{ matrix.shard }}/4']]
    ]) {
      assert.match(part, /outputs\.js == 'true'/)
      for (const command of commands) assert.ok(part.includes(command), command)
    }
    assert.match(vitest, /shard: \[1, 2, 3, 4\]/)
    assert.match(vitest, /fail-fast: false/)
    assert.match(jsJob, /needs: \[scope, js-checks, js-build, js-node, js-vitest\]/)
    assert.match(jsJob, /if: \$\{\{ always\(\) && needs\.scope\.result == 'success'/)
    assert.match(jsJob, /name: Require every JS gate job/)
    assert.match(jsJob, /node scripts\/vitest-shard-report\.mjs check/)
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
    // Plan 242 S5: the diagnostics run on pushes and dispatch, and on a pull
    // request only when it changes their tooling; the twin covers the rest.
    const incident = windows.slice(
      windows.indexOf('\n  incident:'),
      windows.indexOf('\n  incident-skip:')
    )
    const incidentSkip = windows.slice(windows.indexOf('\n  incident-skip:'))
    assert.match(
      incident,
      /windows_heavy == 'true' &&\s+\(github\.event_name != 'pull_request' \|\| needs\.scope\.outputs\.windows_incident_tooling == 'true'\)/
    )
    assert.match(
      incidentSkip,
      /!\(needs\.scope\.outputs\.windows_heavy == 'true' &&\s+\(github\.event_name != 'pull_request' \|\| needs\.scope\.outputs\.windows_incident_tooling == 'true'\)\)/
    )
    assert.match(scope, /windows_incident_tooling:/)

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
  })

  it('runs the Windows Rust and JS gates side by side with every old step kept (plan 242 S2–S4)', () => {
    const rust = gates.slice(gates.indexOf('\n  rust:'), gates.indexOf('\n  js:'))
    const js = gates.slice(gates.indexOf('\n  js:'), gates.indexOf('\n  js-vitest:'))
    const aggregator = gates.slice(gates.indexOf('\n  gates:'))
    assert.match(rust, /name: Windows release Rust gates/)
    assert.match(rust, /runs-on: windows-latest/)
    for (const step of [
      'Clippy',
      'Preview bounds concurrency (25 stability passes)',
      'Source and audio ownership (25 stability passes)',
      'Test (3 stability passes)',
      'Rust format',
      'Install Rust advisory auditor',
      'Rust advisory audit'
    ]) {
      assert.ok(rust.includes(`- name: ${step}\n`), `Rust job keeps ${step}`)
    }
    assert.match(js, /name: Windows release JS gates/)
    assert.match(js, /runs-on: windows-latest/)
    for (const step of [
      'Tracked text integrity',
      'Node logic tests',
      'Format',
      'TypeScript',
      'Lint',
      'JavaScript advisory audit'
    ]) {
      assert.ok(js.includes(`- name: ${step}\n`), `JS job keeps ${step}`)
    }
    assert.match(aggregator, /name: Windows release source gates/)
    assert.match(aggregator, /needs: \[rust, js, js-vitest\]/)
    assert.match(aggregator, /if: \$\{\{ always\(\) \}\}/)
    assert.match(aggregator, /RUST_WANTED: \$\{\{ inputs\.rust \}\}/)
    assert.match(
      aggregator,
      /"\$RUST_RESULT" != success \] && ! \{ \[ "\$RUST_WANTED" = false \] && \[ "\$RUST_RESULT" = skipped \]; \}/
    )
    assert.match(aggregator, /"\$JS_RESULT" != success \] \|\| \[ "\$VITEST_RESULT" != success/)
    // S15: only an explicit rust: false skips the Rust job; releases keep it.
    assert.match(gates, /rust:\n\s+# Plan 242 S15[\s\S]*?type: boolean\n\s+default: true/)
    assert.match(rust, /if: \$\{\{ inputs\.rust \}\}/)
    assert.doesNotMatch(alpha, /rust: false/)
    assert.match(windows, /rust: \$\{\{ needs\.scope\.outputs\.windows_heavy == 'true' \}\}/)
    assert.match(windows, /windows_installer == 'true'/)
    assert.match(aggregator, /node scripts\/vitest-shard-report\.mjs check/)
    // S8: the desktop tests run on Windows in three time-balanced shards.
    const windowsVitest = gates.slice(gates.indexOf('\n  js-vitest:'), gates.indexOf('\n  gates:'))
    assert.match(windowsVitest, /runs-on: windows-latest/)
    assert.match(windowsVitest, /shard: \[1, 2, 3\]/)
    assert.match(windowsVitest, /- name: Desktop tests\n/)
    assert.match(windowsVitest, /vitest run --shard=\$\{\{ matrix\.shard \}\}\/3/)

    // S2: one cargo launch per pass, an exact expected count, and a listing
    // that proves each filter still selects a test.
    assert.doesNotMatch(rust, /foreach \(\$filter in @\(/)
    assert.match(rust, /cargo test -p videorc-backend -- @filters/)
    assert.match(rust, /Source ownership filter selects no runnable test/)
    assert.match(rust, /\$runnable = @\(\$all \| Where-Object \{ \$_\.Contains\(\$filter\) \}\)\.Count - @\(\$ignored/)
    assert.match(rust, /\$passed -ne \$expected/)
    assert.match(rust, /foreach \(\$pass in 1\.\.25\)/)
    // S6: the CI-only profile macOS and Linux CI use, and one cache key that
    // main saves and pull requests restore.
    assert.match(rust, /name: CI-only fast backend build profile/)
    assert.match(rust, /\[profile\.dev\.package\.videorc-backend\]\n\s+opt-level = 0/)
    assert.match(rust, /RUST_MIN_STACK=8388608/)
    assert.match(rust, /shared-key: windows-gates-v\d+\n/)
    assert.doesNotMatch(rust, /shared-key: \$\{\{ github\.event_name/)
    assert.match(rust, /save-if: \$\{\{ github\.event_name != 'pull_request' \}\}/)
    // S3: never build cargo-audit from source again.
    assert.doesNotMatch(gates, /cargo install cargo-audit/)
    assert.match(rust, /taiki-e\/install-action@[0-9a-f]{40}/)
    assert.match(linuxAlpha, /name: Run Linux clippy gate/)
    assert.match(linuxAlpha, /name: Run Linux unit gate/)
    assert.match(linuxAlpha, /CARGO_BUILD_JOBS: '2'/)
    assert.match(linuxAlpha, /status.*143/)
  })
})
