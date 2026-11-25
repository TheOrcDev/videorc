import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COLOUR_LITERAL_ALLOWLIST,
  GPUI_ROOTS,
  GUARDS,
  handTypedShortcutOffenders,
  lexRust,
  offTierRadiusOffenders,
  rawColourOffenders,
  scanGpuiSources,
  smallTextOffenders,
  tintedToastOffenders,
  tokenTextOffenders
} from './gpui-design-guards.mjs'

// Plan 260 S2.2d: each guard fails on a planted violation, leaves the
// allowed forms alone, and the GPUI app's sources pass every guard.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const screen = 'apps/videorc/src/studio/page.rs'
const lines = (...source) => source.join('\n')

test('lexRust keeps code, drops comments and reads literals with their lines', () => {
  const source = lines(
    '// ⌘K in a line comment',
    '/* a /* nested */ block with rgba(0xff0000ff) */',
    'let label = "Cmd+P";',
    "let glyph = '\\u{2318}';",
    'let raw = r##"<rect fill="#000"/>"##;',
    "fn keep<'a>(text: &'a str) -> &'a str { text }",
    '#[cfg(test)]',
    'mod tests {',
    '    const PLANTED: u32 = 0xff0000ff;',
    '    assert_eq!(label(), "⇧⌘J");',
    '}'
  )
  const { code, strings } = lexRust(source)
  assert.equal(code.split('\n').length, source.split('\n').length)
  assert.doesNotMatch(code, /⌘|rgba|Cmd|PLANTED|fill=/)
  assert.match(code, /fn keep<'a>\(text: &'a str\)/)
  assert.deepEqual(strings, [
    { line: 3, text: 'Cmd+P' },
    { line: 4, text: '⌘' },
    { line: 5, text: '<rect fill="#000"/>' }
  ])
})

test('raw colours: every colour is a token', () => {
  const planted = lines(
    'div().bg(rgba(0xff0000ff))',
    '    .border_color(rgb(0x123456))',
    '    .text_color(hsla(0., 0., 1., 1.))',
    'let ink = Hsla { h: 0., s: 0., l: 1., a: 1. };',
    'let snow = gpui::white();',
    'const RED: Color = 0xff0000ff;',
    'let hex = "#FF0000";',
    'let svg = r##"<rect fill="#000"/>"##;'
  )
  const found = rawColourOffenders(screen, lexRust(planted))
  assert.deepEqual(
    found.map((line) => Number(line.split(':')[1])),
    [1, 2, 3, 4, 5, 6, 7, 8]
  )
  const allowed = lines(
    '// #ff0000 and rgba(0xff0000ff) explained in a comment',
    'div().bg(rgba(theme.glass_solid)).border_color(hsla(t.border))',
    '    .shadow(Hsla::transparent_black())',
    'pub fn hsla(color: Color) -> Hsla {',
    '    rgba(color).into()',
    '}',
    'let alpha = (color & 0xff) as f32;',
    'let mask = format!("<rect fill=\\"{}\\"/>", token);',
    '#[cfg(test)]',
    'mod tests { const A: u32 = 0x808080ff; }'
  )
  assert.deepEqual(rawColourOffenders(screen, lexRust(allowed)), [])
  const chrome = 'crates/videorc-kit/src/chrome.rs'
  assert.deepEqual(
    rawColourOffenders(chrome, lexRust('pub const MASK_WHITE: Color = 0xffffffff;')),
    []
  )
  for (const [file, reason] of COLOUR_LITERAL_ALLOWLIST) {
    assert.match(file, /^crates\/videorc-kit\/src\/\w+\.rs$/)
    assert.ok(reason.length > 20, file)
  }
})

test('radii: panel, row, tag, chip and full; popup only on floating surfaces', () => {
  const planted = lines(
    'div().rounded_md()',
    '    .rounded_t_lg()',
    '    .rounded(px(6.))',
    '    .rounded(px(radius::MD))',
    '    .rounded(px(radius::LG))'
  )
  assert.equal(offTierRadiusOffenders(screen, lexRust(planted)).length, 5)
  const allowed = lines(
    'div().rounded(px(radius::ROW))',
    '    .rounded_full()',
    '    .rounded_none()',
    '    .rounded(px(radius::PANEL - 1.0))',
    '    .rounded(px(radius::CHIP))'
  )
  assert.deepEqual(offTierRadiusOffenders(screen, lexRust(allowed)), [])
  const popover = 'crates/videorc-kit/src/popover.rs'
  assert.deepEqual(offTierRadiusOffenders(popover, lexRust('div().rounded(px(radius::LG))')), [])
})

