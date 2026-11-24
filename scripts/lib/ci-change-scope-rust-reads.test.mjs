import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  classifyChangeScope,
  desktopPathsInRust,
  isAppTsPath,
  isRustReachableDesktopPath,
  rustReadDesktopPaths,
  scanRustReadDesktopPaths
} from './ci-change-scope.mjs'

// Plan 242 S15, derived since plan 260. The app-ts scope lets a pull request
// skip every Rust job when it changes only desktop source no Rust code reads.
// The Rust-read paths are no longer a hand-kept list: ci-change-scope.mjs
// scans the crates' Rust code for the apps/desktop paths it names, each run.

// The hand-kept list as it stood when it was replaced. Every one of these is
// still found by the scan; when a crate stops reading one, drop it here too.
const HAND_KEPT_FILES = Object.freeze([
  'apps/desktop/src/renderer/src/styles.css',
  'apps/desktop/src/main/window-palette.ts',
  'apps/desktop/src/main/media-access.ts',
  'apps/desktop/src/main/runtime-info.ts',
  'apps/desktop/src/renderer/src/backendClient.ts',
  'apps/desktop/src/renderer/src/lib/system-access.ts',
  'apps/desktop/src/renderer/src/lib/system-access-view.ts',
  'apps/desktop/src/renderer/src/lib/system-permission-orchestration.ts',
  'apps/desktop/src/main/camera-extension.ts',
  'apps/desktop/src/renderer/src/lib/settings-tabs.ts',
  'apps/desktop/src/renderer/src/lib/buddy-tabs.ts',
  'apps/desktop/src/renderer/src/lib/avatar-tabs.ts',
  'apps/desktop/src/renderer/src/lib/livestream-tabs.ts',
  'apps/desktop/src/renderer/src/components/buddy-avatar-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-consent-dialog.tsx',
  'apps/desktop/src/renderer/src/components/buddy-library-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-look-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-motion-section.tsx',
  'apps/desktop/src/renderer/src/components/buddy-persona-section.tsx',
  'apps/desktop/src/renderer/src/components/cohost-settings-section.tsx',
  'apps/desktop/src/renderer/src/components/cohost-status.tsx',
  'apps/desktop/src/renderer/src/components/tabs/avatar-tab.tsx',
  'apps/desktop/src/renderer/src/components/tabs/buddy-tab.tsx',
  'apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-create-gate.ts',
  'apps/desktop/src/renderer/src/lib/buddy-library-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-onboarding-copy.ts',
  'apps/desktop/src/renderer/src/lib/buddy-persona-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-report-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-tab-view.ts',
  'apps/desktop/src/renderer/src/lib/cohost-view.ts',
  'apps/desktop/src/renderer/src/lib/studio-actions/studio-context.ts',
  'apps/desktop/src/renderer/src/components/cohost-pane.tsx',
  'apps/desktop/src/renderer/src/components/comment-row.tsx',
  'apps/desktop/src/renderer/src/components/comments-header.tsx',
  'apps/desktop/src/renderer/src/components/pin-window-button.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/buddy-utterance-cards.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/chat-on-stream-switch.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/chat-pane.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/stats-bar.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/stream-manager-status-bar.tsx',
  'apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx',
  'apps/desktop/src/renderer/src/lib/buddy-command-view.ts',
  'apps/desktop/src/renderer/src/lib/buddy-output-notice.ts',
  'apps/desktop/src/renderer/src/lib/buddy-pet-view.ts',
  'apps/desktop/src/renderer/src/lib/cohost-presence.ts',
  'apps/desktop/src/renderer/src/lib/x-mark.ts'
])

