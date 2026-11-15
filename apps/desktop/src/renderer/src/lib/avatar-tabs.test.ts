import { describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from '@/lib/capture'

import {
  AVATAR_TAB_LABEL,
  AVATAR_TABS,
  DEFAULT_AVATAR_TAB,
  isAvatarTabId,
  openAvatarTab,
  readLastAvatarTab,
  writeLastAvatarTab
} from './avatar-tabs'
import { BUDDY_TABS, isBuddyTabId } from './buddy-tabs'

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

describe('AVATAR_TABS (plan 239)', () => {
  it('names the page Avatar and lists Profile, then Greetings', () => {
    expect(AVATAR_TAB_LABEL).toBe('Avatar')
    expect(AVATAR_TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ['profile', 'Profile'],
      ['greetings', 'Greetings']
    ])
  })

  it('opens on Profile by default', () => {
    expect(DEFAULT_AVATAR_TAB).toBe('profile')
  })

  it('accepts every tab id and nothing else', () => {
    for (const tab of AVATAR_TABS) expect(isAvatarTabId(tab.id)).toBe(true)
    expect(isAvatarTabId('Profile')).toBe(false)
    expect(isAvatarTabId('live')).toBe(false)
    expect(isAvatarTabId(null)).toBe(false)
    expect(isAvatarTabId(undefined)).toBe(false)
  })

  it("shares no tab id with the Sidekick page, so a behaviour chip's tab picks its page", () => {
    for (const tab of AVATAR_TABS) expect(isBuddyTabId(tab.id)).toBe(false)
    for (const tab of BUDDY_TABS) expect(isAvatarTabId(tab.id)).toBe(false)
  })
})

describe('readLastAvatarTab', () => {
  it('returns the stored tab, under its own key', () => {
    expect(STORAGE_KEYS.avatarTab).toBe('videorc.avatarTab')
    const storage = memoryStorage({ [STORAGE_KEYS.avatarTab]: 'greetings' })
    expect(readLastAvatarTab(storage)).toBe('greetings')
  })

  it('falls back to Profile when nothing, an unknown id or a Sidekick tab is stored', () => {
    expect(readLastAvatarTab(memoryStorage())).toBe('profile')
    expect(readLastAvatarTab(memoryStorage({ [STORAGE_KEYS.avatarTab]: 'look' }))).toBe('profile')
    expect(readLastAvatarTab(memoryStorage({ [STORAGE_KEYS.avatarTab]: 'chat' }))).toBe('profile')
    // The Sidekick page's saved tab is its own: it never opens Avatar.
    expect(readLastAvatarTab(memoryStorage({ [STORAGE_KEYS.buddyTab]: 'greetings' }))).toBe(
      'profile'
    )
  })

  it('falls back to Profile when storage throws or is missing', () => {
    expect(readLastAvatarTab(throwingStorage)).toBe('profile')
    expect(readLastAvatarTab(null)).toBe('profile')
  })

  it('falls back to Profile when even reading localStorage throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: access denied')
      }
    })
    try {
      expect(readLastAvatarTab()).toBe('profile')
      expect(() => writeLastAvatarTab('greetings')).not.toThrow()
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    }
  })
})

describe('writeLastAvatarTab', () => {
  it('stores the tab so the next read reopens it', () => {
    const storage = memoryStorage()
    writeLastAvatarTab('greetings', storage)
    expect(storage.getItem(STORAGE_KEYS.avatarTab)).toBe('greetings')
    expect(storage.getItem(STORAGE_KEYS.buddyTab)).toBeNull()
    expect(readLastAvatarTab(storage)).toBe('greetings')
  })

  it('never throws when storage refuses the write', () => {
    expect(() => writeLastAvatarTab('profile', throwingStorage)).not.toThrow()
  })
})

describe('openAvatarTab', () => {
  it('asks the shell to open Avatar on the tab, on the workspace navigation event', () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('videorc:navigate-workspace', (event) =>
      opened.push((event as CustomEvent).detail)
    )
    vi.stubGlobal('window', target)
    try {
      openAvatarTab('greetings')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(opened).toEqual([{ tab: 'avatar', avatarTab: 'greetings' }])
  })
})
