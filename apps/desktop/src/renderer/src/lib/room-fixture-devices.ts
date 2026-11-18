import type { Device, DeviceList } from '@/lib/backend'

/**
 * DEV smoke fixture devices for the Plan 249 room cases. They are not native
 * capture devices, so every backend device list (`devices.list`,
 * `devices.changed` after a camera lend or a display change) would drop them
 * mid-case. Once seeded they ride along on every later list. DEV only: the
 * production build never calls in here.
 */
let fixtures: readonly Device[] = []

export function seedRoomFixtureDevices(next: readonly Device[]): void {
  fixtures = next
}

export function withRoomFixtureDevices(list: DeviceList): DeviceList {
  if (fixtures.length === 0) return list
  const ids = new Set(fixtures.map((device) => device.id))
  return {
    ...list,
    devices: [...list.devices.filter((device) => !ids.has(device.id)), ...fixtures]
  }
}
