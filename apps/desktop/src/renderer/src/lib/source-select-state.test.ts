import { describe, expect, it } from 'vitest'

import { missingSelection, sourceSelectPlaceholder } from './source-select-state'

// Q6 (plan 022): fresh-profile QA showed source selects rendering as bare
// chevrons. Every state must have words: loading, none found, and a saved id
// that no longer matches any device.
describe('source select state', () => {
  it('names the discovery-pending and empty states', () => {
    expect(sourceSelectPlaceholder(0, true)).toBe('Finding devices…')
    // Pending wins even if a stale count lingers.
    expect(sourceSelectPlaceholder(3, true)).toBe('Finding devices…')
    expect(sourceSelectPlaceholder(0, false)).toBe(
      'No devices found. Check System Access in Settings'
    )
    expect(sourceSelectPlaceholder(2, false)).toBe('Select a device')
  })

  it('surfaces a saved id with no matching device instead of a blank trigger', () => {
    const devices = [{ id: 'cam-1' }, { id: 'cam-2' }]
    expect(missingSelection(devices, 'cam-1')).toBeNull()
    expect(missingSelection(devices, undefined)).toBeNull()
    expect(missingSelection(devices, 'gone-id')).toEqual({
      value: 'gone-id',
      label: 'Saved device unavailable. Pick another'
    })
    expect(missingSelection([], 'gone-id')).toEqual({
      value: 'gone-id',
      label: 'Saved device unavailable. Pick another'
    })
  })
})