test('text: nothing below 11 px', () => {
  const planted = lines(
    'div().text_size(px(10.))',
    '    .text_size(rems(0.5))',
    'const TINY: TextStyle = TextStyle {',
    '    size: 9.0,',
    '    line_height: 12.0,',
    '    weight: 400.0,',
    '};'
  )
  assert.deepEqual(
    smallTextOffenders(screen, lexRust(planted)).map((line) => line.slice(line.indexOf(': ') + 2)),
    ['text_size(px(10. (10 px)', 'text_size(rems(0.5 (8 px)', 'size: 9.0, (9 px)']
  )
  const allowed = lines(
    'div().text_size(px(11.))',
    '    .text_size(px(text::LABEL.size))',
    '    .text_size(rems(0.75))',
    'let frame = Size { width: 4.0, height: 4.0 };'
  )
  assert.deepEqual(smallTextOffenders(screen, lexRust(allowed)), [])
  // GPUI's Tailwind text helpers keep GPUI's line height: the scale, never them.
  assert.deepEqual(
    smallTextOffenders(screen, lexRust('div().text_xs().child("a")')).map((line) =>
      line.slice(line.indexOf(': ') + 2)
    ),
    ['.text_xs() (not the type scale)']
  )
  assert.deepEqual(
    smallTextOffenders(screen, lexRust('div().type_scale(text::META).text_xs_like()')),
    []
  )
  const tokens = (size) =>
    lines(
      'pub mod text {',
      '    pub const LABEL: TextStyle = TextStyle {',
      `        size: ${size},`,
      '        line_height: 16.0,',
      '        weight: 600.0,',
      '    };',
      '}'
    )
  assert.deepEqual(tokenTextOffenders('tokens.rs', tokens('11.0')), [])
  assert.deepEqual(tokenTextOffenders('tokens.rs', tokens('10.0')), [
    'tokens.rs: text::LABEL is 10.0 px'
  ])
})

test('shortcuts: printed by ShortcutKeys, never typed by hand', () => {
  const planted = lines(
    'let hint = "⌘K";',
    "let key = '⌘';",
    'let menu = "Press Cmd+P to open";',
    'let escaped = "\\u{21E7}\\u{2318}J";'
  )
  assert.equal(handTypedShortcutOffenders(screen, lexRust(planted)).length, 4)
  const allowed = lines('// ⌘K opens the palette', 'ShortcutKeys::new(OpenPalette)')
  assert.deepEqual(handTypedShortcutOffenders(screen, lexRust(allowed)), [])
  const tested = lines('#[cfg(test)]', 'mod tests {', '    assert_eq!(label(), "⌘K");', '}')
  assert.deepEqual(handTypedShortcutOffenders(screen, lexRust(tested)), [])
  assert.deepEqual(
    handTypedShortcutOffenders('crates/videorc-kit/src/shortcut_keys.rs', lexRust(planted)),
    []
  )
})

test('toasts: the type colours the icon only', () => {
  const toast = 'crates/videorc-kit/src/toast.rs'
  const source = lines(
    'pub fn render(kind: Kind, t: &Theme) -> Div {',
    '    div()',
    '        .bg(hsla(t.glass_float))',
    '        .border_color(hsla(t.warning))',
    '        .child(',
    '            svg()',
    '                .path(kind.icon_path())',
    '                .text_color(hsla(t.warning)),',
    '        )',
    '        .child(div().text_color(hsla(t.destructive)).child(kind.title()))',
    '        .child(svg().text_color(hsla(icon_colour(kind, t))))',
    '}',
    '',
    'fn icon_colour(kind: Kind, t: &Theme) -> Color {',
    '    match kind {',
    '        Kind::Error => t.destructive,',
    '        Kind::Success => t.success,',
    '        Kind::Info => t.info,',
    '    }',
    '}'
  )
  assert.deepEqual(
    tintedToastOffenders(toast, lexRust(source)).map((line) => Number(line.split(':')[1])),
    [4, 10]
  )
  // A tone elsewhere is the other guards' business (an Alert's icon, a chip).
  assert.deepEqual(tintedToastOffenders(screen, lexRust(source)), [])
})

test('each guard fails on a violation planted in the app and the kit', () => {
  const root = mkdtempSync(join(tmpdir(), 'gpui-guards-'))
  try {
    const plant = (path, source) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    plant('apps/videorc/src/studio/session.rs', 'div().bg(rgba(0xff0000ff)).rounded_md()')
    plant('apps/videorc/src/library.rs', 'div().text_size(px(10.)).child("⌘K")')
    plant('crates/videorc-kit/src/toast.rs', 'fn render(t: &Theme) { div().bg(hsla(t.warning)) }')
    plant('crates/videorc-kit/src/tokens.rs', 'pub const X: Color = 0xff0000ff;')
    const result = scanGpuiSources(root)
    for (const name of Object.keys(GUARDS)) {
      assert.equal(result[name].length, 1, `${name}: ${JSON.stringify(result[name])}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the GPUI app's sources pass every guard", () => {
  assert.deepEqual(GPUI_ROOTS, ['apps/videorc/src', 'crates/videorc-kit/src'])
  const result = scanGpuiSources(repoRoot)
  for (const [name, offenders] of Object.entries(result)) {
    assert.deepEqual(offenders, [], name)
  }
})
