import { describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from '@/lib/capture'

import {
  DEFAULT_ORCLE_TAB,
  ORCLE_TABS,
  isOrcleTabId,
  openOrcleTab,
  readLastOrcleTab,
  writeLastOrcleTab
} from './orcle-tabs'

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

describe('ORCLE_TABS (plan 150)', () => {
  it('lists the five tabs in strip order', () => {
    expect(ORCLE_TABS.map((tab) => tab.id)).toEqual([
      'live',
      'chat',
      'voice',
      'reports',
      'clean-cut'
    ])
    expect(ORCLE_TABS.map((tab) => tab.label)).toEqual([
      'Golem',
      'Chat',
      'Voice',
      'Reports',
      'Clean cut'
    ])
  })

  it('opens on Live by default', () => {
    expect(DEFAULT_ORCLE_TAB).toBe('live')
  })

  it('accepts every tab id and nothing else', () => {
    for (const tab of ORCLE_TABS) expect(isOrcleTabId(tab.id)).toBe(true)
    expect(isOrcleTabId('Live')).toBe(false)
    expect(isOrcleTabId('customize')).toBe(false)
    expect(isOrcleTabId(null)).toBe(false)
    expect(isOrcleTabId(undefined)).toBe(false)
  })
})

describe('readLastOrcleTab', () => {
  it('returns the stored tab', () => {
    const storage = memoryStorage({ [STORAGE_KEYS.orcleTab]: 'reports' })
    expect(readLastOrcleTab(storage)).toBe('reports')
  })

  it('falls back to Live when nothing or an unknown id is stored', () => {
    expect(readLastOrcleTab(memoryStorage())).toBe('live')
    expect(readLastOrcleTab(memoryStorage({ [STORAGE_KEYS.orcleTab]: 'customize' }))).toBe('live')
  })

  it('falls back to Live when storage throws or is missing', () => {
    expect(readLastOrcleTab(throwingStorage)).toBe('live')
    expect(readLastOrcleTab(null)).toBe('live')
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
      expect(readLastOrcleTab()).toBe('live')
      expect(() => writeLastOrcleTab('voice')).not.toThrow()
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'localStorage', descriptor)
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage
      }
    }
  })
})

describe('writeLastOrcleTab', () => {
  it('stores the tab so the next read reopens it', () => {
    const storage = memoryStorage()
    writeLastOrcleTab('clean-cut', storage)
    expect(storage.getItem(STORAGE_KEYS.orcleTab)).toBe('clean-cut')
    expect(readLastOrcleTab(storage)).toBe('clean-cut')
  })

  it('never throws when storage refuses the write', () => {
    expect(() => writeLastOrcleTab('chat', throwingStorage)).not.toThrow()
  })
})

describe('openOrcleTab', () => {
  it('asks the shell to open Golem on the tab, on the workspace navigation event', () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('videorc:navigate-workspace', (event) =>
      opened.push((event as CustomEvent).detail)
    )
    vi.stubGlobal('window', target)
    try {
      openOrcleTab('voice')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(opened).toEqual([{ tab: 'ai', orcleTab: 'voice' }])
  })
})
