import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The companion is Buddy in the README, the docs and the agent skills. Two
// old names are guarded, each in any case and each with its own reasoned
// allow-list; an entry that matches nothing fails too.
//
// - "Orcle" (plan 170, Phase R step 4) may stay only where an ORCLE_ALLOWED
//   entry says why: a value that is saved or crosses the app/web line (D22),
//   the hidden wake-word aliases until their removal after 0.9.140, or a
//   one-line note of the old name.
// - "Golem" (plan 171 D9) may stay only where it names the stone golem
//   creature, not the feature (D2, D4), or in a one-line note of the old
//   name: GOLEM_ALLOWED.
//
// History keeps its words (plan 170 D23, plan 171 D6): docs/releases/ and
// docs/acceptance/ are not scanned, and neither are changelog/ and plans/,
// which sit outside these roots. The renderer has its own guard
// (apps/desktop/src/renderer/src/renderer-buddy-name-guard.test.ts).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOTS = ['README.md', 'docs', '.claude/skills']
const HISTORY = /^docs\/(releases|acceptance)\//

const MODERATION_SOURCE = 'the moderation source on the wire and in saved reports (D22)'
const FLAGS_KEY = "the service-flags document's key, served by the web and read by older apps (D22)"
const ALIASES = 'the hidden wake-word aliases, kept until after 0.9.140 (plan 164 D2)'
const OLD_NAME = 'a one-line note that the companion was called Orcle, for readers of the changelog'
const RULE = 'the D26 naming rule, which has to name the old spelling it keeps'

const ORCLE_ALLOWED = [
  {
    file: 'docs/orcle-live.md',
    text: '# Orcle Live',
    reason: 'the stub plan 164 left so links from past plans still land'
  },
  {
    file: 'docs/orcle-live.md',
    text: 'Orcle is now the **Buddy**',
    reason: 'the stub plan 164 left so links from past plans still land'
  },
  { file: 'docs/buddy.md', text: '(plan 119 as Orcle,', reason: OLD_NAME },
  { file: 'docs/buddy.md', text: 'no longer Orcle or Golem.', reason: OLD_NAME },
  { file: 'docs/buddy.md', text: 'keep `orcle`', reason: RULE },
  { file: 'docs/buddy.md', text: '`orcle-voice`', reason: MODERATION_SOURCE },
  { file: 'docs/buddy.md', text: 'service-flags `orcle` key', reason: FLAGS_KEY },
  {
    file: 'docs/buddy.md',
    text: '`videorc.orcleTab`',
    reason: 'the saved Buddy sub-tab key; renaming it forgets the tab (D22)'
  },
  { file: 'docs/buddy.md', text: 'The old "Orcle" spellings', reason: ALIASES },
  {
    file: 'docs/buddy.md',
    text: '"orcle", "orkle", "orcel", "orkel", "orcl", "orcal"',
    reason: ALIASES
  },
  { file: 'docs/buddy-commands.md', text: 'The old name "Orcle"', reason: ALIASES },
  { file: 'docs/buddy-commands-contract.md', text: 'it said "Orcle"', reason: OLD_NAME },
  { file: 'docs/buddy-commands-contract.md', text: 'orcle-voice', reason: MODERATION_SOURCE },
  { file: 'docs/buddy-commands-contract.md', text: 'service-flags `orcle`', reason: FLAGS_KEY },
  { file: 'docs/buddy-commands-contract.md', text: 'top-level `orcle`', reason: FLAGS_KEY },
  { file: 'docs/buddy-commands-contract.md', text: '"orcle":', reason: FLAGS_KEY },
  { file: 'docs/buddy-commands-contract.md', text: 'hidden Orcle aliases', reason: ALIASES },
  {
    file: '.claude/skills/videorc-design/SKILL.md',
    text: 'saved values keep `orcle`',
    reason: RULE
  },
  { file: '.claude/skills/videorc-design/SKILL.md', text: '`orcle-voice`', reason: RULE },
  { file: '.claude/skills/videorc-design/SKILL.md', text: 'fail on "Orcle"', reason: RULE }
]

const GOLEM_OLD_NAME = 'a one-line note that the companion was called Golem until plan 171'
const GOLEM_RULE = 'the plan 171 D4 naming rule, which has to name the creature words it keeps'
const STONE_GOLEM = 'describes the stone golem creature or its art, not the feature (D4)'
const COPY_DOC = 'docs/buddy-onboarding-copy.md'

