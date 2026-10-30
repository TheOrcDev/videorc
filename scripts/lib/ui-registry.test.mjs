import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UI_LOCAL_TEMPLATE,
  changedPaths,
  componentsJsonWithTemplate,
  dependencyChanges,
  describeDependencyChange,
  describeDifference,
  findDrift,
  formattablePaths,
  itemsWithSyncedFiles,
  localPathForRegistryFile,
  manifestWithItems,
  mergeItemFiles,
  parseUiArgs,
  parseUiManifest,
  registryItemUrl,
  registryLayout,
  registryTemplateFrom,
  resolveAliasDir,
  resolveItemClosure,
  serializeUiManifest,
  shadcnAddArgs
} from './ui-registry.mjs'

const PATHS = { '@/*': ['src/renderer/src/*'] }
const COMPONENTS_JSON = {
  aliases: {
    components: '@/components',
    utils: '@/lib/utils',
    ui: '@/components/ui',
    lib: '@/lib',
    hooks: '@/hooks'
  },
  registries: {
    '@audiocn': 'https://audiocn.dev/r/{name}.json',
    '@videorc': 'https://ui.videorc.com/r/{name}.json'
  }
}
const LAYOUT = registryLayout(COMPONENTS_JSON, PATHS)

test('the manifest keeps its items and keepLocal and rejects what the sync cannot use', () => {
  const manifest = parseUiManifest(
    JSON.stringify({
      $comment: 'note',
      items: ['button', 'chrome-row'],
      keepLocal: ['src/renderer/src/styles.css']
    })
  )
  assert.deepEqual(manifest.items, ['button', 'chrome-row'])
  assert.deepEqual(manifest.keepLocal, ['src/renderer/src/styles.css'])
  assert.equal(manifest.$comment, 'note')

  assert.deepEqual(parseUiManifest('{}'), { items: [], keepLocal: [] })
  assert.throws(() => parseUiManifest('{ items: [] }'), /not valid JSON/)
  assert.throws(() => parseUiManifest('[]'), /must be a JSON object/)
  assert.throws(() => parseUiManifest('{"items":"button"}'), /"items" must be a list of strings/)
  assert.throws(() => parseUiManifest('{"items":["Button"]}'), /not a registry item name/)
  assert.throws(() => parseUiManifest('{"items":["button","button"]}'), /lists "button" twice/)
  for (const path of ['/etc/passwd', '../styles.css', 'src/./a.css', 'src\\a.css', 'src//a.css']) {
    assert.throws(
      () => parseUiManifest(JSON.stringify({ keepLocal: [path] })),
      /must be a plain path relative to the app/,
      path
    )
  }
})

test('new items append once, in order, and the manifest serializes as JSON with a newline', () => {
  const manifest = { $comment: 'note', items: ['button'], keepLocal: [] }
  const next = manifestWithItems(manifest, ['badge', 'button', 'kbd', 'badge'])
  assert.deepEqual(next.items, ['button', 'badge', 'kbd'])
  assert.deepEqual(manifest.items, ['button'])
  assert.equal(next.$comment, 'note')
  const text = serializeUiManifest(next)
  assert.ok(text.endsWith('}\n'))
  assert.deepEqual(JSON.parse(text), next)
})

test('arguments: names with or without the namespace, and --local with or without a template', () => {
  assert.deepEqual(parseUiArgs([]), { names: [], template: null })
  assert.deepEqual(parseUiArgs(['button', '@videorc/badge', 'button']), {
    names: ['button', 'badge'],
    template: null
  })
  assert.deepEqual(parseUiArgs(['--local', 'button']), {
    names: ['button'],
    template: UI_LOCAL_TEMPLATE
  })
  assert.deepEqual(parseUiArgs(['button', '--local', 'http://localhost:4000/r/{name}.json']), {
    names: ['button'],
    template: 'http://localhost:4000/r/{name}.json'
  })
  assert.deepEqual(parseUiArgs(['--local=http://127.0.0.1:3000/r/{name}.json', '--']), {
    names: [],
    template: 'http://127.0.0.1:3000/r/{name}.json'
  })
  assert.throws(() => parseUiArgs(['--force']), /Unknown option --force/)
  assert.throws(() => parseUiArgs(['@audiocn/fader']), /not a @videorc item name/)
  assert.throws(() => parseUiArgs(['--local', 'http://localhost:3000/r/button.json']), /\{name\}/)
  assert.throws(() => parseUiArgs(['--local=file:///tmp/{name}.json']), /http\(s\) URL/)
})

