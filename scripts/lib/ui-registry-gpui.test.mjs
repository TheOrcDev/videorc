import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  GPUI_MANIFEST_PATH,
  cargoLine,
  cargoTable,
  declaredModules,
  describePin,
  gpuiItemFiles,
  parseFlavourArgs,
  parseGpuiManifest,
  pinDifferences,
  registryPatches,
  undeclaredModules
} from './ui-registry-gpui.mjs'

const GPUI = { package: 'gpui-pre', version: '=0.3.14' }
const BASE = { package: 'gpui-base', version: '=0.11.0' }

const item = (name, crates, extra = {}) => ({
  name,
  files: [],
  meta: { flavour: 'gpui', crates },
  ...extra
})

test('parseFlavourArgs takes --flavour in either form and leaves the rest', () => {
  assert.deepEqual(parseFlavourArgs(['button', '--flavour', 'gpui', '--local']), {
    flavour: 'gpui',
    rest: ['button', '--local']
  })
  assert.deepEqual(parseFlavourArgs(['--flavour=react']), { flavour: 'react', rest: [] })
  assert.deepEqual(parseFlavourArgs(['button']), { flavour: null, rest: ['button'] })
  assert.throws(() => parseFlavourArgs(['--flavour', 'slint']), /react or gpui/)
  assert.throws(() => parseFlavourArgs(['--flavour']), /react or gpui/)
  assert.throws(
    () => parseFlavourArgs(['--flavour', 'gpui', '--flavour=react']),
    /twice with different values/
  )
})

test('the committed GPUI manifest parses and points at /r/gpui', () => {
  const manifest = parseGpuiManifest(readFileSync(GPUI_MANIFEST_PATH, 'utf8'))
  assert.equal(manifest.registry, 'https://ui.videorc.com/r/gpui/{name}.json')
  assert.deepEqual(manifest.keepLocal, [])
})

test('parseGpuiManifest rejects a bad registry, name or path', () => {
  const manifest = (fields) =>
    JSON.stringify({ registry: 'https://ui.videorc.com/r/gpui/{name}.json', ...fields })
  assert.deepEqual(parseGpuiManifest(manifest({ items: ['scroll-area'] })).items, ['scroll-area'])
  assert.throws(
    () => parseGpuiManifest(manifest({ registry: 'https://ui.videorc.com/r/gpui' })),
    /must contain \{name\}/
  )
  assert.throws(() => parseGpuiManifest(manifest({ items: ['Button'] })), /kebab-case/)
  assert.throws(() => parseGpuiManifest(manifest({ keepLocal: ['../Cargo.toml'] })), /plain path/)
  assert.throws(() => parseGpuiManifest(manifest({ items: ['a', 'a'] })), /twice/)
})

test('gpuiItemFiles writes only modules and icons, at their targets', () => {
  const files = gpuiItemFiles({
    name: 'icons',
    files: [
      { path: 'gpui/kit/src/icon.rs', target: 'src/icon.rs', content: 'pub fn icon() {}\n' },
      { path: 'gpui/kit/icons/x.svg', target: 'icons/x.svg', content: '<svg/>' }
    ]
  })
  assert.deepEqual(
    files.map((file) => file.path),
    ['src/icon.rs', 'icons/x.svg']
  )
  for (const target of ['Cargo.toml', 'src/../build.rs', '/etc/passwd', 'src/lib/x.rs']) {
    assert.throws(
      () =>
        gpuiItemFiles({
          name: 'bad',
          files: [{ path: 'gpui/kit/src/x.rs', target, content: '' }]
        }),
      /not src\/<module>\.rs/
    )
  }
  assert.throws(
    () => gpuiItemFiles({ name: 'empty', files: [{ path: 'x', target: 'src/x.rs' }] }),
    /no content/
  )
})

test("cargoTable reads the root manifest's one-line workspace pins", () => {
  const workspace = cargoTable(readFileSync('Cargo.toml', 'utf8'), 'workspace.dependencies')
  assert.deepEqual(workspace.gpui, GPUI)
  assert.equal(workspace['videorc-kit'].path, 'crates/videorc-kit')
  const toml = [
    '[workspace.dependencies]',
    'smallvec = "1"',
    '# gpui = "0.1"',
    'resvg = { version = "=0.46.0", default-features = false }',
    '[patch.crates-io]',
    'gpui-pre-apple = { path = "patches/gpui-pre-apple" }'
  ].join('\n')
  assert.deepEqual(cargoTable(toml, 'workspace.dependencies'), {
    smallvec: { version: '1' },
    resvg: { version: '=0.46.0', 'default-features': false }
  })
  assert.deepEqual(Object.keys(cargoTable(toml, 'patch.crates-io')), ['gpui-pre-apple'])
})

test('pinDifferences fails a GPUI pin that differs and lists what the app lacks', () => {
  const items = [item('button', { gpui: GPUI, gpui_base: BASE }), item('badge', { gpui: GPUI })]
  assert.deepEqual(pinDifferences(items, { gpui: GPUI, gpui_base: BASE }), {
    mismatched: [],
    missing: []
  })
  const { mismatched, missing } = pinDifferences(items, {
    gpui: { package: 'gpui-pre', version: '=0.3.13' }
  })
  assert.deepEqual(
    mismatched.map((pin) => [pin.name, pin.items]),
    [['gpui', ['button', 'badge']]]
  )
  assert.equal(
    describePin(mismatched[0]),
    'gpui: the app pins gpui-pre =0.3.13, the registry gpui-pre =0.3.14'
  )
  assert.deepEqual(
    missing.map((pin) => cargoLine(pin.name, pin.spec)),
    ['gpui_base = { package = "gpui-base", version = "=0.11.0" }']
  )
  // Another package under the same key is a different pin, too.
  assert.equal(
    pinDifferences(items, { gpui: { package: 'gpui', version: '=0.3.14' }, gpui_base: BASE })
      .mismatched.length,
    1
  )
})

test('cargoLine writes the short form for a bare version', () => {
  assert.equal(cargoLine('smallvec', { version: '1' }), 'smallvec = "1"')
})

test('undeclaredModules lists the synced modules lib.rs lacks', () => {
  const lib =
    '//! The kit.\npub mod theme;\nmod tokens;\npub(crate) mod chrome;\n// pub mod badge;\n'
  assert.deepEqual([...declaredModules(lib)].sort(), ['chrome', 'theme', 'tokens'])
  assert.deepEqual(
    undeclaredModules(
      [{ path: 'src/theme.rs' }, { path: 'src/badge.rs' }, { path: 'icons/x.svg' }],
      lib
    ),
    ['badge']
  )
})

test('registryPatches gathers the patched crates once', () => {
  assert.deepEqual(
    registryPatches([
      item('a', {}, { meta: { patches: ['gpui-pre-apple'] } }),
      item('b', {}, { meta: { patches: ['gpui-pre-apple'] } }),
      item('c', {})
    ]),
    ['gpui-pre-apple']
  )
})
