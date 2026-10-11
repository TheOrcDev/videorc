import type { Device, DeviceStatus, SessionSourceKind } from '@/lib/backend'

// The one device picker's words (plan 174 S1.9, after Q6 in plan 022). A
// picker never renders a blank surface: discovery still running, nothing
// found, and a saved id that no device matches all have words. These pure
// helpers decide what the trigger and the list say, so every picker (Studio
// Inputs, the Studio Microphone section, Sources, scene repair) says it the
// same way.

/** The "no device" item's value. Never a device id. */
export const DEVICE_PICKER_NONE_VALUE = '__none__'

/** Every sentence a picker says about its kind of device. */
export interface DevicePickerCopy {
  finding: string
  empty: string
  noMatch: string
  search: string
  select: string
  /** A saved device with no saved name. */
  saved: string
}

const COPY: Record<SessionSourceKind, DevicePickerCopy> = {
  capture: {
    finding: 'Finding screens and windows…',
    empty: 'No screens or windows found',
    noMatch: 'No matching screens or windows',
    search: 'Search screens and windows…',
    select: 'Choose a screen or window',
    saved: 'Saved screen or window'
  },
  camera: {
    finding: 'Finding cameras…',
    empty: 'No cameras found',
    noMatch: 'No matching cameras',
    search: 'Search cameras…',
    select: 'Choose a camera',
    saved: 'Saved camera'
  },
  microphone: {
    finding: 'Finding microphones…',
    empty: 'No microphones found',
    noMatch: 'No matching microphones',
    search: 'Search microphones…',
    select: 'Choose a microphone',
    saved: 'Saved microphone'
  }
}

export function devicePickerCopy(kind: SessionSourceKind): DevicePickerCopy {
  return COPY[kind]
}

/**
 * The muted word after a device that cannot be picked right now. A device
 * that works says nothing; the raw backend status never reaches the screen.
 */
export function deviceStatusLabel(status: DeviceStatus | 'missing'): string | null {
  switch (status) {
    case 'permission-required':
      return 'Needs permission'
    case 'unavailable':
      return 'Unavailable'
    case 'missing':
      return 'Not found'
    default:
      return null
  }
}

export interface DevicePickerSelectionInput {
  kind: SessionSourceKind
  /** The devices the picker lists. */
  devices: readonly Pick<Device, 'id' | 'name' | 'status'>[]
  value: string | undefined
  /** The saved name, for a selected device the list does not hold. */
  selectedName?: string
  /**
   * The selected device when the caller found it in the whole device list:
   * a connected source the picker hides is not "Not found".
   */
  selectedDevice?: Pick<Device, 'id' | 'name' | 'status'>
  discoveryPending: boolean
}

/**
 * A selected id the listed devices do not hold, with the words to show for
 * it, or null. Discovery may not have listed it yet: it is named, and only
 * called "Not found" once discovery has reported.
 */
export function unlistedSelection(
  input: DevicePickerSelectionInput
): { value: string; label: string; status: string | null } | null {
  const { value } = input
  if (!value || input.devices.some((device) => device.id === value)) return null
  const known = input.selectedDevice?.id === value ? input.selectedDevice : undefined
  if (known) return { value, label: known.name, status: deviceStatusLabel(known.status) }
  return {
    value,
    label: input.selectedName || COPY[input.kind].saved,
    status: input.discoveryPending ? null : deviceStatusLabel('missing')
  }
}

/**
 * The one status line a picker's list shows, or null. One line at most:
 * discovery first, then an empty list, then a search that matched nothing.
 */
export function devicePickerListStatus(input: {
  kind: SessionSourceKind
  deviceCount: number
  matchCount: number
  discoveryPending: boolean
}): string | null {
  const copy = COPY[input.kind]
  if (input.discoveryPending) return copy.finding
  if (input.deviceCount === 0) return copy.empty
  if (input.matchCount === 0) return copy.noMatch
  return null
}

export interface DevicePickerTriggerView {
  label: string
  /** The muted status after the name ("Needs permission", "Not found"). */
  status: string | null
  /** A prompt or a state, not a choice: drawn in the secondary tone. */
  placeholder: boolean
}

/**
 * What the closed picker says. A selection that is not a device (the test
 * pattern) by its own name; a selected device by name, with its status when
 * it cannot run; with nothing selected, discovery and an empty list win over
 * the "no device" words, so a missing camera never hides behind "Off".
 */
export function devicePickerTriggerView(
  input: DevicePickerSelectionInput & {
    noneLabel?: string
    selectionLabel?: string
  }
): DevicePickerTriggerView {
  const copy = COPY[input.kind]
  if (input.selectionLabel) {
    return { label: input.selectionLabel, status: null, placeholder: false }
  }
  if (input.value) {
    const device = input.devices.find((candidate) => candidate.id === input.value)
    if (device) {
      return { label: device.name, status: deviceStatusLabel(device.status), placeholder: false }
    }
    const unlisted = unlistedSelection(input)
    if (unlisted) return { label: unlisted.label, status: unlisted.status, placeholder: false }
  }
  if (input.discoveryPending) return { label: copy.finding, status: null, placeholder: true }
  if (input.devices.length === 0) return { label: copy.empty, status: null, placeholder: true }
  if (input.noneLabel) return { label: input.noneLabel, status: null, placeholder: false }
  return { label: copy.select, status: null, placeholder: true }
}

export interface DevicePickerItem {
  /** The device id, the selected id, or `DEVICE_PICKER_NONE_VALUE`. */
  value: string
  label: string
  status: string | null
  disabled: boolean
  selected: boolean
}

export interface DevicePickerGroup {
  heading?: string
  items: DevicePickerItem[]
}

/**
 * The list, in groups: the "no device" item first (kept through any search),
 * then a selected device the list does not hold (disabled, so the list still
 * shows what is selected), then the devices that match the search, under
 * Screens and Windows when both kinds are present.
 */
export function devicePickerGroups(
  input: Omit<DevicePickerSelectionInput, 'devices'> & {
    devices: readonly Device[]
    noneLabel?: string
    groupByKind?: boolean
    query?: string
  }
): DevicePickerGroup[] {
  const groups: DevicePickerGroup[] = []
  if (input.noneLabel) {
    groups.push({
      items: [
        {
          value: DEVICE_PICKER_NONE_VALUE,
          label: input.noneLabel,
          status: null,
          disabled: false,
          selected: !input.value
        }
      ]
    })
  }
  const unlisted = unlistedSelection(input)
  if (unlisted) groups.push({ items: [{ ...unlisted, disabled: true, selected: true }] })
  const matches = input.devices.filter((device) => sourceMatchesQuery(device, input.query ?? ''))
  const item = (device: Device): DevicePickerItem => ({
    value: device.id,
    label: device.name,
    status: deviceStatusLabel(device.status),
    disabled: device.status !== 'available',
    selected: device.id === input.value
  })
  const screens = matches.filter((device) => device.kind === 'screen')
  const windows = matches.filter((device) => device.kind === 'window')
  if (input.groupByKind && screens.length && windows.length) {
    groups.push({ heading: 'Screens', items: screens.map(item) })
    groups.push({ heading: 'Windows', items: windows.map(item) })
  } else if (matches.length) {
    groups.push({ items: matches.map(item) })
  }
  return groups
}

/** Match visible source metadata, never opaque capture IDs. */
export function sourceMatchesQuery(
  device: Pick<Device, 'name' | 'kind' | 'detail'>,
  query: string
): boolean {
  const text = [device.name, device.kind, device.detail ?? ''].join(' ').toLocaleLowerCase()
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}