describe('ci-change-scope Rust reads, derived', () => {
  it('finds every path the hand-kept list had', () => {
    const reads = rustReadDesktopPaths()
    const missing = HAND_KEPT_FILES.filter((path) => !reads.includes(path))
    assert.deepEqual(missing, [], 'the scan no longer finds these Rust reads')
    for (const path of HAND_KEPT_FILES) {
      assert.equal(isAppTsPath(path), false, path)
      assert.equal(
        classifyChangeScope({
          eventName: 'pull_request',
          files: ['apps/desktop/src/renderer/src/components/sidebar.tsx', path]
        }).kind,
        'code',
        path
      )
    }
  })

  it('still lets main-process and renderer files no Rust code reads skip the Rust jobs', () => {
    // index.ts, app-menu.ts and virtual-camera-linux-setup.ts are named in
    // Rust doc comments only: a comment is not a read.
    for (const path of [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/main/app-menu.ts',
      'apps/desktop/src/main/virtual-camera-linux-setup.ts',
      'apps/desktop/src/preload/index.ts',
      'apps/desktop/src/renderer/src/components/sidebar.tsx',
      'apps/desktop/src/renderer/src/hooks/use-studio.tsx'
    ]) {
      assert.equal(isRustReachableDesktopPath(path), false, path)
      const scope = classifyChangeScope({ eventName: 'pull_request', files: [path] })
      assert.equal(scope.kind, 'app-ts', path)
      assert.equal(scope.macosRust, false, path)
      assert.equal(scope.windowsHeavy, false, path)
      assert.equal(scope.linuxHeavy, false, path)
    }
  })

  it('reads string literals in code, never comments, even split across lines', () => {
    const planted = `
      // include_str!("../../../apps/desktop/src/main/commented-out.ts");
      /* outer /* nested "apps/desktop/src/main/nested.ts" */ still a comment */
      const NEW: &str = include_str!(
          "../../../apps/desktop/src/renderer/src/lib/new-palette.ts"
      );
      let quote = '"'; let label = 'outer;
      let url = "https://example.com//not-a-comment";
      let raw = r#"../../apps/desktop/src/renderer/src/lib/raw.ts"#;
      let dir = root.join("../../apps/desktop/src/shared/");
      let one = format!("../../apps/desktop/src/renderer/src/lib/{name}-view.ts");
    `
    assert.deepEqual(desktopPathsInRust(planted), [
      'apps/desktop/src/renderer/src/lib/new-palette.ts',
      'apps/desktop/src/renderer/src/lib/raw.ts',
      'apps/desktop/src/shared',
      // A templated path counts as its whole directory.
      'apps/desktop/src/renderer/src/lib'
    ])
  })

  it('scans every crate, tests and build scripts included, and fails closed on nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-scope-rust-reads-'))
    try {
      mkdirSync(join(root, 'crates/one/src/inner'), { recursive: true })
      mkdirSync(join(root, 'crates/two/tests'), { recursive: true })
      mkdirSync(join(root, 'crates/two/target/debug'), { recursive: true })
      writeFileSync(
        join(root, 'crates/one/src/inner/mod.rs'),
        'const A: &str = include_str!("../../../../apps/desktop/src/main/a.ts");'
      )
      writeFileSync(
        join(root, 'crates/two/tests/fixture.rs'),
        'let b = std::fs::read_to_string(root.join("apps/desktop/src/renderer/src/lib/b.ts"));'
      )
      writeFileSync(
        join(root, 'crates/two/build.rs'),
        'println!("cargo:rerun-if-changed=../../apps/desktop/src/main/c.ts");'
      )
      writeFileSync(
        join(root, 'crates/two/target/debug/out.rs'),
        'const D: &str = "apps/desktop/src/main/generated.ts";'
      )
      const reads = scanRustReadDesktopPaths(root)
      assert.deepEqual(reads, [
        'apps/desktop/src/main/a.ts',
        'apps/desktop/src/main/c.ts',
        'apps/desktop/src/renderer/src/lib/b.ts'
      ])
      assert.equal(isRustReachableDesktopPath('apps/desktop/src/main/a.ts', reads), true)
      assert.equal(isRustReachableDesktopPath('apps/desktop/src/main/a.tsx', reads), false)
      assert.deepEqual(scanRustReadDesktopPaths(join(root, 'nowhere')), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // A broken scan (nothing found) counts every desktop path as Rust.
    assert.equal(isRustReachableDesktopPath('apps/desktop/src/main/index.ts', []), true)
  })
})
