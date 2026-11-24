import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkParity, parityStats, parseParity, sourcePaths } from './gpui-parity.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sample = (rows, counts = '| Controls (P lines) | 3 | 2 | 1 | 2 |') => `# x

## Counts

| | Lines | macOS | Windows | Linux |
| --- | ---: | ---: | ---: | ---: |
${counts}
| Windows-only lines (W lines) | 1 | | 1 | |

## Shell

### Sidebar

| # | Control | What it does | Source | macOS | Windows | Linux |
| --- | --- | --- | --- | :-: | :-: | :-: |
${rows}

## Windows-only lines

| # | Line | Windows |
| --- | --- | :-: |
| W01 | Scale | [x] |
`

const good = [
  '| P001 | Row "Studio" | Opens Studio | `shared/sidebar-pages.ts:45` | [x] | [ ] | [ ] |',
  '| P002 | Traffic lights | Gutter | `renderer/components/window-frame.tsx:36` | [ ] | n/a | n/a |',
  '| P003 | Reload | Dev only | `main/app-menu.ts:49; app-menu.ts:68` | dev | dev | [ ] |'
].join('\n')

test('the real parity list holds: rows, IDs, cells, counts and every source file', () => {
  const parsed = parseParity(readFileSync(join(repoRoot, 'docs', 'gpui', 'parity.md'), 'utf8'))
  assert.ok(parsed.controls.length > 1000)
  assert.deepEqual(checkParity(parsed, { repoRoot }), [])
})

test('a well-formed list has no problems, and stats count done over lines', () => {
  const parsed = parseParity(sample(good))
  assert.deepEqual(checkParity(parsed, { repoRoot }), [])
  const { areas, total } = parityStats(parsed)
  assert.deepEqual(areas[0], {
    area: 'Shell',
    macos: { done: 1, lines: 2 },
    windows: { done: 0, lines: 1 },
    linux: { done: 0, lines: 2 }
  })
  assert.deepEqual(total.windows, { done: 1, lines: 2 })
})

test('every kind of problem is named with its line and id', () => {
  const rows = [
    '| P002 | A | a | `shared/sidebar-pages.ts:1` | [ ] | [ ] | [ ] |',
    '| P002 | Dup | a | `shared/sidebar-pages.ts:1` | [ ] | [ ] | [ ] |',
    '| P001 | Back | a | `shared/sidebar-pages.ts:1` | [ ] | [ ] | [ ] |',
    '| P004 | Bad cell | a | `shared/sidebar-pages.ts:1` | yes | [ ] | [ ] |',
    '| P005 | Gone | a | `renderer/components/no-such-file.tsx:3` | [ ] | [ ] | [ ] |',
    '| P006 | Short | a | `shared/sidebar-pages.ts:1` | [ ] | [ ] |'
  ].join('\n')
  const problems = checkParity(parseParity(sample(rows)), { repoRoot }).map(
    (p) => `${p.id ?? '-'} ${p.problem}`
  )
  const has = (pattern) =>
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `${pattern} in ${problems.join(' | ')}`
    )
  has(/^P002 is a duplicate id/)
  has(/^P001 comes after P002/)
  has(/^P004 macos cell "yes" is not one of/)
  has(/^P005 source renderer\/components\/no-such-file\.tsx no longer exists/)
  has(/^P006 has 6 cells, not 7/)
  has(/^- Counts controls lines says 3, the rows say 6/)
})

test('a Source cell can cite several files, relative to the first one', () => {
  assert.deepEqual(
    sourcePaths('`main/app-menu.ts:49; app-menu.ts:68` (labels renderer/lib/x.ts:3)'),
    ['main/app-menu.ts', 'app-menu.ts', 'renderer/lib/x.ts']
  )
})
