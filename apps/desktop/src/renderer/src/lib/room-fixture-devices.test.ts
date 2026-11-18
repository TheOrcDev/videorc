import { afterEach, describe, expect, it } from 'vitest'
import type { Device } from '@/lib/backend'
import { seedRoomFixtureDevices, withRoomFixtureDevices } from './room-fixture-devices'

const camera: Device = {
  id: 'parity-camera',
  name: 'Parity camera',
  kind: 'camera',
  status: 'available'
}
const screen: Device = { id: 'screen:1', name: 'Display 1', kind: 'screen', status: 'available' }

describe('room fixture devices', () => {
  afterEach(() => seedRoomFixtureDevices([]))

  it('passes a device list through untouched until fixtures are seeded', () => {
    const list = { devices: [screen], warnings: [] }
    expect(withRoomFixtureDevices(list)).toBe(list)
  })

  it('keeps seeded fixtures on every later backend list, once each', () => {
    seedRoomFixtureDevices([camera])
    // A camera lend re-lists devices: the fixture camera must survive it.
    expect(withRoomFixtureDevices({ devices: [screen], warnings: [] }).devices).toEqual([
      screen,
      camera
    ])
    expect(withRoomFixtureDevices({ devices: [camera, screen], warnings: [] }).devices).toEqual([
      screen,
      camera
    ])
  })
})
