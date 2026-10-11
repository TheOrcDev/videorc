import { describe, expect, it, vi } from 'vitest'

import { STORAGE_KEYS } from './capture'
import {
  DEFAULT_LIVESTREAM_VIEW,
  LIVESTREAM_VIEWS,
  isLivestreamViewId,
  readLastLivestreamView,
  writeLastLivestreamView
} from './livestream-tabs'

// Plan 174 S1.6b (A-14): Livestream reopens on the view used last.

describe('livestream views', () => {
  it('lists Setup then Upcoming, and opens on Setup by default', () => {
    expect(LIVESTREAM_VIEWS.map(({ id }) => id)).toEqual(['setup', 'upcoming'])
    expect(DEFAULT_LIVESTREAM_VIEW).toBe('setup')
    expect(isLivestreamViewId('upcoming')).toBe(true)
    expect(isLivestreamViewId('streaming')).toBe(false)
  })

  it('remembers the view on this device and falls back on anything unknown', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
    expect(readLastLivestreamView(storage)).toBe('setup')
    writeLastLivestreamView('upcoming', storage)
    expect(store.get(STORAGE_KEYS.livestreamView)).toBe('upcoming')
    expect(readLastLivestreamView(storage)).toBe('upcoming')
    store.set(STORAGE_KEYS.livestreamView, 'drafts')
    expect(readLastLivestreamView(storage)).toBe('setup')
  })

  it('never breaks the page when storage throws or is missing', () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('denied')
      })
    }
    expect(readLastLivestreamView(throwing)).toBe('setup')
    expect(() => writeLastLivestreamView('upcoming', throwing)).not.toThrow()
    expect(readLastLivestreamView(null)).toBe('setup')
  })
})
