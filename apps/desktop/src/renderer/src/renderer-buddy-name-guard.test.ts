import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// The companion is Sidekick everywhere a person reads it. Three old names
// are guarded, each with its own reasoned allow-list; an entry that matches
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
// - "Buddy" (plan 236 D1, D-5) is the name the companion had until plan
//   236, and a name a program reads keeps it: identifiers, file names,
//   comments, test ids, wire and saved values (`buddy`, `bundled:buddy`,
//   `cohost.buddy.state`). So this guard reads only what a person reads, in
//   the renderer's and shared sources (tests excepted): every JSX text and
//   every string or template literal, JSX attributes included. It fails on
//   "Buddy" or "Buddies" as the name is written, and on a lowercase "buddy"
//   inside a sentence; the rest is in BUDDY_ALLOWED.
// - "Sidekick" (plan 239 D1, C6) is the helper's name now; the character on
//   the stream is the avatar. On the avatar's own surfaces (AVATAR_SIDE_FILES)
//   the same reader may find "Sidekick" only where a sentence is about the
//   helper (it answers, it writes): SIDEKICK_ALLOWED. Anything else there is
//   the avatar called by the helper's name, a copy miss to fix, not to list.

const RENDERER_ROOT = join(__dirname, '..')
const SELF = 'src/renderer-buddy-name-guard.test.ts'
/** `apps/desktop/src`: the renderer and the shared copy helpers. */
const DESKTOP_SOURCE_ROOT = join(RENDERER_ROOT, '..')

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
    // Flint since plan 239 D2; the creature's name, not the feature.
    text: "Flint the Golem's official poses",
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
  ),
  // Custom Buddy picture (#1213): the default slot is still the stone golem art.
  {
    file: 'src/components/buddy-emblem.tsx',
    text: 'keeps the golem.',
    reason: CREATURE_ART
  },
  {
    file: 'src/components/icons.tsx',
    text: 'swaps the golem for the streamer',
    reason: CREATURE_ART
  },
  {
    file: 'src/components/icons.tsx',
    text: 'keeps the golem.',
    reason: CREATURE_ART
  },
  {
    file: 'src/components/own-buddy-icon.tsx',
    text: 'in place of the golem once',
    reason: CREATURE_ART
  },
  {
    file: 'src/components/own-buddy-icon.tsx',
    text: 'a picture, the golem',
    reason: CREATURE_ART
  },
  {
    file: 'src/lib/buddy-picture.test.ts',
    text: 'null for the golem:',
    reason: CREATURE_ART
  },
  {
    file: 'src/lib/buddy-picture.ts',
    text: 'the official golem, settings',
    reason: CREATURE_ART
  },
  {
    file: 'src/lib/buddy-picture.ts',
    text: '* golem. Safe for the eager shell',
    reason: CREATURE_ART
  }
]

const LOG_TAG = "a log line's tag, read only in Health's app log; log tags keep the old name (D1)"

/** Paths under `apps/desktop/src`, forward slashes. */
const BUDDY_ALLOWED: readonly Allowed[] = [
  { file: 'renderer/src/lib/buddy-overlay.ts', text: 'Buddy overlay:', reason: LOG_TAG }
]

/**
 * The avatar's surfaces (plan 239): the Avatar page, its sections, the
 * onboarding, the creator, the Test dialog, and the views behind them. Paths
 * under `apps/desktop/src`, forward slashes; their file names keep `buddy`
 * (plan 236 D1).
 */
const AVATAR_SIDE_FILES: readonly string[] = [
  'renderer/src/components/tabs/avatar-tab.tsx',
  'renderer/src/components/buddy-library-section.tsx',
  'renderer/src/components/buddy-persona-section.tsx',
  'renderer/src/components/buddy-pet-settings.tsx',
  'renderer/src/components/buddy-avatar-section.tsx',
  'renderer/src/components/buddy-look-section.tsx',
  'renderer/src/components/buddy-look-tiles.tsx',
  'renderer/src/components/buddy-reactions-section.tsx',
  'renderer/src/components/buddy-motion-section.tsx',
  'renderer/src/components/buddy-greetings-section.tsx',
  'renderer/src/components/buddy-onboarding.tsx',
  'renderer/src/components/buddy-pet-creator.tsx',
  'renderer/src/components/buddy-pet-preview.tsx',
  'renderer/src/components/buddy-test-dialog.tsx',
  'renderer/src/components/buddy-stream-demo.tsx',
  'renderer/src/components/buddy-picture-card.tsx',
  'renderer/src/lib/buddy-onboarding-copy.ts',
  'renderer/src/lib/buddy-library-view.ts',
  'renderer/src/lib/buddy-look-view.ts',
  'renderer/src/lib/buddy-pet-view.ts',
  'renderer/src/lib/buddy-pet-creator-view.ts',
  'renderer/src/lib/buddy-test-view.ts',
  'renderer/src/lib/buddy-create-gate.ts',
  'renderer/src/lib/buddy-persona-view.ts',
  'renderer/src/lib/buddy-pet-preview-pack.ts',
  'renderer/src/lib/avatar-tab-view.ts',
  'renderer/src/lib/avatar-tabs.ts'
]

