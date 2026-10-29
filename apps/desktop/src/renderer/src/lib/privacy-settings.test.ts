// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS,
  initialFollowFrontAppState,
  reduceFollowFrontApp,
  type FollowFrontAppContext
} from './follow-front-app'
import {
  addPasswordManager,
  BUILT_IN_PASSWORD_MANAGERS,
  builtInPasswordManagersRemoved,
  canRemovePasswordManager,
  DEFAULT_PRIVACY_SETTINGS,
  getPrivacySettings,
  loadPrivacySettings,
  parsePrivacySettings,
  passwordManagerEntries,
  passwordManagerFollowContext,
  PRIVACY_SETTINGS_STORAGE_KEY,
  removePasswordManager,
  resetPrivacySettingsForTest,
  restoreBuiltInPasswordManagers,
  savePrivacySettings,
  setHideForPasswordManagers,
  updatePrivacySettings,
  usePrivacySettings,
  type PrivacySettings
} from './privacy-settings'

const names = (settings: PrivacySettings): string[] =>
  passwordManagerEntries(settings).map((entry) => entry.name)

/** Whether S10's follower would hide for this app on a display scene. */
function hidesFor(settings: PrivacySettings, bundleId: string): boolean {
  const context: FollowFrontAppContext = {
    now: 1000,
    scenes: [],
    lastUsedAt: {},
    videorcBundleIds: ['com.videorc.app'],
    screenSource: 'display',
    sessionState: 'streaming',
    orientation: 'horizontal',
    currentSceneId: null,
    ...passwordManagerFollowContext(settings)
  }
  const front = reduceFollowFrontApp(
    initialFollowFrontAppState(),
    { type: 'front-changed', bundleId, name: bundleId, pid: 7 },
    { ...context, now: 0 }
  )
  const settled = reduceFollowFrontApp(front.state, { type: 'tick', now: 1000 }, context)
  return settled.actions.some((action) => action.type === 'hide')
}

