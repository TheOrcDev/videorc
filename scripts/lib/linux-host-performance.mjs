// Read-only context for Linux performance evidence. Clocks are instantaneous
// kernel samples, not proof of throttling or an adjustment to any quality gate.
import { readFile, readdir } from 'node:fs/promises'
import { posix } from 'node:path'

// These are Linux sysfs paths, including in injected tests on Windows.
const { basename, join } = posix

export async function linuxHostPerformanceSnapshot({
  platform = process.platform,
  read = (path) => readFile(path, 'utf8'),
  list = readdir,
  now = () => new Date().toISOString()
} = {}) {
  if (platform !== 'linux') return null
  const unavailable = []
  async function value(path) {
    try {
      return (await read(path)).trim()
    } catch {
      unavailable.push(path)
      return null
    }
  }
  async function names(path) {
    try {
      return (await list(path)).sort()
    } catch {
      unavailable.push(path)
      return []
    }
  }
  const integer = (text) => {
    if (text == null || !/^\d+$/.test(text)) return null
    const number = Number(text)
    return Number.isSafeInteger(number) ? number : null
  }
  const frequencyRoot = '/sys/devices/system/cpu/cpufreq'
  const powerRoot = '/sys/class/power_supply'
  const [policyNames, supplyNames] = await Promise.all([names(frequencyRoot), names(powerRoot)])
  const policies = await Promise.all(
    policyNames
      .filter((name) => /^policy\d+$/.test(name))
      .map(async (name) => {
        const fields = [
          ['currentKHz', 'scaling_cur_freq', integer],
          ['minimumKHz', 'scaling_min_freq', integer],
          ['maximumKHz', 'scaling_max_freq', integer],
          ['hardwareMaximumKHz', 'cpuinfo_max_freq', integer],
          ['governor', 'scaling_governor', (text) => text],
          ['energyPreference', 'energy_performance_preference', (text) => text]
        ]
        return {
          policy: name,
          ...Object.fromEntries(
            await Promise.all(
              fields.map(async ([field, file, parse]) => [
                field,
                parse(await value(join(frequencyRoot, name, file)))
              ])
            )
          )
        }
      })
  )
  const supplies = (
    await Promise.all(
      supplyNames
        .filter((name) => /^[A-Za-z0-9_.:-]+$/.test(name))
        .map(async (name) => {
          const path = join(powerRoot, name)
          const type = await value(join(path, 'type'))
          // Avoid serial numbers, device identifiers and peripheral batteries.
          if (type === 'Battery') {
            const scope = await value(join(path, 'scope'))
            if (scope === 'Device') return null
            const capacity = integer(await value(join(path, 'capacity')))
            return {
              type,
              status: await value(join(path, 'status')),
              capacityPercent: capacity != null && capacity <= 100 ? capacity : null
            }
          }
          if (!['Mains', 'USB', 'USB_C', 'USB_PD'].includes(type)) return null
          const online = await value(join(path, 'online'))
          return { type, online: online === '1' ? true : online === '0' ? false : null }
        })
    )
  ).filter(Boolean)
  const external = supplies.filter((supply) => supply.type !== 'Battery')
  const externalPowerOnline = external.some((supply) => supply.online === true)
    ? true
    : external.length > 0 && external.every((supply) => supply.online === false)
      ? false
      : null
  return {
    sampledAt: now(),
    externalPowerOnline,
    supplies,
    policies,
    // Missing or unreadable files stay explicit; absence is never "healthy".
    unavailable: [
      ...new Set(
        unavailable.map((path) =>
          path.startsWith(`${powerRoot}/`) ? `${powerRoot}/<supply>/${basename(path)}` : path
        )
      )
    ].sort()
  }
}
