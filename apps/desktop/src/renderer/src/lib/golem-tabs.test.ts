import { describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from '@/lib/capture'

import {
  DEFAULT_GOLEM_TAB,
  GOLEM_TABS,
  isGolemTabId,
  openGolemTab,
  readLastGolemTab,
  writeLastGolemTab
} from './golem-tabs'

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

describe('GOLEM_TABS (plan 150)', () => {
  it('lists the five tabs in strip order', () => {
    expect(GOLEM_TABS.map((tab) => tab.id)).toEqual([
      'live',
      'chat',
      'voice',
      'reports',
      'clean-cut'
    ])
    expect(GOLEM_TABS.map((tab) => tab.label)).toEqual([
      'Golem',
      'Chat',
      'Voice',
      'Reports',
      'Clean cut'
    ])
  })

  it('opens on Live by default', () => {
    expect(DEFAULT_GOLEM_TAB).toBe('live')
  })

  it('accepts every tab id and nothing else', () => {
    for (const tab of GOLEM_TABS) expect(isGolemTabId(tab.id)).toBe(true)
    expect(isGolemTabId('Live')).toBe(false)
    expect(isGolemTabId('customize')).toBe(false)
    expect(isGolemTabId(null)).toBe(false)
    expect(isGolemTabId(undefined)).toBe(false)
  })
})

describe('readLastGolemTab', () => {
  it('returns the stored tab', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.golemTab]: 'reports' })
    expect(readLastGolemTab(storage)).toBe('reports')
  })

  it('falls back to Live when nothing or an unknown id is stored', () => {
    expect(readLastGolemTab(memoryStorage())).toBe('live')
    expect(readLastGolemTab(memoryStorage({ [STORAGE_KEYS.golemTab]: 'customize' }))).toBe('live')
  })

  it('falls back to Live when storage throws or is missing', () => {
    expect(readLastGolemTab(throwingStorage)).toBe('live')
    expect(readLastGolemTab(null)).toBe('live')
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
      expect(readLastGolemTab()).toBe('live')
      expect(() => writeLastGolemTab('voice')).not.toThrow()
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    }
  })
})

describe('writeLastGolemTab', () => {
  it('stores the tab so the next read reopens it', () => {
    const storage = memoryStorage()
    writeLastGolemTab('clean-cut', storage)
    expect(storage.getItem(STORAGE_KEYS.golemTab)).toBe('clean-cut')
    expect(readLastGolemTab(storage)).toBe('clean-cut')
  })

  it('never throws when storage refuses the write', () => {
    expect(() => writeLastGolemTab('chat', throwingStorage)).not.toThrow()
  })
})

describe('openGolemTab', () => {
  it('asks the shell to open Golem on the tab, on the workspace navigation event', () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('videorc:navigate-workspace', (event) =>
      opened.push((event as CustomEvent).detail)
    )
    vi.stubGlobal('window', target)
    try {
      openGolemTab('voice')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(opened).toEqual([{ tab: 'ai', golemTab: 'voice' }])
  })
})
