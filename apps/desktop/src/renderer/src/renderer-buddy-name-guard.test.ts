import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Plan 170 (Phase R, step 4): the companion is Golem everywhere. "Orcle", in
// any case, may appear in the renderer's sources only as one of the values
// below. Each keeps the old name because it is saved on the user's machine
// or crosses a process boundary, and an older app reads or writes it (plan
// 170 D22). Nothing here is ever shown to anyone. An entry that matches
// nothing fails too, so the list never outlives the values it excuses.

const RENDERER_ROOT = join(__dirname, '..')
const SELF = 'src/renderer-buddy-name-guard.test.ts'

interface Allowed {
  /** Path under `apps/desktop/src/renderer/`, forward slashes. */
  file: string
  /** The exact text that may carry the old name. */
  text: string
  reason: string
}

const SAVED_TAB_KEY = 'the saved Golem sub-tab key; renaming it forgets the tab'
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

const ALLOWED: readonly Allowed[] = [
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

/**
 * Every "orcle" in a line, in any case, except the camelCase seam of a word
 * ending in "for" before one starting "Clean" (`streamingForCleanup`).
 */
function oldNameHits(line: string): number {
  return [...line.matchAll(/orcle/gi)].filter((match) => match[0] !== 'orCle').length
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

function scan(): Scan {
  const offenders: string[] = []
  const used = new Set<Allowed>()
  for (const absolute of rendererFiles()) {
    const path = relative(RENDERER_ROOT, absolute).split(sep).join('/')
    if (path === SELF) continue
    const allowed = ALLOWED.filter((entry) => entry.file === path)
    readFileSync(absolute, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (oldNameHits(line) === 0) return
        let rest = line
        for (const entry of allowed) {
          if (rest.includes(entry.text)) {
            used.add(entry)
            rest = rest.split(entry.text).join('')
          }
        }
        if (oldNameHits(rest) > 0) offenders.push(`${path}:${index + 1}: ${line.trim()}`)
      })
  }
  return { offenders, used }
}

describe('the companion is Golem in the renderer (plan 170 D19, D22)', () => {
  const { offenders, used } = scan()

  it('finds the old name in every case, but not inside a camelCase seam', () => {
    expect(oldNameHits('Orcle, ORCLE and orcle-voice')).toBe(3)
    expect(oldNameHits('streamingForCleanup ownerForCleanup')).toBe(0)
  })

  it('keeps "Orcle" out of every renderer source but the saved and wire values', () => {
    expect(offenders).toEqual([])
  })

  it('has no allow-list entry that matches nothing', () => {
    const stale = ALLOWED.filter((entry) => !used.has(entry)).map(
      (entry) => `${entry.file}: ${entry.text}`
    )
    expect(stale).toEqual([])
  })

  it('gives every allow-list entry a reason', () => {
    for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(20)
  })
})
