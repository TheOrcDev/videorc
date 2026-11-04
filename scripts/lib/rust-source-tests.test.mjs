import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { evaluateCfg, listRustSourceTests, tokenizeRust } from './rust-source-tests.mjs'

function withCrate(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'videorc-rust-source-tests-'))
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    return run(join(root, 'main.rs'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function names(tests, enabled) {
  return tests.filter((test) => test.enabled === enabled).map((test) => test.name)
}

describe('Rust source test listing', () => {
  it('names tests by module path across files, mod.rs, #[path] and inline modules', () => {
    withCrate(
      {
        'main.rs': [
          'mod alpha;',
          'mod beta;',
          '#[path = "gamma_impl.rs"]',
          'mod gamma;',
          '#[cfg(test)]',
          'mod tests {',
          '    #[test]',
          '    fn root_test() {}',
          '}'
        ].join('\n'),
        'alpha.rs': [
          'mod nested;',
          'mod runtime {',
          '    #[cfg(test)]',
          '    mod tests {',
          '        #[test]',
          '        fn inner() {}',
          '    }',
          '}'
        ].join('\n'),
        'alpha/nested.rs': '#[tokio::test(flavor = "multi_thread")]\nasync fn nested_async() {}',
        'beta/mod.rs': 'mod leaf;\n#[test]\nfn in_mod_rs() {}',
        'beta/leaf.rs': '#[test]\nfn leaf() {}',
        'gamma_impl.rs': '#[test]\nfn pathed() {}'
      },
      (root) => {
        assert.deepEqual(names(listRustSourceTests(root), true).sort(), [
          'alpha::nested::nested_async',
          'alpha::runtime::tests::inner',
          'beta::in_mod_rs',
          'beta::leaf::leaf',
          'gamma::pathed',
          'tests::root_test'
        ])
      }
    )
  })

  it('applies mod, fn and file-level cfg for the Windows test target', () => {
    withCrate(
      {
        'main.rs': [
          '#[cfg(target_os = "windows")]',
          'mod windows_only;',
          '#[cfg(target_os = "macos")]',
          'mod mac_only;',
          'mod inner_gate;',
          '#[cfg(test)]',
          'mod tests {',
          '    #[cfg(not(target_os = "windows"))]',
          '    #[tokio::test]',
          '    async fn not_on_windows() {}',
          '    #[cfg(all(test, any(unix, windows)))]',
          '    #[test]',
          '    fn on_windows() {}',
          '}'
        ].join('\n'),
        'windows_only.rs': '#[test]\nfn kept() {}',
        'mac_only.rs': '#[test]\nfn dropped() {}',
        'inner_gate.rs': '#![cfg(target_os = "linux")]\n#[test]\nfn dropped_by_inner_cfg() {}'
      },
      (root) => {
        const tests = listRustSourceTests(root)
        assert.deepEqual(names(tests, true).sort(), ['tests::on_windows', 'windows_only::kept'])
        assert.deepEqual(names(tests, false).sort(), [
          'inner_gate::dropped_by_inner_cfg',
          'mac_only::dropped',
          'tests::not_on_windows'
        ])
      }
    )
  })

  it('ignores fns in impls, fn bodies, comments, strings and char literals', () => {
    withCrate(
      {
        'main.rs': [
          '// mod commented_out; { ',
          '/* nested /* } */ */',
          'struct S;',
          "impl<'a> S {",
          '    #[test]',
          '    fn method() {}',
          '}',
          'fn helper() {',
          "    let _ = ['{', '\\'', '}', '\\u{7b}', '😀'];",
          '    let _ = "{ \\" }";',
          '    let _ = r##"{ "# }"##;',
          '    let _ = b"{";',
          '}',
          '#[cfg(test)]',
          'mod tests {',
          '    #[test]',
          '    fn still_found() {}',
          '}'
        ].join('\n')
      },
      (root) => {
        assert.deepEqual(names(listRustSourceTests(root), true), ['tests::still_found'])
      }
    )
  })

  it('throws on a cfg it does not know instead of guessing', () => {
    const cfg = (source) => evaluateCfg(tokenizeRust(source))
    assert.equal(cfg('(any(test, target_os = "linux"))'), true)
    assert.equal(cfg('(not(any(unix, target_os = "windows")))'), false)
    assert.equal(cfg('(feature = "live-background-gl-check")'), false)
    assert.throws(() => cfg('(target_arch = "x86_64")'), /Unknown cfg key: target_arch/)
    assert.throws(() => cfg('(sanitize)'), /Unknown cfg flag: sanitize/)
  })
})
