import type { Device } from '@/lib/backend'

// Q6 (plan 022): a select surface must never be blank. Fresh profiles showed
// bare chevrons because (a) device discovery hadn't landed yet and (b) a SAVED
// id with no matching device renders nothing in a Radix Select. These pure
// helpers name every state so the component always has words to show.

export function sourceSelectPlaceholder(deviceCount: number, discoveryPending: boolean): string {
  if (discoveryPending) {
    return 'Finding devices…'
  }
  if (deviceCount === 0) {
    return 'No devices found. Check System Access in Settings'
  }
  return 'Select a device'
}

export interface MissingSelection {
  value: string
  label: string
}

/**
 * A selected id that matches no discovered device (device unplugged, id
 * rotated, or discovery still pending). Rendered as a disabled synthetic item
 * so the trigger shows this label instead of an empty surface.
 */
export function missingSelection(
  devices: Pick<Device, 'id'>[],
  value: string | undefined
): MissingSelection | null {
  if (!value || devices.some((device) => device.id === value)) {
    return null
  }
  return { value, label: 'Saved device unavailable. Pick another' }
}
