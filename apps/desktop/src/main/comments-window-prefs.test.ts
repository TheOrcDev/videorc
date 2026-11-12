import { describe, expect, it, vi } from 'vitest'

import { readPrefsForMerge, writePrefsWhole, type PrefsFs } from './comments-window-prefs'

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function fakeFs(overrides: Partial<PrefsFs> = {}): PrefsFs {
  return {
    readFileSync: vi.fn(() => '{"hiddenFromStream":true}'),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    ...overrides
  }
}

describe('readPrefsForMerge (plan 230)', () => {
  it('reads the saved prefs', () => {
    expect(readPrefsForMerge(fakeFs(), 'p.json')).toEqual({ hiddenFromStream: true })
  })

  it('starts empty when there is no file yet, or when the file is already broken', () => {
    const missing = fakeFs({
      readFileSync: vi.fn(() => {
        throw errno('ENOENT')
      })
    })
    expect(readPrefsForMerge(missing, 'p.json')).toEqual({})
    for (const text of ['{"hidden', '[1]', 'null']) {
      expect(readPrefsForMerge(fakeFs({ readFileSync: vi.fn(() => text) }), 'p.json')).toEqual({})
    }
  })

  it('says it cannot read a file that exists but is locked, so nothing overwrites it', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EIO']) {
      const locked = fakeFs({
        readFileSync: vi.fn(() => {
          throw errno(code)
        })
      })
      expect(readPrefsForMerge(locked, 'p.json')).toBeNull()
    }
  })
})

describe('writePrefsWhole (plan 230)', () => {
  it('writes the next file, then renames it into place', () => {
    const fs = fakeFs()
    writePrefsWhole(fs, 'p.json', '{}')
    expect(fs.writeFileSync).toHaveBeenCalledWith('p.json.next', '{}')
    expect(fs.renameSync).toHaveBeenCalledWith('p.json.next', 'p.json')
  })

  it('writes in place when a scanner blocks the rename', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const blocked = fakeFs({
        renameSync: vi.fn(() => {
          throw errno(code)
        })
      })
      writePrefsWhole(blocked, 'p.json', '{"a":1}')
      expect(blocked.writeFileSync).toHaveBeenLastCalledWith('p.json', '{"a":1}')
    }
  })

  it('throws any other failure, for the caller to log', () => {
    const full = fakeFs({
      renameSync: vi.fn(() => {
        throw errno('ENOSPC')
      })
    })
    expect(() => writePrefsWhole(full, 'p.json', '{}')).toThrow('ENOSPC')
  })
})