const SIDEKICK_ANSWERS =
  'Sidekick (the helper, Premium) answers viewers from what the avatar knows; the avatar only says it'
const SIDEKICK_WRITES =
  'writing greetings with AI is Sidekick, so the avatar Greetings tab points at its switch in Sidekick → Chat'

const SIDEKICK_ALLOWED: readonly Allowed[] = [
  {
    file: 'renderer/src/lib/buddy-onboarding-copy.ts',
    text: "With Sidekick, answers viewers' questions from what you tell it",
    reason: `${SIDEKICK_ANSWERS} (docs/buddy-onboarding-copy.md, word for word with the web)`
  },
  {
    file: 'renderer/src/lib/buddy-onboarding-copy.ts',
    text: "Sidekick answers viewers' questions from this.",
    reason: `${SIDEKICK_ANSWERS}: About you's help line (docs/buddy-onboarding-copy.md)`
  },
  {
    file: 'renderer/src/components/buddy-persona-section.tsx',
    text: 'With Sidekick, it answers viewers who ask it by name',
    reason: SIDEKICK_ANSWERS
  },
  {
    file: 'renderer/src/components/buddy-greetings-section.tsx',
    text: 'Sidekick → ',
    reason: `${SIDEKICK_WRITES}: the pointer's button names that page and tab`
  },
  {
    file: 'renderer/src/components/buddy-greetings-section.tsx',
    text: 'On: Sidekick writes each greeting in ',
    reason: `${SIDEKICK_WRITES}: the pointer says who writes them while the switch is on`
  }
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

/**
 * Every "Buddy" or "Buddies" in a text as the name is written, and every
 * lowercase "buddy" in a sentence. A camelCase identifier (`useBuddyLook`)
 * and a one-word machine value (`buddy`, `bundled:buddy`) never count.
 */
function buddyHits(text: string): number {
  const named = [...text.matchAll(/\bBudd(?:y|ies)\b/g)].length
  const spoken = /\s/.test(text.trim())
    ? [...text.matchAll(/(?<![\w.:/-])budd(?:y|ies)\b(?![\w.:/-])/g)].length
    : 0
  return named + spoken
}

/**
 * Every "Sidekick" or "Sidekicks" in a text as the name is written, and every
 * lowercase "sidekick" in a sentence, like `buddyHits`. A machine value
 * (`sidekick-mark`, `data-slot="sidekick-name"`) never counts.
 */
function sidekickHits(text: string): number {
  const named = [...text.matchAll(/\bSidekicks?\b/g)].length
  const spoken = /\s/.test(text.trim())
    ? [...text.matchAll(/(?<![\w.:/-])sidekicks?\b(?![\w.:/-])/g)].length
    : 0
  return named + spoken
}

/** Every text a person could read in `source`: JSX text, string and template literals. */
function readableTexts(path: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Array<{ line: number; text: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) {
      return
    }
    // Console output is a developer's log, like the copy guards' CODE_CALLS.
    if (ts.isCallExpression(node) && /^console\.\w+$/.test(node.expression.getText(file))) return
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push({ line: line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The renderer's and shared sources a person's words come from, tests excepted. */
function copySources(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.tsx?$/.test(entry) && !/\.(test|d)\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(join(DESKTOP_SOURCE_ROOT, 'renderer'))
  walk(join(DESKTOP_SOURCE_ROOT, 'shared'))
  return files
}

/**
 * The readable texts that still say an old name (Buddy by default), and the
 * allow-list entries that excused one. `files` defaults to every copy source.
 */
function scanCopy(
  allowList: readonly Allowed[],
  hits: (text: string) => number = buddyHits,
  files: readonly string[] = copySources()
): Scan {
  const offenders: string[] = []
  const used = new Set<Allowed>()
  for (const absolute of files) {
    const path = relative(DESKTOP_SOURCE_ROOT, absolute).split(sep).join('/')
    const allowed = allowList.filter((entry) => entry.file === path)
    for (const { line, text } of readableTexts(path, readFileSync(absolute, 'utf8'))) {
      if (hits(text) === 0) continue
      let rest = text
      for (const entry of allowed) {
        if (rest.includes(entry.text)) {
          used.add(entry)
          rest = rest.split(entry.text).join('')
        }
      }
      if (hits(rest) > 0) offenders.push(`${path}:${line}: ${text.trim().slice(0, 120)}`)
    }
  }
  return { offenders, used }
}

/** The avatar-side files that exist, as absolute paths. */
function avatarSideSources(): string[] {
  return AVATAR_SIDE_FILES.map((file) => join(DESKTOP_SOURCE_ROOT, file)).filter((path) =>
    existsSync(path)
  )
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

describe('the companion is not Orcle in the renderer (plan 170 D19, D22)', () => {
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

describe('the companion is not Golem in the renderer (plan 171 D9, D4)', () => {
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

// Whole-source AST scans are CPU-bound; under a parallel full run they can
// pass vitest's 5 s default, like the copy guards.
describe(
  'the companion is Sidekick in renderer copy, not Buddy (plan 236 D-5)',
  { timeout: 30_000 },
  () => {
    const { offenders, used } = scanCopy(BUDDY_ALLOWED)

    it('finds the name as written and "buddy" in a sentence, never in code', () => {
      expect(buddyHits('Buddy, Buddies and Buddy’s look')).toBe(3)
      expect(buddyHits('thanks buddy for the help')).toBe(1)
      expect(buddyHits('useBuddyLook BuddyPetError onBuddyActRequest')).toBe(0)
      expect(buddyHits('buddy')).toBe(0)
      expect(buddyHits('bundled:buddy cohost.buddy.state videorc://buddy /buddy')).toBe(0)
      expect(buddyHits('Sidekick and my sidekick')).toBe(0)
    })

    it('reads JSX text, attributes and string literals, and skips imports', () => {
      const source = [
        "import { BuddyIcon } from '@/components/buddy-emblem'",
        'export const a = <CommandGroup heading="Buddy">Ask Buddy</CommandGroup>',
        'export const b = `Open ${name} in Buddy`',
        '// Buddy in a comment stays',
        "console.warn('[buddy] stopped: Buddy is off')"
      ].join('\n')
      const texts = readableTexts('sample.tsx', source)
        .filter(({ text }) => buddyHits(text) > 0)
        .map(({ line, text }) => `${line}: ${text}`)
      expect(texts).toEqual(['2: Buddy', '2: Ask Buddy', '3:  in Buddy'])
    })

    it('keeps "Buddy" out of every text a person reads, but the allowed ones', () => {
      expect(offenders).toEqual([])
    })

    it('has no allow-list entry that matches nothing', () => {
      expect(staleEntries(BUDDY_ALLOWED, used)).toEqual([])
    })

    it('gives every allow-list entry a reason', () => {
      for (const entry of BUDDY_ALLOWED) expect(entry.reason.length).toBeGreaterThan(20)
    })
  }
)

describe(
  "the avatar's surfaces say avatar, and Sidekick only for the helper (plan 239 D1, C6)",
  { timeout: 30_000 },
  () => {
    const { offenders, used } = scanCopy(SIDEKICK_ALLOWED, sidekickHits, avatarSideSources())

    it('finds the name as written and "sidekick" in a sentence, never in code', () => {
      expect(sidekickHits('Sidekick, Sidekicks and Sidekick’s look')).toBe(3)
      expect(sidekickHits('meet your sidekick today')).toBe(1)
      expect(sidekickHits('SidekickMark sidekickWritesLines useSidekick')).toBe(0)
      expect(sidekickHits('sidekick')).toBe(0)
      expect(sidekickHits('sidekick-mark data-slot="sidekick-name" /sidekick')).toBe(0)
      expect(sidekickHits('Your avatar and my buddy')).toBe(0)
    })

    it('reads every avatar-side file it names', () => {
      expect(
        AVATAR_SIDE_FILES.filter((file) => !existsSync(join(DESKTOP_SOURCE_ROOT, file)))
      ).toEqual([])
      expect(new Set(AVATAR_SIDE_FILES).size).toBe(AVATAR_SIDE_FILES.length)
    })

    it('keeps "Sidekick" off the avatar\'s surfaces, but where a sentence is about the helper', () => {
      expect(offenders).toEqual([])
    })

    it('has no allow-list entry that matches nothing', () => {
      expect(staleEntries(SIDEKICK_ALLOWED, used)).toEqual([])
    })

    it('allows only avatar-side files, each entry with a reason', () => {
      for (const entry of SIDEKICK_ALLOWED) {
        expect(AVATAR_SIDE_FILES).toContain(entry.file)
        expect(entry.reason.length).toBeGreaterThan(20)
      }
    })
  }
)
