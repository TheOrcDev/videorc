import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Plan 170 (Phase R, step 4): the companion is Golem in the README, the docs
// and the agent skills. "Orcle", in any case, may stay only where an entry
// below says why: a value that is saved or crosses the app/web line (D22),
// the hidden wake-word aliases until their removal after 0.9.140, or a
// one-line note of the old name. History keeps its words (D23):
// docs/releases/ and docs/acceptance/ are not scanned, and neither are
// changelog/ and plans/, which sit outside these roots. An entry that matches
// nothing fails too. The renderer has its own guard
// (apps/desktop/src/renderer/src/renderer-golem-name-guard.test.ts).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOTS = ['README.md', 'docs', '.claude/skills']
const HISTORY = /^docs\/(releases|acceptance)\//

const MODERATION_SOURCE = 'the moderation source on the wire and in saved reports (D22)'
const FLAGS_KEY = "the service-flags document's key, served by the web and read by older apps (D22)"
const ALIASES = 'the hidden wake-word aliases, kept until after 0.9.140 (plan 164 D2)'
const OLD_NAME = 'a one-line note that the companion was called Orcle, for readers of the changelog'
const RULE = 'the D26 naming rule, which has to name the old spelling it keeps'

const ALLOWED = [
  {
    file: 'docs/orcle-live.md',
    text: '# Orcle Live',
    reason: 'the stub plan 164 left so links from past plans still land'
  },
  {
    file: 'docs/orcle-live.md',
    text: 'Orcle is now the **Golem**',
    reason: 'the stub plan 164 left so links from past plans still land'
  },
  { file: 'docs/golem.md', text: '(plan 119 as Orcle,', reason: OLD_NAME },
  { file: 'docs/golem.md', text: 'no longer Orcle.', reason: OLD_NAME },
  { file: 'docs/golem.md', text: 'keep `orcle`', reason: RULE },
  { file: 'docs/golem.md', text: '`orcle-voice`', reason: MODERATION_SOURCE },
  { file: 'docs/golem.md', text: 'service-flags `orcle` key', reason: FLAGS_KEY },
  {
    file: 'docs/golem.md',
    text: '`videorc.orcleTab`',
    reason: 'the saved Golem sub-tab key; renaming it forgets the tab (D22)'
  },
  { file: 'docs/golem.md', text: 'The old "Orcle" spellings', reason: ALIASES },
  {
    file: 'docs/golem.md',
    text: '"orcle", "orkle", "orcel", "orkel", "orcl", "orcal"',
    reason: ALIASES
  },
  { file: 'docs/golem-commands.md', text: 'The old name "Orcle"', reason: ALIASES },
  { file: 'docs/golem-commands-contract.md', text: 'it said "Orcle"', reason: OLD_NAME },
  { file: 'docs/golem-commands-contract.md', text: 'orcle-voice', reason: MODERATION_SOURCE },
  { file: 'docs/golem-commands-contract.md', text: 'service-flags `orcle`', reason: FLAGS_KEY },
  { file: 'docs/golem-commands-contract.md', text: 'top-level `orcle`', reason: FLAGS_KEY },
  { file: 'docs/golem-commands-contract.md', text: '"orcle":', reason: FLAGS_KEY },
  { file: 'docs/golem-commands-contract.md', text: 'hidden Orcle aliases', reason: ALIASES },
  {
    file: '.claude/skills/videorc-design/SKILL.md',
    text: 'saved values keep `orcle`',
    reason: RULE
  },
  { file: '.claude/skills/videorc-design/SKILL.md', text: '`orcle-voice`', reason: RULE },
  { file: '.claude/skills/videorc-design/SKILL.md', text: '"Orcle" anywhere', reason: RULE }
]

/**
 * Every "orcle" in a line, in any case, except the camelCase seam of a word
 * ending in "for" before one starting "Clean" (`waitForCleanProcessState`).
 */
function oldNameHits(line) {
  return [...line.matchAll(/orcle/gi)].filter((match) => match[0] !== 'orCle').length
}

/** Lines that still say the old name once the allowed texts are taken out. */
function scanText(file, text, allowed, used) {
  const offenders = []
  const entries = allowed.filter((entry) => entry.file === file)
  text.split('\n').forEach((line, index) => {
    if (oldNameHits(line) === 0) return
    let rest = line
    for (const entry of entries) {
      if (rest.includes(entry.text)) {
        used.add(entry)
        rest = rest.split(entry.text).join('')
      }
    }
    if (oldNameHits(rest) > 0) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
  })
  return offenders
}

function trackedDocs() {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  return output.split('\0').filter((file) => file.endsWith('.md') && !HISTORY.test(file))
}

test('the old-name matcher sees every case but not a camelCase seam', () => {
  assert.equal(oldNameHits('Orcle, ORCLE and orcle-voice'), 3)
  assert.equal(oldNameHits('waitForCleanProcessState'), 0)
  const used = new Set()
  const allowed = [{ file: 'a.md', text: '`orcle-voice`', reason: 'test' }]
  assert.deepEqual(scanText('a.md', 'the `orcle-voice` source', allowed, used), [])
  assert.equal(used.size, 1)
  assert.deepEqual(scanText('a.md', 'Orcle and `orcle-voice`', allowed, new Set()), [
    'a.md:1: Orcle and `orcle-voice`'
  ])
})

test('README, docs and skills say Golem, outside the reasoned allow-list (plan 170 D19)', () => {
  const files = trackedDocs()
  assert.ok(files.includes('README.md') && files.includes('docs/golem.md'), files.join(', '))
  const used = new Set()
  const offenders = files.flatMap((file) =>
    scanText(file, readFileSync(resolve(repoRoot, file), 'utf8'), ALLOWED, used)
  )
  assert.deepEqual(offenders, [])
  const stale = ALLOWED.filter((entry) => !used.has(entry)).map(
    (entry) => `${entry.file}: ${entry.text}`
  )
  assert.deepEqual(stale, [], 'an allow-list entry matches nothing')
  for (const entry of ALLOWED) assert.ok(entry.reason.length > 20, entry.text)
})
