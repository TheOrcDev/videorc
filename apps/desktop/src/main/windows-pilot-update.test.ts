import { describe, expect, it } from 'vitest'

import {
  accountPilotUpdaterConfig,
  consumeWindowsUpdaterStartupConfig,
  getWindowsPilotUpdaterConfig,
  isWindowsPilotUpdateGrant,
  shouldProbeAccountPilotFeed,
  WINDOWS_PILOT_UPDATE_URL
} from './windows-pilot-update'

describe('getWindowsPilotUpdaterConfig', () => {
  it('uses only the fixed authenticated pilot route when explicitly enabled', () => {
    expect(
      getWindowsPilotUpdaterConfig(
        {
          VIDEORC_WINDOWS_PILOT_UPDATE: '1',
          VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'a'.repeat(32)
        },
        'win32'
      )
    ).toEqual({
      disableDifferentialDownload: true,
      requestHeaders: { Authorization: `Bearer ${'a'.repeat(32)}` },
      url: WINDOWS_PILOT_UPDATE_URL
    })
  })

  it('is disabled by default and fails closed on invalid mode, host, or token', () => {
    expect(getWindowsPilotUpdaterConfig({}, 'win32')).toBeNull()
    for (const [env, platform] of [
      [{ VIDEORC_WINDOWS_PILOT_UPDATE: 'true' }, 'win32'],
      [
        {
          VIDEORC_WINDOWS_PILOT_UPDATE: '1',
          VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'a'.repeat(32)
        },
        'darwin'
      ],
      [
        {
          VIDEORC_WINDOWS_PILOT_UPDATE: '1',
          VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'short'
        },
        'win32'
      ]
    ] as const) {
      expect(() => getWindowsPilotUpdaterConfig(env, platform)).toThrow()
    }
  })

  it('keeps pilot routing for manual checks while disabling background checks and scrubs the token', () => {
    const env = {
      VIDEORC_DISABLE_AUTO_UPDATE: '1',
      VIDEORC_WINDOWS_PILOT_UPDATE: '1',
      VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'b'.repeat(32)
    }

    expect(consumeWindowsUpdaterStartupConfig(env, 'win32')).toEqual({
      backgroundUpdatesDisabled: true,
      pilot: {
        disableDifferentialDownload: true,
        requestHeaders: { Authorization: `Bearer ${'b'.repeat(32)}` },
        url: WINDOWS_PILOT_UPDATE_URL
      }
    })
    expect(env).not.toHaveProperty('VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN')
  })

  it('scrubs an invalid pilot token before failing closed', () => {
    const env: Record<string, string | undefined> = {
      VIDEORC_WINDOWS_PILOT_UPDATE: '1',
      VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'short'
    }

    expect(() => consumeWindowsUpdaterStartupConfig(env, 'win32')).toThrow()
    expect(env.VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN).toBeUndefined()
  })
})

describe('signed-in Windows pilot access', () => {
  const grant = {
    token: 'wpu1.1790000000.abcdefghijklmnopqrstuvwx.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
    expiresAt: '2026-09-23T13:00:00.000Z'
  }

  it('accepts only a well-formed account grant', () => {
    expect(isWindowsPilotUpdateGrant(grant)).toBe(true)
    for (const invalid of [
      null,
      undefined,
      'wpu1.a.b.c',
      {},
      { ...grant, token: 'operator-token-without-the-account-prefix-xxxxxxxx' },
      { ...grant, token: 'wpu1.has space' },
      { ...grant, token: 'wpu1.line\nbreak' },
      { ...grant, token: `wpu1.${'x'.repeat(508)}` },
      { ...grant, expiresAt: 1790000000 }
    ]) {
      expect(isWindowsPilotUpdateGrant(invalid)).toBe(false)
    }
  })

  it('routes an account grant through the branded pilot proxy with the full downloader', () => {
    expect(accountPilotUpdaterConfig(grant)).toEqual({
      disableDifferentialDownload: true,
      requestHeaders: { Authorization: `Bearer ${grant.token}` },
      url: WINDOWS_PILOT_UPDATE_URL
    })
  })

  it('probes the pilot feed only when public has nothing for a Windows install', () => {
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: false,
        platform: 'win32',
        publicOutcome: 'missing-feed'
      })
    ).toBe(true)
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: false,
        platform: 'win32',
        publicOutcome: 'not-available'
      })
    ).toBe(true)
    // Public has something newer: it wins. The pilot pointer can trail public.
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: false,
        platform: 'win32',
        publicOutcome: 'available'
      })
    ).toBe(false)
    // A blocked or failing network is reported as-is, not masked by the pilot.
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: false,
        platform: 'win32',
        publicOutcome: 'failed'
      })
    ).toBe(false)
    // Operator mode already pins the pilot feed; macOS never uses it.
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: true,
        platform: 'win32',
        publicOutcome: 'missing-feed'
      })
    ).toBe(false)
    expect(
      shouldProbeAccountPilotFeed({
        operatorPilot: false,
        platform: 'darwin',
        publicOutcome: 'missing-feed'
      })
    ).toBe(false)
  })
})