test('the CLI call installs every item in the namespace and overwrites without asking', () => {
  assert.deepEqual(shadcnAddArgs(['button', 'badge']), [
    'dlx',
    'shadcn@latest',
    'add',
    '@videorc/button',
    '@videorc/badge',
    '--overwrite',
    '--yes'
  ])
})

test('registry URLs come from components.json, and --local swaps only the @videorc entry', () => {
  const template = registryTemplateFrom(COMPONENTS_JSON)
  assert.equal(registryItemUrl(template, 'button'), 'https://ui.videorc.com/r/button.json')
  assert.equal(
    registryTemplateFrom({ registries: { '@videorc': { url: 'https://x.test/{name}.json' } } }),
    'https://x.test/{name}.json'
  )
  assert.throws(() => registryTemplateFrom({ registries: {} }), /no "@videorc" registry/)

  const swapped = JSON.parse(
    componentsJsonWithTemplate(JSON.stringify(COMPONENTS_JSON), UI_LOCAL_TEMPLATE)
  )
  assert.equal(swapped.registries['@videorc'], UI_LOCAL_TEMPLATE)
  assert.equal(swapped.registries['@audiocn'], COMPONENTS_JSON.registries['@audiocn'])
  assert.deepEqual(swapped.aliases, COMPONENTS_JSON.aliases)
})

test('aliases resolve through the tsconfig paths, and only the default aliases are accepted', () => {
  assert.deepEqual(LAYOUT, {
    components: 'src/renderer/src/components',
    ui: 'src/renderer/src/components/ui',
    lib: 'src/renderer/src/lib',
    hooks: 'src/renderer/src/hooks'
  })
  assert.equal(resolveAliasDir('~lib', { '~lib': ['./src/lib'] }), 'src/lib')
  assert.throws(() => resolveAliasDir('#/ui', PATHS), /matches no tsconfig path/)
  assert.throws(
    () =>
      registryLayout(
        { aliases: { ...COMPONENTS_JSON.aliases, ui: '@/components/primitives' } },
        PATHS
      ),
    /aliases differ from shadcn's defaults \(ui\)/
  )
})

test('registry files land where the CLI puts them', () => {
  const at = (file) => localPathForRegistryFile(file, LAYOUT)
  assert.equal(
    at({ path: 'components/ui/button.tsx', type: 'registry:ui' }),
    'src/renderer/src/components/ui/button.tsx'
  )
  assert.equal(
    at({ path: 'components/ui/chrome-row.ts', type: 'registry:ui' }),
    'src/renderer/src/components/ui/chrome-row.ts'
  )
  assert.equal(at({ path: 'lib/utils.ts', type: 'registry:lib' }), 'src/renderer/src/lib/utils.ts')
  assert.equal(
    at({ path: 'hooks/use-theme-toggle.ts', type: 'registry:hook' }),
    'src/renderer/src/hooks/use-theme-toggle.ts'
  )
  assert.equal(
    at({ path: 'components/icons.tsx', type: 'registry:component' }),
    'src/renderer/src/components/icons.tsx'
  )
  assert.equal(
    at({ path: 'registry/new-york/button.tsx', type: 'registry:ui' }),
    'src/renderer/src/components/ui/button.tsx'
  )
  assert.equal(
    at({ path: 'styles/videorc.css', type: 'registry:file', target: '~/src/styles/videorc.css' }),
    'src/styles/videorc.css'
  )
  assert.throws(() => at({ path: 'styles/videorc.css', type: 'registry:file' }), /needs a target/)
  assert.throws(
    () => at({ path: 'x.ts', type: 'registry:file', target: '../../etc/x.ts' }),
    /Unsafe registry target/
  )
})

function item(name, registryDependencies = [], files = []) {
  return { name, type: 'registry:ui', registryDependencies, files }
}

const uiFile = (name, content = `// ${name}\n`) => ({
  path: `components/ui/${name}.tsx`,
  type: 'registry:ui',
  content
})

const REGISTRY = {
  theme: item('theme'),
  utils: item('utils', [], [{ path: 'lib/utils.ts', type: 'registry:lib', content: 'cn\n' }]),
  icons: item(
    'icons',
    [],
    [{ path: 'components/icons.tsx', type: 'registry:component', content: 'icons\n' }]
  ),
  'field-context': item('field-context', ['@videorc/theme'], [uiFile('field-context')]),
  button: item('button', ['@videorc/theme', '@videorc/utils'], [uiFile('button')]),
  input: item(
    'input',
    ['@videorc/theme', '@videorc/field-context', '@videorc/utils', '@audiocn/core', 'utils'],
    [uiFile('input')]
  ),
  spinner: item(
    'spinner',
    ['@videorc/theme', '@videorc/icons', '@videorc/utils'],
    [uiFile('spinner')]
  )
}

