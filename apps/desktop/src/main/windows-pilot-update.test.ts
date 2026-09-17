import { describe, expect, it } from 'vitest'

import {
  consumeWindowsUpdaterStartupConfig,
  getWindowsPilotUpdaterConfig,
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
