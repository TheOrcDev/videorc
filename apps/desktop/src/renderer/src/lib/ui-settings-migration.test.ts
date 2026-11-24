import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { reconcileRegistry } from './background-assets'
import { readBuddyInvitationDismissed } from './buddy-library-view'
import { readBuddyPetReviewMarks } from './buddy-pet-review-marks'
import { readBuddyWornPack } from './buddy-worn-pack'
import { loadCaptureConfig, loadJson, STORAGE_KEYS } from './capture'
import {
  CLEAN_CUT_ATTEMPTED_STORAGE_KEY,
  CLEAN_CUT_AUTO_STORAGE_KEY,
  cleanCutAutoFromStorage
} from './clean-cut-auto'
import { CLEAN_CUT_ANNOUNCED_STORAGE_KEY } from './clean-cut-notify'
import {
  COHOST_NUDGE_STORAGE_KEY,
  COHOST_SENSITIVITY_STORAGE_KEY,
  cohostNudgeDismissedFromStorage,
  cohostSensitivityFromStorage,
  readCohostListenPromptDismissed
} from './cohost-view'
import { createFirstRunStartup } from './first-run'
import { loadFollowSettings } from './follow-settings'
import { loadPrivacySettings } from './privacy-settings'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  SCENE_LIBRARY_KEY,
  WORKING_SCENE_KEY
} from './scene-presets'
import { rememberedSceneApps, SCENE_WINDOW_APPS_KEY } from './scene-window-state'
import { SCENES_KEY } from './scenes'
import { loadScreenTakeoverMuteOwnership } from './screen-takeover-microphone'
import { loadStatsLayout, statsLayoutStorage } from './stream-manager-stats-layout'
import { UI_SETTINGS_MOVED_KEYS } from './ui-settings-key-families'
import { uiSettingsStorage } from './ui-settings-storage'
import { createMemoryUiSettingsEngine, installTestUiSettingsStore } from './ui-settings-test-store'
import { WHATS_NEW_STORAGE_KEY } from './whats-new'

// Plan 220 S1.4b: a profile the previous release wrote keeps every value once
// the families read the backend store. The S1.4a migration copies the
// fixture's web storage into a fresh engine; each moved family then reads the
// migrated store and must answer exactly as it answered from the previous
// release's web storage.

const previousRelease = (
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

/** The previous release's web storage, read the way its families read it. */
function previousReleaseStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  key(index: number): string | null
  readonly length: number
} {
  const values = new Map(Object.entries(previousRelease))
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    }
  }
}

async function migratedProfile(): Promise<void> {
  const engine = createMemoryUiSettingsEngine({}, { localStorageMigrated: false })
  const { store } = await installTestUiSettingsStore({ engine, storage: previousReleaseStorage() })
  expect(store.status().hydration).toMatchObject({ state: 'hydrated', skipped: [] })
}

function movedKeysInFixture(): string[] {
  return Object.keys(previousRelease).filter((key) =>
    UI_SETTINGS_MOVED_KEYS.some((entry) =>
      entry.prefix ? key.startsWith(entry.key) : key === entry.key
    )
  )
}

