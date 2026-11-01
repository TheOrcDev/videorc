export type DevicePickerKind = 'capture' | 'camera' | 'microphone'

// The device picker's words. A picker never renders a blank surface:
// discovery still running, nothing found, and a saved id that no device
// matches all have words. These pure helpers decide what the trigger and the
// list say, so every picker (a scene's camera, a microphone section, a source
// list, a repair step) says it the same way.
//
// DevicePickerKind, above, is which kind of source a picker chooses: it
// decides the words ("Finding cameras…").

/**
 * Whether a device can run. `permission-required` and `unavailable` list the
 * device but keep it from being chosen; `missing` is a saved device that no
 * longer shows up.
 */
export type PickerDeviceStatus = 'available' | 'permission-required' | 'unavailable'

/** The fields a picker reads from a device. */
export interface PickerDevice {
  /** Stable and opaque: what `onChange` reports. Never shown or searched. */
  id: string
  /** What the list and the trigger show: "FaceTime HD Camera". */
  name: string
  /**
   * `screen` and `window` split into their own headings with `groupByKind`;
   * any other kind ("camera", "microphone") lists as is. Searchable.
   */
  kind: string
  status: PickerDeviceStatus
  /** Searchable context the list doesn't show: the app that owns a window. */
  detail?: string
}

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

const COPY: Record<DevicePickerKind, DevicePickerCopy> = {
  camera: {
    empty: 'No cameras found',
    finding: 'Finding cameras…',
    noMatch: 'No matching cameras',
    saved: 'Saved camera',
    search: 'Search cameras…',
    select: 'Choose a camera'
  },
  capture: {
    empty: 'No screens or windows found',
    finding: 'Finding screens and windows…',
    noMatch: 'No matching screens or windows',
    saved: 'Saved screen or window',
    search: 'Search screens and windows…',
    select: 'Choose a screen or window'
  },
  microphone: {
    empty: 'No microphones found',
    finding: 'Finding microphones…',
    noMatch: 'No matching microphones',
    saved: 'Saved microphone',
    search: 'Search microphones…',
    select: 'Choose a microphone'
  }
}

export function devicePickerCopy(kind: DevicePickerKind): DevicePickerCopy {
  return COPY[kind]
}

/**
 * The muted word after a device that can't be chosen right now. A device
 * that works says nothing; a raw status never reaches the screen.
 */
export function deviceStatusLabel(status: PickerDeviceStatus | 'missing'): string | null {
  switch (status) {
    case 'permission-required': {
      return 'Needs permission'
    }
    case 'unavailable': {
      return 'Unavailable'
    }
    case 'missing': {
      return 'Not found'
    }
    default: {
      return null
    }
  }
}

type ListedDevice = Pick<PickerDevice, 'id' | 'name' | 'status'>

export interface DevicePickerSelectionInput {
  kind: DevicePickerKind
  /** The devices the picker lists. */
  devices: readonly ListedDevice[]
  value: string | undefined
  /** The saved name, for a selected device the list doesn't hold. */
  selectedName?: string
  /**
   * The selected device when the caller found it in the whole device list:
   * a connected source the picker hides isn't "Not found".
   */
  selectedDevice?: ListedDevice
  discoveryPending: boolean
}

/**
 * A selected id the listed devices don't hold, with the words to show for
 * it, or null. Discovery may not have listed it yet: it is named, and only
 * called "Not found" once discovery has reported.
 */
export function unlistedSelection(
  input: DevicePickerSelectionInput
): { value: string; label: string; status: string | null } | null {
  const { value } = input
  if (!value || input.devices.some((device) => device.id === value)) {
    return null
  }
  const known = input.selectedDevice?.id === value ? input.selectedDevice : undefined
  if (known) {
    return {
      label: known.name,
      status: deviceStatusLabel(known.status),
      value
    }
  }
  return {
    label: input.selectedName || COPY[input.kind].saved,
    status: input.discoveryPending ? null : deviceStatusLabel('missing'),
    value
  }
}

/**
 * The one status line a picker's list shows, or null. One line at most:
 * discovery first, then an empty list, then a search that matched nothing.
 */
export function devicePickerListStatus(input: {
  kind: DevicePickerKind
  deviceCount: number
  matchCount: number
  discoveryPending: boolean
}): string | null {
  const copy = COPY[input.kind]
  if (input.discoveryPending) {
    return copy.finding
  }
  if (input.deviceCount === 0) {
    return copy.empty
  }
  if (input.matchCount === 0) {
    return copy.noMatch
  }
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
 * What the closed picker says. A selection that isn't a device (the test
 * pattern) by its own name; a selected device by name, with its status when
 * it can't run; with nothing selected, discovery and an empty list win over
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
    return { label: input.selectionLabel, placeholder: false, status: null }
  }
  if (input.value) {
    const device = input.devices.find((candidate) => candidate.id === input.value)
    if (device) {
      return {
        label: device.name,
        placeholder: false,
        status: deviceStatusLabel(device.status)
      }
    }
    const unlisted = unlistedSelection(input)
    if (unlisted) {
      return {
        label: unlisted.label,
        placeholder: false,
        status: unlisted.status
      }
    }
  }
  if (input.discoveryPending) {
    return { label: copy.finding, placeholder: true, status: null }
  }
  if (input.devices.length === 0) {
    return { label: copy.empty, placeholder: true, status: null }
  }
  if (input.noneLabel) {
    return { label: input.noneLabel, placeholder: false, status: null }
  }
  return { label: copy.select, placeholder: true, status: null }
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

/** Matches visible source metadata, never opaque ids. */
export function sourceMatchesQuery(
  device: Pick<PickerDevice, 'name' | 'kind' | 'detail'>,
  query: string
): boolean {
  const text = [device.name, device.kind, device.detail ?? ''].join(' ').toLocaleLowerCase()
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .every((word) => text.includes(word))
}

/**
 * The list, in groups: the "no device" item first (kept through any search),
 * then a selected device the list doesn't hold (disabled, so the list still
 * shows what is selected), then the devices that match the search, under
 * Screens and Windows when both kinds are present.
 */
export function devicePickerGroups(
  input: Omit<DevicePickerSelectionInput, 'devices'> & {
    devices: readonly PickerDevice[]
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
          disabled: false,
          label: input.noneLabel,
          selected: !input.value,
          status: null,
          value: DEVICE_PICKER_NONE_VALUE
        }
      ]
    })
  }
  const unlisted = unlistedSelection(input)
  if (unlisted) {
    groups.push({ items: [{ ...unlisted, disabled: true, selected: true }] })
  }
  const matches = input.devices.filter((device) => sourceMatchesQuery(device, input.query ?? ''))
  const item = (device: PickerDevice): DevicePickerItem => ({
    disabled: device.status !== 'available',
    label: device.name,
    selected: device.id === input.value,
    status: deviceStatusLabel(device.status),
    value: device.id
  })
  const screens = matches.filter((device) => device.kind === 'screen')
  const windows = matches.filter((device) => device.kind === 'window')
  if (input.groupByKind && screens.length > 0 && windows.length > 0) {
    groups.push(
      { heading: 'Screens', items: screens.map(item) },
      { heading: 'Windows', items: windows.map(item) }
    )
  } else if (matches.length > 0) {
    groups.push({ items: matches.map(item) })
  }
  return groups
}