describe('privacy settings (plan 210 D11)', () => {
  it('names every built-in bundle id exactly once, grouped by product', () => {
    const grouped = BUILT_IN_PASSWORD_MANAGERS.flatMap((app) => app.bundleIds)
    expect([...grouped].sort()).toEqual([...DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(names(DEFAULT_PRIVACY_SETTINGS)).toEqual([
      '1Password',
      'Bitwarden',
      'Dashlane',
      'Keeper',
      'LastPass',
      'Passwords',
      'Keychain Access',
      'Proton Pass',
      'KeePassXC',
      'Enpass'
    ])
  })

  it('is on with the built-in list by default, and the follower hides for each variant', () => {
    expect(DEFAULT_PRIVACY_SETTINGS.hideForPasswordManagers).toBe(true)
    expect(passwordManagerFollowContext(DEFAULT_PRIVACY_SETTINGS)).toEqual({
      passwordManagerHideEnabled: true,
      passwordManagerBundleIds: [],
      removedPasswordManagerBundleIds: []
    })
    expect(hidesFor(DEFAULT_PRIVACY_SETTINGS, 'com.agilebits.onepassword7')).toBe(true)
    expect(hidesFor(DEFAULT_PRIVACY_SETTINGS, 'com.apple.Safari')).toBe(false)
  })

  it('adds an app once, by bundle id, and the follower hides for it', () => {
    const app = { bundleId: 'com.example.Vault', name: 'Vault' }
    const added = addPasswordManager(DEFAULT_PRIVACY_SETTINGS, app)
    expect(names(added).at(-1)).toBe('Vault')
    expect(addPasswordManager(added, { bundleId: 'COM.EXAMPLE.VAULT', name: 'Vault' })).toBe(added)
    expect(passwordManagerFollowContext(added).passwordManagerBundleIds).toEqual([
      'com.example.Vault'
    ])
    expect(hidesFor(added, 'com.example.vault')).toBe(true)
    // Removing an added app forgets it.
    const removed = removePasswordManager(added, 'com.example.Vault')
    expect(removed.addedPasswordManagers).toEqual([])
    expect(hidesFor(removed, 'com.example.Vault')).toBe(false)
  })

  it('takes a built-in app off whole, and adding it back restores every variant', () => {
    const removed = removePasswordManager(DEFAULT_PRIVACY_SETTINGS, 'com.1password.1password')
    expect(names(removed)).not.toContain('1Password')
    expect(removed.removedPasswordManagerBundleIds).toHaveLength(4)
    expect(builtInPasswordManagersRemoved(removed)).toBe(true)
    for (const id of BUILT_IN_PASSWORD_MANAGERS[0].bundleIds)
      expect(hidesFor(removed, id)).toBe(false)
    expect(hidesFor(removed, 'com.bitwarden.desktop')).toBe(true)

    // A running 1Password chosen through Add app… is the built-in entry again.
    const back = addPasswordManager(removed, {
      bundleId: 'com.agilebits.onepassword7',
      name: '1Password 7'
    })
    expect(back.removedPasswordManagerBundleIds).toEqual([])
    expect(back.addedPasswordManagers).toEqual([])
    expect(names(back)[0]).toBe('1Password')
    expect(restoreBuiltInPasswordManagers(removed).removedPasswordManagerBundleIds).toEqual([])
  })

  it('keeps the last app on the list, and an empty list means the built-in one', () => {
    let settings = DEFAULT_PRIVACY_SETTINGS
    for (const app of BUILT_IN_PASSWORD_MANAGERS)
      settings = removePasswordManager(settings, app.bundleIds[0])
    expect(names(settings)).toEqual(['Enpass'])
    expect(canRemovePasswordManager(settings)).toBe(false)
    expect(removePasswordManager(settings, 'in.sinew.Enpass-Desktop')).toBe(settings)

    // Stored by an older build or by hand: every built-in removed, none added.
    const empty = parsePrivacySettings({
      removedPasswordManagerBundleIds: DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS
    })
    expect(names(empty)).toEqual(names(DEFAULT_PRIVACY_SETTINGS))
    expect(passwordManagerFollowContext(empty).removedPasswordManagerBundleIds).toEqual([])
    expect(hidesFor(empty, 'com.bitwarden.desktop')).toBe(true)
  })

  it('turns the switch off and on, and the follower stops hiding while it is off', () => {
    const off = setHideForPasswordManagers(DEFAULT_PRIVACY_SETTINGS, false)
    expect(off.hideForPasswordManagers).toBe(false)
    expect(passwordManagerFollowContext(off).passwordManagerHideEnabled).toBe(false)
    expect(hidesFor(off, 'com.bitwarden.desktop')).toBe(false)
    expect(setHideForPasswordManagers(off, false)).toBe(off)
    expect(setHideForPasswordManagers(off, true).hideForPasswordManagers).toBe(true)
  })

  it('reads stored settings field by field and drops what it cannot use', () => {
    expect(parsePrivacySettings(null)).toEqual(DEFAULT_PRIVACY_SETTINGS)
    expect(parsePrivacySettings('nonsense')).toEqual(DEFAULT_PRIVACY_SETTINGS)
    expect(
      parsePrivacySettings({
        hideForPasswordManagers: 'yes',
        addedPasswordManagers: [
          { bundleId: 'com.example.Vault', name: 'Vault' },
          { bundleId: 'com.example.vault', name: 'Duplicate' },
          { bundleId: 'com.bitwarden.desktop', name: 'Built in' },
          { bundleId: 42 },
          { bundleId: 'com.example.NoName' }
        ],
        removedPasswordManagerBundleIds: ['com.apple.Passwords', 'com.example.NotBuiltIn', 7]
      })
    ).toEqual({
      hideForPasswordManagers: true,
      addedPasswordManagers: [
        { bundleId: 'com.example.Vault', name: 'Vault' },
        { bundleId: 'com.example.NoName', name: 'com.example.NoName' }
      ],
      removedPasswordManagerBundleIds: ['com.apple.Passwords']
    })
  })

  it('stores nothing for the defaults and round-trips a change', () => {
    const storage = new Map<string, string>()
    const store = {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => void storage.set(name, value),
      removeItem: (name: string) => void storage.delete(name)
    }
    const changed = addPasswordManager(
      setHideForPasswordManagers(DEFAULT_PRIVACY_SETTINGS, false),
      {
        bundleId: 'com.example.Vault',
        name: 'Vault'
      }
    )
    savePrivacySettings(changed, store)
    expect(storage.has(PRIVACY_SETTINGS_STORAGE_KEY)).toBe(true)
    expect(loadPrivacySettings(store)).toEqual(changed)
    savePrivacySettings(DEFAULT_PRIVACY_SETTINGS, store)
    expect(storage.has(PRIVACY_SETTINGS_STORAGE_KEY)).toBe(false)
    expect(loadPrivacySettings(store)).toEqual(DEFAULT_PRIVACY_SETTINGS)
  })
})

describe('privacy settings store', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    localStorage.clear()
    resetPrivacySettingsForTest()
  })
  afterEach(() => {
    localStorage.clear()
    resetPrivacySettingsForTest()
    vi.unstubAllGlobals()
  })

  it('reads the stored value once, persists updates and re-renders readers', async () => {
    localStorage.setItem(
      PRIVACY_SETTINGS_STORAGE_KEY,
      JSON.stringify({ hideForPasswordManagers: false })
    )
    expect(getPrivacySettings().hideForPasswordManagers).toBe(false)

    const seen: boolean[] = []
    function Reader(): null {
      seen.push(usePrivacySettings().hideForPasswordManagers)
      return null
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(createElement(Reader)))
    await act(async () =>
      updatePrivacySettings((settings) => setHideForPasswordManagers(settings, true))
    )
    expect(seen).toEqual([false, true])
    expect(getPrivacySettings().hideForPasswordManagers).toBe(true)
    // Back to the defaults: nothing stays stored.
    expect(localStorage.getItem(PRIVACY_SETTINGS_STORAGE_KEY)).toBeNull()
    await act(async () => root.unmount())
  })
})