test('the closure follows @videorc dependencies, loads each item once and returns the rest as external', async () => {
  const loads = []
  const { items, external } = await resolveItemClosure(
    ['input', 'button', 'input'],
    async (name) => {
      loads.push(name)
      return REGISTRY[name]
    }
  )
  assert.deepEqual([...items.keys()].sort(), ['button', 'field-context', 'input', 'theme', 'utils'])
  assert.deepEqual(loads.sort(), ['button', 'field-context', 'input', 'theme', 'utils'])
  assert.deepEqual(external, ['@audiocn/core', 'utils'])
  await assert.rejects(
    resolveItemClosure(['button'], async () => REGISTRY.input),
    /answered @videorc\/button with "input"/
  )
})

test('every item with a file outside keepLocal belongs in the manifest', async () => {
  const { items } = await resolveItemClosure(['input', 'spinner'], async (name) => REGISTRY[name])
  const synced = itemsWithSyncedFiles(items, LAYOUT, ['src/renderer/src/components/icons.tsx'])
  assert.deepEqual(synced.sort(), ['field-context', 'input', 'spinner', 'utils'])
})

test('two items shipping one path must agree on it', () => {
  const files = [
    { path: 'a.ts', content: 'one', item: 'x' },
    { path: 'a.ts', content: 'one', item: 'y' },
    { path: 'b.ts', content: 'one', item: 'x' },
    { path: 'b.ts', content: 'two', item: 'y' }
  ]
  const merged = mergeItemFiles(files)
  assert.deepEqual(
    merged.files.map((file) => file.path),
    ['a.ts', 'b.ts']
  )
  assert.deepEqual(merged.conflicts, [{ path: 'b.ts', items: ['x', 'y'] }])
})

test('snapshots show added, changed and removed files; Prettier formats code outside keepLocal', () => {
  const before = new Map([
    ['apps/desktop/src/a.ts', '1'],
    ['apps/desktop/src/b.ts', '1'],
    ['apps/desktop/src/c.ts', '1']
  ])
  const after = new Map([
    ['apps/desktop/src/a.ts', '1'],
    ['apps/desktop/src/b.ts', '2'],
    ['apps/desktop/src/d.ts', '1']
  ])
  assert.deepEqual(changedPaths(before, after), [
    'apps/desktop/src/b.ts',
    'apps/desktop/src/c.ts',
    'apps/desktop/src/d.ts'
  ])
  assert.deepEqual(
    formattablePaths(
      [
        'src/a.tsx',
        'src/styles.css',
        'src/b.css',
        'package.json',
        'src/logo.webp',
        'pnpm-lock.yaml'
      ],
      ['src/styles.css']
    ),
    ['src/a.tsx', 'src/b.css', 'package.json']
  )
})

test('dependency changes name every addition, removal and range change', () => {
  const changes = dependencyChanges(
    { dependencies: { clsx: '^2.1.1', 'radix-ui': '^1.4.3' }, devDependencies: { vite: '^7' } },
    {
      dependencies: { clsx: '^2.1.1', cn: '^0.2.4', '@base-ui/react': '^1.9.0' },
      devDependencies: { vite: '^8' }
    }
  )
  assert.deepEqual(changes.map(describeDependencyChange), [
    '+ @base-ui/react ^1.9.0 (dependencies)',
    '+ cn ^0.2.4 (dependencies)',
    '- radix-ui ^1.4.3 (dependencies)',
    '~ vite ^7 -> ^8 (devDependencies)'
  ])
  assert.deepEqual(dependencyChanges({}, {}), [])
})

test('drift is a missing file or the first place a local file parts from the registry', () => {
  const expected = [
    { path: 'same.ts', content: 'a\nb\n', item: 'same' },
    { path: 'gone.ts', content: 'a\n', item: 'gone' },
    { path: 'edited.ts', content: 'a\nb\nc\nd\n', item: 'edited' }
  ]
  const local = { 'same.ts': 'a\nb\n', 'edited.ts': 'a\nB\nC\nd\n' }
  const drift = findDrift(expected, (path) => local[path] ?? null)
  assert.deepEqual(
    drift.map(({ path, kind }) => [path, kind]),
    [
      ['gone.ts', 'missing'],
      ['edited.ts', 'differs']
    ]
  )
  assert.equal(
    drift[1].detail,
    [
      'first difference at line 2:',
      '- local    B',
      '- local    C',
      '+ registry b',
      '+ registry c'
    ].join('\n')
  )
  assert.match(
    describeDifference('x\n'.repeat(10), 'y\n'.repeat(10)),
    /- local {4}x\n- local {4}x\n- local {4}x\n- local {4}… 7 more\n\+ registry y/
  )
})