describe('a previous-release profile through the moved key families (plan 220 S1.4b)', () => {
  it('keeps every moved key, byte for byte, in the store', async () => {
    await migratedProfile()
    const keys = movedKeysInFixture()
    expect(keys.length).toBe(UI_SETTINGS_MOVED_KEYS.length)
    for (const key of keys) {
      expect(uiSettingsStorage().getItem(key), key).toBe(previousRelease[key])
    }
  })

  it('answers every family as the previous release did', async () => {
    await migratedProfile()
    const before = previousReleaseStorage()
    const after = uiSettingsStorage()
    const read = (key: string): [string | null, string | null] => [
      before.getItem(key),
      after.getItem(key)
    ]
    const same = <T>(label: string, reader: (storage: typeof before | typeof after) => T): void => {
      expect(reader(after), label).toEqual(reader(before))
    }

    // Studio: settings, capture config, scenes, backgrounds, output choice.
    expect(loadJson(STORAGE_KEYS.settings, {})).toEqual(
      JSON.parse(previousRelease[STORAGE_KEYS.settings])
    )
    expect(loadJson(STORAGE_KEYS.captureConfig, {})).toEqual(
      JSON.parse(previousRelease[STORAGE_KEYS.captureConfig])
    )
    expect(loadCaptureConfig().layout).toBeDefined()
    expect(hydrateSceneLibrary(loadJson(SCENE_LIBRARY_KEY, null))).toEqual(
      hydrateSceneLibrary(JSON.parse(previousRelease[SCENE_LIBRARY_KEY]))
    )
    // Plan 231's library (`use-scenes.ts`), which every saved scene now lives in.
    expect(loadJson(SCENES_KEY, null)).toEqual(JSON.parse(previousRelease[SCENES_KEY]))
    expect(hydrateWorkingScene(loadJson(WORKING_SCENE_KEY, null))).toEqual(
      hydrateWorkingScene(JSON.parse(previousRelease[WORKING_SCENE_KEY]))
    )
    expect(rememberedSceneApps(loadJson(SCENE_WINDOW_APPS_KEY, {}), [])).toEqual(
      rememberedSceneApps(JSON.parse(previousRelease[SCENE_WINDOW_APPS_KEY]), [])
    )
    expect(reconcileRegistry(loadJson(STORAGE_KEYS.backgroundAssets, null))).toEqual(
      reconcileRegistry(JSON.parse(previousRelease[STORAGE_KEYS.backgroundAssets]))
    )
    const [chosenBefore, chosenAfter] = read(STORAGE_KEYS.outputChosenByUser)
    expect(chosenAfter !== null).toBe(chosenBefore !== null)

    // First run, onboarding and What's New.
    same('first run', (storage) => {
      const startup = createFirstRunStartup({ getItem: storage.getItem, setItem: () => {} })
      return { snapshot: startup.snapshot, step: startup.step, goal: startup.goal }
    })
    expect(read(WHATS_NEW_STORAGE_KEY)[1]).toBe(read(WHATS_NEW_STORAGE_KEY)[0])
    expect(read(STORAGE_KEYS.theme)[1]).toBe(read(STORAGE_KEYS.theme)[0])

    // Consents and Clean cut.
    expect(read('videorc.aiConsent')[1] === '1').toBe(read('videorc.aiConsent')[0] === '1')
    expect(read('videorc.buddyAutoChatConsent')[1]).toBe(read('videorc.buddyAutoChatConsent')[0])
    expect(cleanCutAutoFromStorage(read(CLEAN_CUT_AUTO_STORAGE_KEY)[1])).toBe(
      cleanCutAutoFromStorage(read(CLEAN_CUT_AUTO_STORAGE_KEY)[0])
    )
    expect(read(CLEAN_CUT_ATTEMPTED_STORAGE_KEY)[1]).toBe(read(CLEAN_CUT_ATTEMPTED_STORAGE_KEY)[0])
    expect(read(CLEAN_CUT_ANNOUNCED_STORAGE_KEY)[1]).toBe(read(CLEAN_CUT_ANNOUNCED_STORAGE_KEY)[0])

    // Scene following and privacy.
    same('follow settings', (storage) => loadFollowSettings(storage))
    same('privacy settings', (storage) => loadPrivacySettings(storage))

    // Buddy.
    same('pet review marks', (storage) => readBuddyPetReviewMarks(storage))
    same('invitation', (storage) => readBuddyInvitationDismissed(storage))
    same('worn pack', (storage) => readBuddyWornPack('persona-default', storage))
    same('listen prompt', (storage) => readCohostListenPromptDismissed(storage))
    expect(cohostSensitivityFromStorage(read(COHOST_SENSITIVITY_STORAGE_KEY)[1])).toBe(
      cohostSensitivityFromStorage(read(COHOST_SENSITIVITY_STORAGE_KEY)[0])
    )
    expect(cohostNudgeDismissedFromStorage(read(COHOST_NUDGE_STORAGE_KEY)[1])).toBe(
      cohostNudgeDismissedFromStorage(read(COHOST_NUDGE_STORAGE_KEY)[0])
    )

    // Stream Manager and the screen takeover.
    expect(loadStatsLayout(statsLayoutStorage())).toEqual(loadStatsLayout(before))
    same('takeover mute ownership', (storage) => loadScreenTakeoverMuteOwnership(storage))
  })
})
