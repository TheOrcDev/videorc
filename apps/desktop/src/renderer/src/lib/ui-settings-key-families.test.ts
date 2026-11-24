import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LOCAL_STORAGE_ALLOWLIST,
  UI_SETTINGS_MOVED_KEYS,
  type UiSettingsKeyName
} from './ui-settings-key-families'

// Plan 220 S1.4b: no product state in the renderer's web storage. Every
// renderer source that names it is on the documented allowlist, with the
// exact number of mentions, so a new use (or a family moved back) fails here
// until the list and docs/rust-ui/ui-settings.md say why. Tests may stub web
// storage for their environment (the store's journal and the conveniences
// use it), so only sources are held to the list.

const RENDERER_ROOT = join(__dirname, '..', '..')
const WEB_STORAGE = /\b(?:localStorage|sessionStorage)\b/g

const previousReleaseKeys = Object.keys(
  (
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../../../protocol-fixtures/ui-settings-previous-release-profile.json',
          import.meta.url
        ),
        'utf8'
      )
    ) as { localStorage: Record<string, string> }
  ).localStorage
)

function rendererSources(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.(tsx?|js|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

function webStorageMentions(): Map<string, number> {
  const mentions = new Map<string, number>()
  for (const absolute of rendererSources()) {
    const count = [...readFileSync(absolute, 'utf8').matchAll(WEB_STORAGE)].length
    if (count > 0) mentions.set(relative(RENDERER_ROOT, absolute).split(sep).join('/'), count)
  }
  return mentions
}

function names(key: string, entry: UiSettingsKeyName): boolean {
  return entry.prefix ? key.startsWith(entry.key) && key !== entry.key : key === entry.key
}

/** The conveniences that keep a key in web storage (the store's own files keep only its machinery). */
const CONVENIENCE_KEYS = LOCAL_STORAGE_ALLOWLIST.filter(
  (entry) => !entry.file.startsWith('src/lib/ui-settings-')
).flatMap((entry) => entry.keys)

describe('UI settings key families (plan 220 S1.4b)', () => {
  it('finds web storage only where the allowlist says, as often as it says', () => {
    const found = Object.fromEntries(webStorageMentions())
    const allowed = Object.fromEntries(
      LOCAL_STORAGE_ALLOWLIST.map((entry) => [entry.file, entry.mentions])
    )
    expect(found).toEqual(allowed)
  })

  it('gives every allowance a reason and its keys', () => {
    for (const entry of LOCAL_STORAGE_ALLOWLIST) {
      expect(entry.why.length, entry.file).toBeGreaterThan(20)
      expect(entry.keys.length, entry.file).toBeGreaterThan(0)
    }
  })

  it('never moves a key and keeps it as a convenience at once', () => {
    for (const moved of UI_SETTINGS_MOVED_KEYS) {
      for (const convenience of CONVENIENCE_KEYS) {
        // The theme is the one key with both: the store's value and its pre-paint copy.
        if (moved.key === 'videorc.theme' && convenience.key === 'videorc.theme') continue
        expect(moved.key === convenience.key, moved.key).toBe(false)
      }
    }
  })

  it('places every key the previous release could write: moved, or a named convenience', () => {
    const unplaced = previousReleaseKeys.filter(
      (key) =>
        !UI_SETTINGS_MOVED_KEYS.some((entry) => names(key, entry)) &&
        !CONVENIENCE_KEYS.some((entry) => names(key, entry))
    )
    expect(unplaced).toEqual([])
    for (const entry of UI_SETTINGS_MOVED_KEYS) {
      expect(
        previousReleaseKeys.some((key) => names(key, entry)),
        `${entry.key} is missing from the previous-release fixture`
      ).toBe(true)
    }
  })

  it('reads every moved family from the store, and none from web storage', () => {
    for (const entry of UI_SETTINGS_MOVED_KEYS) {
      expect(entry.family.length, entry.key).toBeGreaterThan(0)
    }
    // "lib/capture.ts STORAGE_KEYS.settings (use-studio)" names src/lib/capture.ts.
    const familyFiles = new Set(
      UI_SETTINGS_MOVED_KEYS.flatMap((entry) =>
        entry.family
          .split(/,\s*/)
          .map((family) => family.split(' ')[0])
          .map((family) => (family.startsWith('comments/') ? family : `src/${family}`))
      )
    )
    const mentions = webStorageMentions()
    const allowed = new Set(LOCAL_STORAGE_ALLOWLIST.map((entry) => entry.file))
    for (const file of familyFiles) {
      expect(statSync(join(RENDERER_ROOT, file)).isFile(), file).toBe(true)
      // A family file that also holds a convenience has its count pinned above.
      if (allowed.has(file)) continue
      expect(mentions.get(file) ?? 0, file).toBe(0)
    }
  })
})
