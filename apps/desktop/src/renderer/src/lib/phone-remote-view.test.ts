import { describe, expect, it } from 'vitest'

import type { RemoteLanStatus } from '@/lib/backend'

import {
  deviceActivityLabel,
  formatCountdown,
  pairingSecondsLeft,
  phoneRemoteSummary,
  qrCodePath
} from './phone-remote-view'

const NOW = Date.parse('2026-09-18T10:00:00Z')

describe('phone remote view', () => {
  it('encodes the pairing URL as one bounded path', () => {
    const { path, size } = qrCodePath(
      'http://192.168.1.20:7420/#p=0123456789abcdef0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    )
    expect(size).toBeGreaterThan(21)
    expect(path.startsWith('M')).toBe(true)
    // Runs, not modules: far fewer commands than dark cells.
    expect(path.split('M').length).toBeLessThan(size * size * 0.4)
  })

  it('counts down and never goes negative', () => {
    expect(pairingSecondsLeft('2026-09-18T10:05:00Z', NOW)).toBe(300)
    expect(pairingSecondsLeft('2026-09-18T09:59:00Z', NOW)).toBe(0)
    expect(pairingSecondsLeft(undefined, NOW)).toBe(0)
    expect(pairingSecondsLeft('garbage', NOW)).toBe(0)
    expect(formatCountdown(300)).toBe('5:00')
    expect(formatCountdown(61)).toBe('1:01')
    expect(formatCountdown(0)).toBe('0:00')
  })

  it('labels device activity', () => {
    const device = { id: 'a', name: 'iPhone', createdAt: '', connected: false }
    expect(deviceActivityLabel({ ...device, connected: true }, NOW)).toBe('Connected')
    expect(deviceActivityLabel(device, NOW)).toBe('Never connected')
    expect(deviceActivityLabel({ ...device, lastSeenAt: '2026-09-18T09:59:40Z' }, NOW)).toBe(
      'Seen just now'
    )
    expect(deviceActivityLabel({ ...device, lastSeenAt: '2026-09-18T09:15:00Z' }, NOW)).toBe(
      'Seen 45 min ago'
    )
    expect(deviceActivityLabel({ ...device, lastSeenAt: '2026-09-16T10:00:00Z' }, NOW)).toBe(
      'Seen 2 d ago'
    )
  })

  it('surfaces bind and network problems instead of a dead button', () => {
    const base: RemoteLanStatus = {
      enabled: true,
      addresses: ['192.168.1.20'],
      devices: [],
      port: 7420
    }
    expect(phoneRemoteSummary(base)).toEqual({
      tone: 'ok',
      text: 'Listening on 192.168.1.20:7420 · same Wi-Fi only'
    })
    expect(phoneRemoteSummary({ ...base, bindError: 'Ports 7420–7429 are all in use.' })).toEqual({
      tone: 'warning',
      text: 'Ports 7420–7429 are all in use.'
    })
    expect(phoneRemoteSummary({ ...base, addresses: [] }).tone).toBe('warning')
    expect(
      phoneRemoteSummary({
        ...base,
        devices: [{ id: 'a', name: 'iPhone', createdAt: '', connected: true }]
      }).text
    ).toBe('1 phone connected · 192.168.1.20:7420')
  })
})
