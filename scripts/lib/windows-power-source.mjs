// Whether a Windows gate host runs on AC or on battery (issue #1042). On the
// Intel UHD 620 laptop the power plan throttles the Quick Sync encoder on
// battery: #1262 measured 1080p60 at about 43 fps there (348 of 485 frames),
// while on AC the same laptop misses the 2% frame-count gate only in some
// takes (docs/acceptance/2026-11-14-windows-uhd620-d3d11-gates-recheck.md).
// A D3D11 performance gate that fails on battery is
// not comparable to one on AC, so the gates record the power source and name
// it, instead of leaving a later reader to guess (#1042's first report could
// not tell). This is evidence only: no gate is loosened or skipped on
// battery.

import { spawnSync } from 'node:child_process'

export const WINDOWS_POWER_SOURCE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::Out.WriteLine([System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus)'
].join('; ')

/**
 * Maps `SystemInformation.PowerStatus.PowerLineStatus` (GetSystemPowerStatus's
 * ACLineStatus) to a power source.
 * @param {string | null | undefined} text
 * @returns {'ac' | 'battery' | 'unknown'}
 */
export function parseWindowsPowerLineStatus(text) {
  const value = String(text ?? '')
    .trim()
    .toLowerCase()
  if (value === 'online') return 'ac'
  if (value === 'offline') return 'battery'
  return 'unknown'
}

/**
 * Reads the host's power source. Never throws: anything it cannot read is
 * `unknown`, which the gates report as such.
 * @returns {'ac' | 'battery' | 'unknown'}
 */
export function readWindowsPowerSource({
  platform = process.platform,
  spawn = spawnSync,
  timeoutMs = 10_000
} = {}) {
  if (platform !== 'win32') return 'unknown'
  try {
    const result = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWER_SOURCE_SCRIPT],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }
    )
    if (result.error || result.status !== 0) return 'unknown'
    return parseWindowsPowerLineStatus(result.stdout)
  } catch {
    return 'unknown'
  }
}

/**
 * The one warning line a gate prints for a host on battery, or null.
 * @param {'ac' | 'battery' | 'unknown'} powerSource
 */
export function windowsBatteryPowerWarning(powerSource) {
  if (powerSource !== 'battery') return null
  return (
    'on battery power: D3D11 recording and encoder performance results are not comparable ' +
    'to AC (#1042: Quick Sync on Intel UHD 620 recorded 1080p60 at about 43 fps on battery); ' +
    'plug in before judging a performance failure'
  )
}
