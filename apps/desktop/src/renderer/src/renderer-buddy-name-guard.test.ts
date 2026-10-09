import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// The companion is Buddy everywhere. Two old names are guarded, each in any
// case and each with its own reasoned allow-list; an entry that matches
// nothing fails too, so a list never outlives the uses it excuses.
//
// - "Orcle" (plan 170, Phase R step 4) may stay only as one of the values in
//   ORCLE_ALLOWED. Each keeps the old name because it is saved on the user's
//   machine or crosses a process boundary, and an older app reads or writes
//   it (plan 170 D22). Nothing there is ever shown to anyone.
// - "Golem" (plan 171 D9) may stay only where it names the stone golem
//   creature, not the feature (D2, D4): its official id `official:golem` and
//   slug `golem`, its kind "Golem" in the onboarding lead's creature list,
//   its art, and the golem example descriptions and chips. Those are in
//   GOLEM_ALLOWED.

const RENDERER_ROOT = join(__dirname, '..')
const SELF = 'src/renderer-buddy-name-guard.test.ts'

interface Allowed {
  /** Path under `apps/desktop/src/renderer/`, forward slashes. */
  file: string
  /** The exact text that may carry the old name. */
  text: string
  reason: string
}

const SAVED_TAB_KEY = 'the saved Buddy sub-tab key; renaming it forgets the tab'
const SAVED_PROMPT_KEY = 'the saved listen-prompt dismissal; renaming it shows the prompt again'
const MODERATION_SOURCE =
  'the moderation source on the wire and in saved reports (strict RPC/IPC schemas)'
const OLD_SETTINGS_TAB = 'the Settings tab id older apps saved; it must still read as General'

const ORCLE_VOICE_FILES = [
  'src/lib/chat-removal-view.ts',
  'src/lib/chat-removal-view.test.ts',
  'src/lib/chat-moderation-relay.test.ts',
  'src/components/stream-manager/command-cards.test.ts',
  'src/components/stream-manager/removal-cards.test.ts',
  'src/components/stream-manager/stream-manager-removal.test.ts',
  'src/components/stream-manager/stream-manager.test.ts'
]

const ORCLE_ALLOWED: readonly Allowed[] = [
  { file: 'src/lib/capture.ts', text: "'videorc.orcleTab'", reason: SAVED_TAB_KEY },
  { file: 'src/lib/buddy-tabs.ts', text: 'saved values keep `orcle`', reason: SAVED_TAB_KEY },
  {
    file: 'src/lib/cohost-view.ts',
    text: "'videorc.orcleListenPromptDismissed'",
    reason: SAVED_PROMPT_KEY
  },
  {
    file: 'src/lib/cohost-view.test.ts',
    text: "'videorc.orcleListenPromptDismissed'",
    reason: SAVED_PROMPT_KEY
  },
  ...ORCLE_VOICE_FILES.map((file) => ({ file, text: "'orcle-voice'", reason: MODERATION_SOURCE })),
  { file: 'src/lib/settings-tabs.ts', text: 'saved `orcle` here', reason: OLD_SETTINGS_TAB },
  { file: 'src/lib/settings-tabs.test.ts', text: "'orcle'", reason: OLD_SETTINGS_TAB },
  { file: 'src/components/tabs/settings-layout.test.ts', text: "'orcle'", reason: OLD_SETTINGS_TAB }
]

const OFFICIAL_ID =
  'the official stone golem keeps its id, a wire value the app and the web share (D2)'
const OFFICIAL_SLUG = 'the official stone golem keeps its slug `golem` (D2)'
const CREATURE_ART = 'describes the stone golem art itself, the creature and not the feature (D4)'
const GOLEM_EXAMPLE = 'an example that describes a golem character, not the feature (D4)'
const CREATURE_LIST = 'the onboarding lead names the creature kinds you can create (D2)'

const OFFICIAL_ID_TEST_FILES = [
  'src/components/buddy-library-section.test.ts',
  'src/components/buddy-onboarding.test.ts',
  'src/hooks/use-buddy-library.test.ts',
  'src/lib/buddy-library-view.test.ts'
]

const STONE_GOLEM_FILES = [
  'src/assets/buddy/default/README.md',
  'src/components/buddy-emblem.tsx',
  'src/components/icons.tsx',
  'src/lib/buddy-default-pack.ts'
]

