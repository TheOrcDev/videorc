import { describe, expect, it } from 'vitest'

import type { UpdateStatus } from '@/lib/backend'

import { isUpdateInstallable, updateChip } from './update-ui'

describe('isUpdateInstallable', () => {
  it('allows installing a downloaded update when nothing is capturing', () => {
    expect(isUpdateInstallable({ phase: 'downloaded', version: '1.0.0' }, false)).toBe(true)
  })

  it('blocks install while a capture is active (never interrupt a recording)', () => {
    expect(isUpdateInstallable({ phase: 'downloaded', version: '1.0.0' }, true)).toBe(false)
  })

  it('is false in every non-downloaded phase', () => {
    const phases: UpdateStatus[] = [
      { phase: 'idle' },
      { phase: 'checking' },
      { phase: 'available', version: '1.0.0' },
      { phase: 'downloading', percent: 50 },
      { phase: 'not-available', currentVersion: '1.0.0' },
      { phase: 'error', message: 'boom' },
      { phase: 'unsupported' }
    ]
    for (const status of phases) {
      expect(isUpdateInstallable(status, false)).toBe(false)
    }
  })
})

describe('updateChip', () => {
  it('renders only for in-flight or ready updates', () => {
    expect(updateChip({ phase: 'idle' }, false)).toBeNull()
    expect(updateChip({ phase: 'checking' }, false)).toBeNull()
    expect(updateChip({ phase: 'not-available', currentVersion: '1.0.0' }, false)).toBeNull()
    expect(updateChip({ phase: 'error', message: 'boom' }, false)).toBeNull()
    expect(updateChip({ phase: 'unsupported' }, false)).toBeNull()
    expect(updateChip({ phase: 'available', version: '1.1.0' }, false)).toEqual({
      label: 'Update available',
      detail: 'Update 1.1.0 available',
      action: 'settings'
    })
    expect(updateChip({ phase: 'downloading', percent: 41.6 }, false)).toEqual({
      label: 'Downloading… 42%',
      detail: 'Downloading update… 42%',
      action: 'settings'
    })
    expect(updateChip({ phase: 'downloading', percent: 7, version: '1.1.0' }, false)).toEqual({
      label: 'Downloading… 7%',
      detail: 'Downloading update 1.1.0… 7%',
      action: 'settings'
    })
  })

  // Plan 080 S1: the sidebar fits about 20 characters of 14 px text; the
  // version made every label truncate ("Restart to update t…").
  it('keeps every label short enough for the sidebar, version in the detail only', () => {
    const statuses: UpdateStatus[] = [
      { phase: 'available', version: '10.10.100' },
      { phase: 'downloading', percent: 100, version: '10.10.100' },
      { phase: 'downloaded', version: '10.10.100' }
    ]
    for (const status of statuses) {
      const chip = updateChip(status, false)
      expect(chip?.label.length).toBeLessThanOrEqual(18)
      expect(chip?.label).not.toContain('10.10.100')
    }
  })

  it('offers install when downloaded, but never mid-capture', () => {
    expect(updateChip({ phase: 'downloaded', version: '1.1.0' }, false)).toEqual({
      label: 'Restart to update',
      detail: 'Restart to update to 1.1.0',
      action: 'install'
    })
    expect(updateChip({ phase: 'downloaded', version: '1.1.0' }, true)).toEqual({
      label: 'Restart to update',
      detail: 'Restart to update to 1.1.0',
      action: 'settings'
    })
  })
})