const GOLEM_ALLOWED = [
  { file: 'docs/buddy.md', text: 'called Golem until plan 171', reason: GOLEM_OLD_NAME },
  { file: 'docs/buddy.md', text: 'no longer Orcle or Golem.', reason: GOLEM_OLD_NAME },
  {
    file: 'docs/buddy.md',
    text: 'The stone golem creature keeps its own words',
    reason: GOLEM_RULE
  },
  {
    file: 'docs/buddy.md',
    text: 'are `golem` and `official:golem`, its kind is "Golem"',
    reason: GOLEM_RULE
  },
  { file: 'docs/buddy.md', text: "owner's stone golem", reason: STONE_GOLEM },
  {
    file: 'docs/buddy.md',
    text: 'Buddy the Golem',
    reason: 'the official stone golem: its name is Buddy, its kind stays Golem (D2)'
  },
  {
    file: COPY_DOC,
    text: 'Create your own Golem, Orc, Goblin, Pirate, Robot',
    reason: 'the onboarding lead names the creature kinds you can create (D2)'
  },
  {
    file: COPY_DOC,
    text: 'A grumpy stone golem with a mossy back and a lantern',
    reason: 'the placeholder describes a golem character, not the feature (D4)'
  },
  {
    file: '.claude/skills/videorc-design/SKILL.md',
    text: "owner's stone golem",
    reason: STONE_GOLEM
  },
  {
    file: '.claude/skills/videorc-design/SKILL.md',
    text: '"golem" names only the stone golem creature',
    reason: GOLEM_RULE
  },
  {
    file: '.claude/skills/videorc-design/SKILL.md',
    text: 'its slug `golem`, its kind "Golem", its art masters and golem example',
    reason: GOLEM_RULE
  },
  { file: '.claude/skills/videorc-design/SKILL.md', text: 'on "Golem"', reason: GOLEM_RULE }
]

/**
 * Every "orcle" in a line, in any case, except the camelCase seam of a word
 * ending in "for" before one starting "Clean" (`waitForCleanProcessState`).
 */
function orcleHits(line) {
  return [...line.matchAll(/orcle/gi)].filter((match) => match[0] !== 'orCle').length
}

/** Every "golem" in a line, in any case. */
function golemHits(line) {
  return [...line.matchAll(/golem/gi)].length
}

/** Lines that still say the old name once the allowed texts are taken out. */
function scanText(file, text, allowed, used, hits = orcleHits) {
  const offenders = []
  const entries = allowed.filter((entry) => entry.file === file)
  text.split('\n').forEach((line, index) => {
    if (hits(line) === 0) return
    let rest = line
    for (const entry of entries) {
      if (rest.includes(entry.text)) {
        used.add(entry)
        rest = rest.split(entry.text).join('')
      }
    }
    if (hits(rest) > 0) offenders.push(`${file}:${index + 1}: ${line.trim()}`)
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

test('the old-name matchers see every case but not a camelCase seam', () => {
  assert.equal(orcleHits('Orcle, ORCLE and orcle-voice'), 3)
  assert.equal(orcleHits('waitForCleanProcessState'), 0)
  assert.equal(golemHits('Golem, GOLEM_TAB, useGolemLook and official:golem'), 4)
  assert.equal(golemHits('Buddy, Golmar the Orc'), 0)
  const used = new Set()
  const allowed = [{ file: 'a.md', text: '`orcle-voice`', reason: 'test' }]
  assert.deepEqual(scanText('a.md', 'the `orcle-voice` source', allowed, used), [])
  assert.equal(used.size, 1)
  assert.deepEqual(scanText('a.md', 'Orcle and `orcle-voice`', allowed, new Set()), [
    'a.md:1: Orcle and `orcle-voice`'
  ])
  const creature = [{ file: 'a.md', text: 'stone golem', reason: 'test' }]
  assert.deepEqual(scanText('a.md', 'a stone golem', creature, new Set(), golemHits), [])
  assert.deepEqual(scanText('a.md', 'the Golem tab', creature, new Set(), golemHits), [
    'a.md:1: the Golem tab'
  ])
})

/** Offenders and unused entries for one old name across the tracked docs. */
function scanDocs(allowed, hits) {
  const files = trackedDocs()
  assert.ok(files.includes('README.md') && files.includes('docs/buddy.md'), files.join(', '))
  const used = new Set()
  const offenders = files.flatMap((file) =>
    scanText(file, readFileSync(resolve(repoRoot, file), 'utf8'), allowed, used, hits)
  )
  const stale = allowed
    .filter((entry) => !used.has(entry))
    .map((entry) => `${entry.file}: ${entry.text}`)
  return { offenders, stale }
}

test('README, docs and skills never say Orcle, outside the reasoned allow-list (plan 170 D19)', () => {
  const { offenders, stale } = scanDocs(ORCLE_ALLOWED, orcleHits)
  assert.deepEqual(offenders, [])
  assert.deepEqual(stale, [], 'an allow-list entry matches nothing')
  for (const entry of ORCLE_ALLOWED) assert.ok(entry.reason.length > 20, entry.text)
})

test('README, docs and skills say Buddy, and "golem" only for the creature (plan 171 D9)', () => {
  const { offenders, stale } = scanDocs(GOLEM_ALLOWED, golemHits)
  assert.deepEqual(offenders, [])
  assert.deepEqual(stale, [], 'an allow-list entry matches nothing')
  for (const entry of GOLEM_ALLOWED) assert.ok(entry.reason.length > 20, entry.text)
})
