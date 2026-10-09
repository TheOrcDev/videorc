import { describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from '@/lib/capture'

import {
  DEFAULT_BUDDY_TAB,
  BUDDY_TABS,
  isBuddyTabId,
  openBuddyTab,
  readLastBuddyTab,
  writeLastBuddyTab
} from './buddy-tabs'

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

describe('BUDDY_TABS (plan 150)', () => {
  it('lists the five tabs in strip order', () => {
    expect(BUDDY_TABS.map((tab) => tab.id)).toEqual([
      'live',
      'chat',
      'voice',
      'reports',
      'clean-cut'
    ])
    expect(BUDDY_TABS.map((tab) => tab.label)).toEqual([
      'Buddy',
      'Chat',
      'Voice',
      'Reports',
      'Clean cut'
    ])
  })

  it('opens on Live by default', () => {
    expect(DEFAULT_BUDDY_TAB).toBe('live')
  })

  it('accepts every tab id and nothing else', () => {
    for (const tab of BUDDY_TABS) expect(isBuddyTabId(tab.id)).toBe(true)
    expect(isBuddyTabId('Live')).toBe(false)
    expect(isBuddyTabId('customize')).toBe(false)
    expect(isBuddyTabId(null)).toBe(false)
    expect(isBuddyTabId(undefined)).toBe(false)
  })
})

describe('readLastBuddyTab', () => {
  it('returns the stored tab', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.buddyTab]: 'reports' })
    expect(readLastBuddyTab(storage)).toBe('reports')
  })

  it('falls back to Live when nothing or an unknown id is stored', () => {
    expect(readLastBuddyTab(memoryStorage())).toBe('live')
    expect(readLastBuddyTab(memoryStorage({ [STORAGE_KEYS.buddyTab]: 'customize' }))).toBe('live')
  })

  it('falls back to Live when storage throws or is missing', () => {
    expect(readLastBuddyTab(throwingStorage)).toBe('live')
    expect(readLastBuddyTab(null)).toBe('live')
  })

  it('falls back to Live when even reading localStorage throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: access denied')
      }
    })
    try {
      expect(readLastBuddyTab()).toBe('live')
      expect(() => writeLastBuddyTab('voice')).not.toThrow()
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    }
  })
})

describe('writeLastBuddyTab', () => {
  it('stores the tab so the next read reopens it', () => {
    const storage = memoryStorage()
    writeLastBuddyTab('clean-cut', storage)
    expect(storage.getItem(STORAGE_KEYS.buddyTab)).toBe('clean-cut')
    expect(readLastBuddyTab(storage)).toBe('clean-cut')
  })

  it('never throws when storage refuses the write', () => {
    expect(() => writeLastBuddyTab('chat', throwingStorage)).not.toThrow()
  })
})

describe('openBuddyTab', () => {
  it('asks the shell to open Buddy on the tab, on the workspace navigation event', () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('videorc:navigate-workspace', (event) =>
      opened.push((event as CustomEvent).detail)
    )
    vi.stubGlobal('window', target)
    try {
      openBuddyTab('voice')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(opened).toEqual([{ tab: 'ai', buddyTab: 'voice' }])
  })
})
