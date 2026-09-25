import { describe, expect, it } from 'vitest'

import { STORAGE_KEYS } from '@/lib/capture'

import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  isSettingsTabId,
  readLastSettingsTab,
  writeLastSettingsTab
} from './settings-tabs'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value)
  }
}

const throwingStorage: Storage = {
  length: 0,
  clear: () => undefined,
  getItem: () => {
    throw new Error('storage blocked')
  },
  key: () => null,
  removeItem: () => undefined,
  setItem: () => {
    throw new Error('storage blocked')
  }
}

describe('SETTINGS_TABS', () => {
  it('lists the seven tabs in strip order', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'general',
      'recording',
      'permissions',
      'shortcuts',
      'remote',
      'orcle',
      'about'
    ])
    expect(SETTINGS_TABS.map((tab) => tab.label)).toEqual([
      'General',
      'Recording',
      'Permissions',
      'Shortcuts',
      'Remote',
      'Orcle',
      'About'
    ])
  })

  it('opens on General by default', () => {
    expect(DEFAULT_SETTINGS_TAB).toBe('general')
  })
})

describe('isSettingsTabId', () => {
  it('accepts every tab id and nothing else', () => {
    for (const tab of SETTINGS_TABS) {
      expect(isSettingsTabId(tab.id)).toBe(true)
    }
    expect(isSettingsTabId('General')).toBe(false)
    expect(isSettingsTabId('settings')).toBe(false)
    expect(isSettingsTabId(null)).toBe(false)
    expect(isSettingsTabId(undefined)).toBe(false)
  })
})

describe('readLastSettingsTab', () => {
  it('returns the stored tab', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.settingsTab]: 'shortcuts' })
    expect(readLastSettingsTab(storage)).toBe('shortcuts')
  })

  it('falls back to General when nothing is stored', () => {
    expect(readLastSettingsTab(memoryStorage())).toBe('general')
  })

  it('falls back to General for an id that is not a tab (a renamed or removed tab)', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.settingsTab]: 'co-host' })
    expect(readLastSettingsTab(storage)).toBe('general')
  })

  it('falls back to General when storage throws or is missing', () => {
    expect(readLastSettingsTab(throwingStorage)).toBe('general')
    expect(readLastSettingsTab(undefined)).toBe('general')
  })
})

describe('writeLastSettingsTab', () => {
  it('stores the tab so the next read reopens it', () => {
    const storage = memoryStorage()
    writeLastSettingsTab('about', storage)
    expect(storage.getItem(STORAGE_KEYS.settingsTab)).toBe('about')
    expect(readLastSettingsTab(storage)).toBe('about')
  })

  it('never throws when storage refuses the write', () => {
    expect(() => writeLastSettingsTab('remote', throwingStorage)).not.toThrow()
  })
})
