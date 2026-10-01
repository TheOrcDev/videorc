import { describe, expect, it } from 'vitest'

import {
  loadFailureNeedsRecovery,
  MAX_AUTOMATIC_RELOADS,
  micaFallbackApplies,
  micaFallbackStatePath,
  paintVerdictFromBitmap,
  readMicaFallbackState,
  ReloadBudget,
  RELOAD_WINDOW_MS,
  rendererExitNeedsRecovery,
  writeMicaFallbackState,
  type MicaFallbackState
} from './main-window-recovery'

describe('rendererExitNeedsRecovery', () => {
  it('recovers from every exit except a clean one', () => {
    for (const reason of [
      'crashed',
      'oom',
      'killed',
      'abnormal-exit',
      'launch-failed',
      'integrity-failure',
      'memory-eviction'
    ]) {
      expect(rendererExitNeedsRecovery(reason)).toBe(true)
    }
    expect(rendererExitNeedsRecovery('clean-exit')).toBe(false)
  })
})

describe('loadFailureNeedsRecovery', () => {
  it('recovers main-frame failures only, and never a cancelled navigation', () => {
    expect(loadFailureNeedsRecovery({ errorCode: -6, isMainFrame: true })).toBe(true)
    expect(loadFailureNeedsRecovery({ errorCode: -6, isMainFrame: false })).toBe(false)
    expect(loadFailureNeedsRecovery({ errorCode: -3, isMainFrame: true })).toBe(false)
  })
})

describe('ReloadBudget', () => {
  it('reloads up to the bound, then asks', () => {
    const budget = new ReloadBudget()
    for (let attempt = 0; attempt < MAX_AUTOMATIC_RELOADS; attempt++) {
      expect(budget.next(1000 + attempt)).toBe('reload')
    }
    expect(budget.next(2000)).toBe('ask')
    expect(budget.next(3000)).toBe('ask')
  })

  it('forgets reloads older than the window', () => {
    const budget = new ReloadBudget()
    expect(budget.next(0)).toBe('reload')
    expect(budget.next(1)).toBe('reload')
    expect(budget.next(RELOAD_WINDOW_MS - 1)).toBe('ask')
    expect(budget.next(RELOAD_WINDOW_MS + 1)).toBe('reload')
  })

  it('starts afresh after the user reloads by hand', () => {
    const budget = new ReloadBudget()
    budget.next(0)
    budget.next(1)
    expect(budget.next(2)).toBe('ask')
    budget.reset()
    expect(budget.next(3)).toBe('reload')
  })
})

describe('paintVerdictFromBitmap', () => {
  it('calls a capture with no alpha anywhere blank', () => {
    expect(paintVerdictFromBitmap(new Uint8Array(4 * 16))).toBe('blank')
  })

  it('calls a capture with any alpha painted, even a translucent coat', () => {
    const bitmap = new Uint8Array(4 * 16)
    bitmap[4 * 9 + 3] = 87
    expect(paintVerdictFromBitmap(bitmap)).toBe('painted')
  })

  it('ignores colour bytes: only alpha proves a paint', () => {
    const bitmap = new Uint8Array(4 * 2)
    bitmap[0] = 255
    bitmap[5] = 255
    expect(paintVerdictFromBitmap(bitmap)).toBe('blank')
  })

  it('treats an empty capture as no evidence', () => {
    expect(paintVerdictFromBitmap(new Uint8Array(0))).toBe('unknown')
  })
})

describe('Mica fallback state', () => {
  const state: MicaFallbackState = {
    disableMica: true,
    reason: 'paint-check-blank',
    appVersion: '0.9.125',
    updatedAt: '2026-10-01T00:00:00.000Z'
  }

  it('round-trips through the store', () => {
    const files = new Map<string, string>()
    const path = micaFallbackStatePath('/data')
    writeMicaFallbackState(path, state, {
      writeFile: (target, contents) => files.set(target, contents),
      makeDir: () => undefined
    })
    expect(readMicaFallbackState(path, { readFile: (target) => files.get(target) ?? '' })).toEqual(
      state
    )
  })

  it('reads missing, corrupt or foreign files as no fallback', () => {
    const read = (contents: string | Error): MicaFallbackState | null =>
      readMicaFallbackState('/x', {
        readFile: () => {
          if (contents instanceof Error) throw contents
          return contents
        }
      })
    expect(read(new Error('ENOENT'))).toBeNull()
    expect(read('not json')).toBeNull()
    expect(read('null')).toBeNull()
    expect(read('{"disableMica":false,"appVersion":"0.9.125"}')).toBeNull()
    expect(read('{"disableMica":true}')).toBeNull()
  })

  it('applies only to the app version that saw the blank window', () => {
    expect(micaFallbackApplies(state, '0.9.125')).toBe(true)
    expect(micaFallbackApplies(state, '0.9.126')).toBe(false)
    expect(micaFallbackApplies(null, '0.9.125')).toBe(false)
  })
})
