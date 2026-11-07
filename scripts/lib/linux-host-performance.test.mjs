import assert from 'node:assert/strict'
import test from 'node:test'
import { linuxHostPerformanceSnapshot } from './linux-host-performance.mjs'

const frequencies = '/sys/devices/system/cpu/cpufreq'
const power = '/sys/class/power_supply'
function fixture(overrides = {}) {
  const files = {
    [`${frequencies}/policy0/scaling_cur_freq`]: '800000\n',
    [`${frequencies}/policy0/scaling_min_freq`]: '800000\n',
    [`${frequencies}/policy0/scaling_max_freq`]: '4100000\n',
    [`${frequencies}/policy0/cpuinfo_max_freq`]: '4100000\n',
    [`${frequencies}/policy0/scaling_governor`]: 'powersave\n',
    [`${frequencies}/policy0/energy_performance_preference`]: 'balance_power\n',
    [`${power}/ADP1/type`]: 'Mains\n',
    [`${power}/ADP1/online`]: '0\n',
    [`${power}/BAT0/type`]: 'Battery\n',
    [`${power}/BAT0/scope`]: 'System\n',
    [`${power}/BAT0/status`]: 'Discharging\n',
    [`${power}/BAT0/capacity`]: '45\n',
    ...overrides
  }
  const reads = []
  return {
    reads,
    platform: 'linux',
    now: () => '2026-10-30T00:00:00.000Z',
    list: async (path) => (path === frequencies ? ['policy0', 'unrelated'] : ['BAT0', 'ADP1']),
    read: async (path) => {
      reads.push(path)
      if (files[path] == null) throw new Error('unavailable')
      return files[path]
    }
  }
}

test('records measured clocks and disconnected mains without inventing a throttle verdict', async () => {
  const io = fixture()
  const result = await linuxHostPerformanceSnapshot(io)
  assert.equal(result.sampledAt, '2026-10-30T00:00:00.000Z')
  assert.equal(result.externalPowerOnline, false)
  assert.deepEqual(result.supplies, [
    { type: 'Mains', online: false },
    { type: 'Battery', status: 'Discharging', capacityPercent: 45 }
  ])
  assert.deepEqual(result.policies, [
    {
      policy: 'policy0',
      currentKHz: 800000,
      minimumKHz: 800000,
      maximumKHz: 4100000,
      hardwareMaximumKHz: 4100000,
      governor: 'powersave',
      energyPreference: 'balance_power'
    }
  ])
  assert.deepEqual(result.unavailable, [])
  assert.equal(result.pass, undefined)
  assert.equal(result.throttled, undefined)
  assert.ok(io.reads.every((path) => path.startsWith('/sys/')))
  assert.ok(io.reads.every((path) => !/serial|uevent|device\//.test(path)))
})

test('a later sample observes power and frequency changes', async () => {
  const before = await linuxHostPerformanceSnapshot(fixture())
  const after = await linuxHostPerformanceSnapshot(
    fixture({
      [`${power}/ADP1/online`]: '1',
      [`${frequencies}/policy0/scaling_cur_freq`]: '3200000'
    })
  )
  assert.equal(before.externalPowerOnline, false)
  assert.equal(after.externalPowerOnline, true)
  assert.equal(after.policies[0].currentKHz, 3200000)
})

test('missing and malformed measurements remain unknown', async () => {
  const result = await linuxHostPerformanceSnapshot(
    fixture({
      [`${power}/ADP1/online`]: null,
      [`${power}/BAT0/capacity`]: '101',
      [`${frequencies}/policy0/scaling_cur_freq`]: 'not available',
      [`${frequencies}/policy0/energy_performance_preference`]: null
    })
  )
  assert.equal(result.externalPowerOnline, null)
  assert.equal(result.supplies[1].capacityPercent, null)
  assert.equal(result.policies[0].currentKHz, null)
  assert.equal(result.policies[0].energyPreference, null)
  assert.ok(result.unavailable.includes(`${power}/<supply>/online`))
  const absent = await linuxHostPerformanceSnapshot({
    platform: 'linux',
    list: async () => {
      throw new Error('unavailable')
    }
  })
  assert.equal(absent.externalPowerOnline, null)
  assert.deepEqual(absent.policies, [])
  assert.deepEqual(absent.unavailable, [power, frequencies])
})

test('peripheral batteries and non-Linux hosts are excluded', async () => {
  const io = fixture({ [`${power}/BAT0/scope`]: 'Device' })
  const result = await linuxHostPerformanceSnapshot(io)
  assert.deepEqual(result.supplies, [{ type: 'Mains', online: false }])
  assert.ok(!io.reads.includes(`${power}/BAT0/capacity`))
  assert.equal(
    await linuxHostPerformanceSnapshot({
      platform: 'win32',
      list: () => {
        throw new Error('must not probe this host')
      }
    }),
    null
  )
})
