import { describe, expect, it } from 'vitest'

import type { Device } from '@/lib/backend'
import {
  DEVICE_PICKER_NONE_VALUE,
  devicePickerGroups,
  devicePickerListStatus,
  devicePickerTriggerView,
  deviceStatusLabel,
  sourceMatchesQuery,
  unlistedSelection
} from './source-select-state'

const cameras: Device[] = [
  { id: 'cam-1', name: 'FaceTime HD Camera', kind: 'camera', status: 'available' },
  { id: 'cam-2', name: 'Cam Link 4K', kind: 'camera', status: 'permission-required' }
]
const camera = { kind: 'camera' as const, devices: cameras, discoveryPending: false }

// Q6 (plan 022), plan 174 S1.9: a picker always has words, and every picker
// says them the same way: loading, none found, a saved id no device matches,
// and a device that cannot run, never the raw backend status.
describe('device picker words', () => {
  it('turns device statuses into words and says nothing for a working device', () => {
    expect(deviceStatusLabel('available')).toBeNull()
    expect(deviceStatusLabel('permission-required')).toBe('Needs permission')
    expect(deviceStatusLabel('unavailable')).toBe('Unavailable')
    expect(deviceStatusLabel('missing')).toBe('Not found')
  })

  it('shows at most one list status line: discovery, then empty, then no match', () => {
    const status = (deviceCount: number, matchCount: number, discoveryPending: boolean) =>
      devicePickerListStatus({ kind: 'microphone', deviceCount, matchCount, discoveryPending })
    expect(status(0, 0, true)).toBe('Finding microphones…')
    expect(status(3, 0, true)).toBe('Finding microphones…')
    expect(status(0, 0, false)).toBe('No microphones found')
    expect(status(3, 0, false)).toBe('No matching microphones')
    expect(status(3, 2, false)).toBeNull()
    expect(
      devicePickerListStatus({
        kind: 'capture',
        deviceCount: 0,
        matchCount: 0,
        discoveryPending: false
      })
    ).toBe('No screens or windows found')
  })
})

describe('device picker trigger', () => {
  it('names the selected device, with its status when it cannot run', () => {
    expect(devicePickerTriggerView({ ...camera, value: 'cam-1', noneLabel: 'Off' })).toEqual({
      label: 'FaceTime HD Camera',
      status: null,
      placeholder: false
    })
    expect(devicePickerTriggerView({ ...camera, value: 'cam-2' })).toEqual({
      label: 'Cam Link 4K',
      status: 'Needs permission',
      placeholder: false
    })
  })

  it('lets discovery and an empty list win over the no-device words', () => {
    const off = { ...camera, value: undefined, noneLabel: 'Off' }
    expect(devicePickerTriggerView({ ...off, discoveryPending: true })).toEqual({
      label: 'Finding cameras…',
      status: null,
      placeholder: true
    })
    expect(devicePickerTriggerView({ ...off, devices: [] }).label).toBe('No cameras found')
    expect(devicePickerTriggerView(off)).toEqual({ label: 'Off', status: null, placeholder: false })
    expect(devicePickerTriggerView({ ...off, noneLabel: undefined })).toEqual({
      label: 'Choose a camera',
      status: null,
      placeholder: true
    })
  })

  it('keeps a saved device by name and calls it Not found only after discovery', () => {
    const saved = { ...camera, value: 'gone', selectedName: 'Old Webcam' }
    expect(devicePickerTriggerView(saved)).toEqual({
      label: 'Old Webcam',
      status: 'Not found',
      placeholder: false
    })
    expect(devicePickerTriggerView({ ...saved, discoveryPending: true }).status).toBeNull()
    expect(devicePickerTriggerView({ ...saved, selectedName: undefined }).label).toBe(
      'Saved camera'
    )
    expect(
      devicePickerTriggerView({ ...saved, kind: 'capture', selectedName: undefined }).label
    ).toBe('Saved screen or window')
  })

  it('does not call a connected source the list hides Not found', () => {
    const hidden = { id: 'screen:legacy', name: 'Built-in Display', status: 'available' as const }
    const input = { ...camera, kind: 'capture' as const, value: 'screen:legacy' }
    expect(devicePickerTriggerView({ ...input, selectedDevice: hidden })).toEqual({
      label: 'Built-in Display',
      status: null,
      placeholder: false
    })
    // A stale selectedDevice for another id is ignored.
    expect(
      unlistedSelection({ ...input, selectedDevice: { ...hidden, id: 'other' } })?.status
    ).toBe('Not found')
  })

  it('names a selection that is not a device (the test pattern) over everything', () => {
    expect(
      devicePickerTriggerView({
        ...camera,
        kind: 'capture',
        value: undefined,
        noneLabel: 'None',
        selectionLabel: 'Test pattern',
        discoveryPending: true
      })
    ).toEqual({ label: 'Test pattern', status: null, placeholder: false })
  })
})

