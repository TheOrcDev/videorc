import { describe, expect, it } from 'vitest'

import type { StreamPlatform } from '@/lib/backend'

import { destinationLabel, platformCopy, platformLabel } from './platform-copy'

// Plan 174 S1.4 (D-36, I-9, C-30).

describe('platformLabel', () => {
  it('names each streaming platform one way', () => {
    const labels: Record<StreamPlatform, string> = {
      youtube: 'YouTube',
      twitch: 'Twitch',
      kick: 'Kick',
      x: 'X',
      tiktok: 'TikTok',
      instagram: 'Instagram',
      custom: 'Custom RTMP'
    }
    for (const [platform, label] of Object.entries(labels)) {
      expect(platformLabel(platform as StreamPlatform)).toBe(label)
    }
  })

  it('never says "X / Twitter" or a bare "Custom"', () => {
    expect(platformLabel('x')).not.toMatch(/Twitter/)
    expect(platformLabel('custom')).not.toBe('Custom')
  })
})

describe('destinationLabel (plan 174 S2.3a, D-36)', () => {
  it('reads the retired X default as X, without touching other names', () => {
    expect(destinationLabel('X / Twitter')).toBe('X')
    expect(destinationLabel('X')).toBe('X')
    expect(destinationLabel('YouTube Vertical')).toBe('YouTube Vertical')
    expect(destinationLabel('My X / Twitter relay')).toBe('My X / Twitter relay')
    expect(destinationLabel('toString')).toBe('toString')
  })
})

describe('platformCopy', () => {
  it('speaks Mac on macOS', () => {
    expect(platformCopy('darwin')).toEqual({
      deviceNoun: 'Mac',
      osSettingsName: 'System Settings',
      osName: 'macOS',
      defaultRecordingsPath: '~/Movies/Videorc/Recordings'
    })
  })

  it('speaks PC on Windows, with the Videos folder the backend uses', () => {
    const copy = platformCopy('win32')
    expect(copy.deviceNoun).toBe('PC')
    expect(copy.osSettingsName).toBe('Windows Settings')
    expect(copy.osName).toBe('Windows')
    expect(copy.defaultRecordingsPath).toContain('Videos\\Videorc\\Recordings')
    expect(JSON.stringify(copy)).not.toMatch(/Mac|Movies|macOS|Finder/)
  })

  it('speaks computer elsewhere, and before the platform is known', () => {
    for (const platform of ['linux', undefined]) {
      const copy = platformCopy(platform)
      expect(copy.deviceNoun).toBe('computer')
      expect(copy.osName).not.toBe('macOS')
    }
  })
})
