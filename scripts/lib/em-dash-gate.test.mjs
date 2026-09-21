import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EM_DASH, emDashLanguageFor, findEmDashLines } from './em-dash-gate.mjs'

test('flags an em dash in strings, template literals and JSX text', () => {
  const source = [
    `const a = 'Saved ${EM_DASH} done'`,
    'const b = `Line one',
    `  still the template ${EM_DASH} here\``,
    `return <p>Waiting ${EM_DASH} turn it on</p>`
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'ts'), [1, 3, 4])
})

test('exempts line, block and JSX comments', () => {
  const source = [
    `// a note ${EM_DASH} for developers`,
    `/* block ${EM_DASH} comment`,
    `   second line ${EM_DASH} too */`,
    `{/* SOURCE ${EM_DASH} screen + camera */}`,
    "const url = 'https://example.com/a'"
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'ts'), [])
})

test('a // inside a string is not a comment, and a JSX apostrophe stays on its line', () => {
  const source = [
    `const a = 'https://x.test ${EM_DASH} mirror'`,
    "return <p>don't</p>",
    `// still a comment ${EM_DASH} after the apostrophe line`
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'ts'), [1])
})

test('a URL in JSX text is not a comment', () => {
  const source = [
    `return <p>Visit https://example.test ${EM_DASH} then continue</p>`,
    `const url = 'https://example.test' // a note ${EM_DASH} for developers`
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'ts'), [1])
})

test('Rust: multi-line strings count, char literals and the test module do not', () => {
  const source = [
    `let quote = '"'; // ${EM_DASH} comment`,
    'let message = "first line \\',
    `     second ${EM_DASH} line";`,
    "fn borrow<'a>(value: &'a str) {}",
    '#[cfg(test)]',
    'mod tests {',
    `    const COPY: &str = "old ${EM_DASH} copy";`,
    '}'
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'rust'), [3])
})

test('Rust: a raw string ending in a backslash does not flip the rest of the file', () => {
  const source = [
    'let unc = path.strip_prefix(r"\\\\?\\UNC\\");',
    `// a comment ${EM_DASH} for developers`,
    `let hashed = r#"raw ${EM_DASH} "quoted" text"#;`,
    'let raw_ident = r#type;',
    `/// doc ${EM_DASH} comment`,
    `let bytes = br"\\d ${EM_DASH}";`
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'rust'), [3, 6])
})

test('Rust: code after a mid-file test module is still scanned', () => {
  const source = [
    '#[cfg(test)]',
    'mod motion_tests {',
    '    mod nested {',
    `        const A: &str = "test ${EM_DASH} copy";`,
    '    }',
    '}',
    `const SHIPPED: &str = "Saved ${EM_DASH} done";`,
    '#[cfg(all(test, unix))]',
    '#[allow(dead_code)]',
    'mod unix_tests {',
    `    const B: &str = "test ${EM_DASH} copy";`,
    '}',
    `const ALSO_SHIPPED: &str = "Ready ${EM_DASH} go";`
  ].join('\n')
  assert.deepEqual(findEmDashLines(source, 'rust'), [7, 13])
})

test('scopes the gate to shipped app sources', () => {
  assert.equal(emDashLanguageFor('apps/desktop/src/renderer/src/lib/format.ts'), 'ts')
  assert.equal(emDashLanguageFor('apps/desktop/src/renderer/src/lib/format.test.ts'), null)
  assert.equal(emDashLanguageFor('crates/videorc-backend/src/recording.rs'), 'rust')
  assert.equal(emDashLanguageFor('crates/videorc-backend/remote_web/app.css'), 'text')
  assert.equal(emDashLanguageFor('docs/releases/0.9.98.md'), null)
})
