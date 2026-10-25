import { describe, expect, it } from 'vitest'

import { globalShortcutRows } from './shortcuts-settings'

describe('globalShortcutRows (Linux plan 0019)', () => {
  it('offers the system audio shortcut only where system audio can run', () => {
    expect(globalShortcutRows({ systemAudioAvailable: true, systemAudioBound: false })).toContain(
      'system-audio-toggle'
    )
    const linux = globalShortcutRows({ systemAudioAvailable: false, systemAudioBound: false })
    expect(linux).not.toContain('system-audio-toggle')
    expect(linux).toContain('record-toggle')
    expect(linux).toContain('mic-toggle')
  })

  it('offers both clip lengths, the minute right after the 30 seconds (plan 199)', () => {
    const rows = globalShortcutRows({ systemAudioAvailable: true, systemAudioBound: false })
    expect(rows.indexOf('clip-mark-long')).toBe(rows.indexOf('clip-mark') + 1)
  })

  it('keeps a binding saved elsewhere visible so it can be cleared', () => {
    expect(globalShortcutRows({ systemAudioAvailable: false, systemAudioBound: true })).toContain(
      'system-audio-toggle'
    )
  })
})