const GOLEM_ALLOWED: readonly Allowed[] = [
  ...OFFICIAL_ID_TEST_FILES.map((file) => ({
    file,
    text: "'official:golem'",
    reason: OFFICIAL_ID
  })),
  { file: 'src/lib/buddy-library-view.ts', text: '`official:golem`', reason: OFFICIAL_ID },
  {
    file: 'src/lib/buddy-official-art.ts',
    text: 'golem: BUDDY_DEFAULT_PACK',
    reason: OFFICIAL_SLUG
  },
  {
    file: 'src/components/buddy-onboarding.tsx',
    text: 'BUDDY_OFFICIAL_ART.golem',
    reason: OFFICIAL_SLUG
  },
  {
    file: 'src/lib/buddy-official-assets.test.ts',
    text: "slug === 'golem'",
    reason: OFFICIAL_SLUG
  },
  { file: 'src/lib/buddy-official-assets.test.ts', text: "'golem',", reason: OFFICIAL_SLUG },
  ...STONE_GOLEM_FILES.map((file) => ({ file, text: 'stone golem', reason: CREATURE_ART })),
  {
    file: 'src/assets/buddy/default/README.md',
    text: 'so the golem is the same height',
    reason: CREATURE_ART
  },
  {
    file: 'src/assets/buddy/official/README.md',
    text: "Buddy the Golem's official poses",
    reason: CREATURE_ART
  },
  {
    file: 'src/components/buddy-emblem.test.ts',
    text: 'The trimmed golem keeps its aspect',
    reason: CREATURE_ART
  },
  {
    file: 'src/components/buddy-emblem.test.ts',
    text: "'golem-master'",
    reason: 'the art master file name stays golem-master.png (D4); no bundle may name it'
  },
  {
    file: 'src/lib/buddy-onboarding-copy.ts',
    text: 'Create your own Golem, Orc, Goblin, Pirate, Robot',
    reason: CREATURE_LIST
  },
  {
    file: 'src/lib/buddy-onboarding-copy.ts',
    text: 'A grumpy stone golem with a mossy back and a lantern',
    reason: GOLEM_EXAMPLE
  },
  { file: 'src/lib/buddy-persona-view.ts', text: 'Deadpan stone golem', reason: GOLEM_EXAMPLE },
  {
    file: 'src/components/buddy-pet-creator.test.ts',
    text: 'A mossy stone golem',
    reason: GOLEM_EXAMPLE
  },
  ...['src/lib/buddy-library-view.test.ts', 'src/lib/buddy-pet-creator-nav.test.ts'].map(
    (file) => ({ file, text: 'A mossy golem', reason: GOLEM_EXAMPLE })
  )
]

/**
 * Every "orcle" in a line, in any case, except the camelCase seam of a word
 * ending in "for" before one starting "Clean" (`streamingForCleanup`).
 */
function orcleHits(line: string): number {
  return [...line.matchAll(/orcle/gi)].filter((match) => match[0] !== 'orCle').length
}

/** Every "golem" in a line, in any case. */
function golemHits(line: string): number {
  return [...line.matchAll(/golem/gi)].length
}

function rendererFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.(tsx?|css|html|json|md|snap)$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

interface Scan {
  offenders: string[]
  used: Set<Allowed>
}

function scan(hits: (line: string) => number, allowList: readonly Allowed[]): Scan {
  const offenders: string[] = []
  const used = new Set<Allowed>()
  for (const absolute of rendererFiles()) {
    const path = relative(RENDERER_ROOT, absolute).split(sep).join('/')
    if (path === SELF) continue
    const allowed = allowList.filter((entry) => entry.file === path)
    readFileSync(absolute, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (hits(line) === 0) return
        let rest = line
        for (const entry of allowed) {
          if (rest.includes(entry.text)) {
            used.add(entry)
            rest = rest.split(entry.text).join('')
          }
        }
        if (hits(rest) > 0) offenders.push(`${path}:${index + 1}: ${line.trim()}`)
      })
  }
  return { offenders, used }
}

function staleEntries(allowList: readonly Allowed[], used: Set<Allowed>): string[] {
  return allowList
    .filter((entry) => !used.has(entry))
    .map((entry) => `${entry.file}: ${entry.text}`)
}

describe('the companion is Buddy in the renderer, not Orcle (plan 170 D19, D22)', () => {
  const { offenders, used } = scan(orcleHits, ORCLE_ALLOWED)

  it('finds the old name in every case, but not inside a camelCase seam', () => {
    expect(orcleHits('Orcle, ORCLE and orcle-voice')).toBe(3)
    expect(orcleHits('streamingForCleanup ownerForCleanup')).toBe(0)
  })

  it('keeps "Orcle" out of every renderer source but the saved and wire values', () => {
    expect(offenders).toEqual([])
  })

  it('has no allow-list entry that matches nothing', () => {
    expect(staleEntries(ORCLE_ALLOWED, used)).toEqual([])
  })

  it('gives every allow-list entry a reason', () => {
    for (const entry of ORCLE_ALLOWED) expect(entry.reason.length).toBeGreaterThan(20)
  })
})

describe('the companion is Buddy in the renderer, not Golem (plan 171 D9, D4)', () => {
  const { offenders, used } = scan(golemHits, GOLEM_ALLOWED)

  it('finds "golem" in every case and inside identifiers', () => {
    expect(golemHits('Golem, GOLEM_TAB, useGolemLook and official:golem')).toBe(4)
    expect(golemHits('Buddy, Golmar the Orc')).toBe(0)
  })

  it('keeps "Golem" out of every renderer source but the stone golem creature', () => {
    expect(offenders).toEqual([])
  })

  it('has no allow-list entry that matches nothing', () => {
    expect(staleEntries(GOLEM_ALLOWED, used)).toEqual([])
  })

  it('gives every allow-list entry a reason', () => {
    for (const entry of GOLEM_ALLOWED) expect(entry.reason.length).toBeGreaterThan(20)
  })
})
