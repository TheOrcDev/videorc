import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseWindowsPowerLineStatus,
  readWindowsPowerSource,
  WINDOWS_POWER_SOURCE_SCRIPT,
  windowsBatteryPowerWarning
} from './windows-power-source.mjs'

describe('parseWindowsPowerLineStatus', () => {
  it('maps PowerLineStatus to a power source', () => {
    assert.equal(parseWindowsPowerLineStatus('Online\r\n'), 'ac')
    assert.equal(parseWindowsPowerLineStatus('Offline'), 'battery')
    assert.equal(parseWindowsPowerLineStatus('Unknown'), 'unknown')
    assert.equal(parseWindowsPowerLineStatus(''), 'unknown')
    assert.equal(parseWindowsPowerLineStatus(undefined), 'unknown')
  })
})

describe('readWindowsPowerSource', () => {
  it('asks PowerShell once and parses its answer', () => {
    const calls = []
    const source = readWindowsPowerSource({
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: 'Offline\r\n' }
      }
    })
    assert.equal(source, 'battery')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'powershell.exe')
    assert.deepEqual(calls[0].args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_POWER_SOURCE_SCRIPT
    ])
    assert.equal(calls[0].options.windowsHide, true)
    assert.ok(calls[0].options.timeout > 0)
  })

  it('is unknown off Windows, on a failed or timed-out read, and on a throw', () => {
    const never = () => assert.fail('must not spawn off Windows')
    assert.equal(readWindowsPowerSource({ platform: 'darwin', spawn: never }), 'unknown')
    assert.equal(
      readWindowsPowerSource({ platform: 'win32', spawn: () => ({ status: 1, stdout: 'Online' }) }),
      'unknown'
    )
    assert.equal(
      readWindowsPowerSource({
        platform: 'win32',
        spawn: () => ({ status: null, error: new Error('ETIMEDOUT'), stdout: '' })
      }),
      'unknown'
    )
    assert.equal(
      readWindowsPowerSource({
        platform: 'win32',
        spawn: () => {
          throw new Error('ENOENT')
        }
      }),
      'unknown'
    )
  })
})

describe('windowsBatteryPowerWarning', () => {
  it('names battery power and #1042, and says nothing for AC or unknown', () => {
    assert.match(windowsBatteryPowerWarning('battery'), /^on battery power: .*#1042/)
    assert.equal(windowsBatteryPowerWarning('ac'), null)
    assert.equal(windowsBatteryPowerWarning('unknown'), null)
  })
})