describe('device picker list', () => {
  it('leads with the no-device item, then a missing selection, then devices', () => {
    const groups = devicePickerGroups({
      ...camera,
      value: 'gone',
      selectedName: 'Old Webcam',
      noneLabel: 'Off'
    })
    expect(groups.map((group) => group.items.map((item) => item.label))).toEqual([
      ['Off'],
      ['Old Webcam'],
      ['FaceTime HD Camera', 'Cam Link 4K']
    ])
    expect(groups[0].items[0]).toMatchObject({
      value: DEVICE_PICKER_NONE_VALUE,
      selected: false,
      disabled: false
    })
    expect(groups[1].items[0]).toMatchObject({
      value: 'gone',
      status: 'Not found',
      disabled: true,
      selected: true
    })
    expect(groups[2].items[1]).toMatchObject({ status: 'Needs permission', disabled: true })
  })

  it('marks the no-device item selected when nothing is, and keeps it through a search', () => {
    const groups = devicePickerGroups({
      ...camera,
      value: undefined,
      noneLabel: 'Off',
      query: 'nothing'
    })
    expect(groups).toEqual([
      {
        items: [
          {
            value: DEVICE_PICKER_NONE_VALUE,
            label: 'Off',
            status: null,
            disabled: false,
            selected: true
          }
        ]
      }
    ])
  })

  it('groups screens and windows only when both are present', () => {
    const capture: Device[] = [
      { id: 'w', name: 'Editor', kind: 'window', status: 'available' },
      { id: 's', name: 'Display 1', kind: 'screen', status: 'available' }
    ]
    const input = {
      kind: 'capture' as const,
      devices: capture,
      value: 's',
      discoveryPending: false,
      groupByKind: true
    }
    const grouped = devicePickerGroups(input)
    expect(grouped.map((group) => group.heading)).toEqual(['Screens', 'Windows'])
    expect(grouped[0].items[0]).toMatchObject({ value: 's', selected: true })
    expect(devicePickerGroups({ ...input, query: 'editor' })).toEqual([
      {
        items: [{ value: 'w', label: 'Editor', status: null, disabled: false, selected: false }]
      }
    ])
    expect(devicePickerGroups({ ...input, groupByKind: false })[0].heading).toBeUndefined()
  })
})

describe('source search', () => {
  it('matches all trimmed words across visible fields, preserving accents and non-Latin text', () => {
    const source = { name: 'Café 東京', kind: 'window' as const, detail: 'Safari presentation' }
    expect(sourceMatchesQuery(source, '  SAFARI   café ')).toBe(true)
    expect(sourceMatchesQuery(source, '東京 window')).toBe(true)
    expect(sourceMatchesQuery(source, 'camera')).toBe(false)
  })
  it('filters a large list without collapsing duplicate labels or searching opaque IDs', () => {
    const sources = Array.from({ length: 500 }, (_, index) => ({
      id: `opaque-${index}`,
      name: 'Window',
      kind: 'window' as const,
      detail: `App ${index}`
    }))
    expect(sources.filter((source) => sourceMatchesQuery(source, 'window'))).toHaveLength(500)
    expect(sources.filter((source) => sourceMatchesQuery(source, 'opaque'))).toHaveLength(0)
    expect(
      sources.filter((source) => sourceMatchesQuery(source, 'app 499')).map((source) => source.id)
    ).toEqual(['opaque-499'])
  })
})
