import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalStoragePersister } from './local-storage-persister'

function stubStorage(): {
  writes: Array<[string, string]>
  setItem: (k: string, v: string) => void
} {
  const writes: Array<[string, string]> = []
  return {
    writes,
    setItem(key: string, value: string) {
      writes.push([key, value])
    }
  }
}

describe('LocalStoragePersister', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once per changed value, debounced', () => {
    const storage = stubStorage()
    const persister = new LocalStoragePersister(storage, 150)
    const value = { theme: 'dark' }

    persister.sync('settings', value)
    persister.sync('settings', value) // identity fast path: render re-runs are free
    expect(storage.writes).toEqual([])

    vi.advanceTimersByTime(150)
    expect(storage.writes).toEqual([['settings', JSON.stringify(value)]])
  })

  it('skips writes when a NEW object serializes to identical content', () => {
    const storage = stubStorage()
    const persister = new LocalStoragePersister(storage, 150)
    persister.sync('settings', { a: 1 })
    vi.advanceTimersByTime(150)
    persister.sync('settings', { a: 1 })
    vi.advanceTimersByTime(150)

    expect(storage.writes).toHaveLength(1)
  })

  it('coalesces a burst into the final value', () => {
    const storage = stubStorage()
    const persister = new LocalStoragePersister(storage, 150)
    persister.sync('config', { step: 1 })
    persister.sync('config', { step: 2 })
    persister.sync('config', { step: 3 })
    vi.advanceTimersByTime(150)

    expect(storage.writes).toEqual([['config', JSON.stringify({ step: 3 })]])
  })

  it('flush() writes pending values immediately (pagehide safety)', () => {
    const storage = stubStorage()
    const persister = new LocalStoragePersister(storage, 150)
    persister.sync('settings', { saved: true })
    persister.flush()

    expect(storage.writes).toEqual([['settings', JSON.stringify({ saved: true })]])
    vi.advanceTimersByTime(1000)
    expect(storage.writes).toHaveLength(1)
  })

  it('keeps a failed write pending and reports it', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let failures = 1
    const writes: Array<[string, string]> = []
    const persister = new LocalStoragePersister(
      {
        setItem(key: string, value: string) {
          if (failures > 0) {
            failures -= 1
            throw new Error('quota exceeded')
          }
          writes.push([key, value])
        }
      },
      150
    )
    persister.sync('settings', { big: true })
    vi.advanceTimersByTime(150)
    expect(consoleError).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(0)

    // The next change retries the key.
    persister.sync('settings', { big: true, more: 1 })
    vi.advanceTimersByTime(150)
    expect(writes).toHaveLength(1)
    consoleError.mockRestore()
  })
})
