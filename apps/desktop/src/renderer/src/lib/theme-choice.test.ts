import { describe, expect, it } from 'vitest'

import { nextToggledTheme } from './theme-choice'

describe('nextToggledTheme (plan 174 I-30)', () => {
  it('flips the look away from the computer as an explicit choice', () => {
    expect(nextToggledTheme({ resolvedTheme: 'dark', systemTheme: 'dark' })).toBe('light')
    expect(nextToggledTheme({ resolvedTheme: 'light', systemTheme: 'light' })).toBe('dark')
  })

  it('hands back to System when the flip lands on what the computer asks for', () => {
    expect(nextToggledTheme({ resolvedTheme: 'light', systemTheme: 'dark' })).toBe('system')
    expect(nextToggledTheme({ resolvedTheme: 'dark', systemTheme: 'light' })).toBe('system')
  })

  it('keeps the old flip when the computer has not said', () => {
    expect(nextToggledTheme({ resolvedTheme: 'dark', systemTheme: undefined })).toBe('light')
    expect(nextToggledTheme({ resolvedTheme: undefined, systemTheme: undefined })).toBe('dark')
  })
})
