import { describe, expect, it } from 'vitest'

import {
  isPremiumUpgradeMessage,
  premiumRequiredIssueMessage,
  VIDEORC_PREMIUM_URL
} from './premium-upgrade'

describe('premium upgrade helpers', () => {
  it('uses the public Videorc premium URL', () => {
    expect(VIDEORC_PREMIUM_URL).toBe('https://www.videorc.com/premium')
  })

  // A still-Premium reason (cloud features only since Plan 075). Streaming
  // quality and the multistreaming destination cap are free pipeline limits,
  // so their copy must NOT match the upgrade sniff.
  const premiumCloudReason = 'Cloud AI is a Videorc Premium feature.'
  const streamingLimitReason =
    '3840x2160 @ 60 FPS exceeds the streaming limit. Your streaming limit is 3840x2160 @ 60 FPS and 30000 kbps.'

  it('detects premium blocker copy', () => {
    expect(isPremiumUpgradeMessage(premiumCloudReason)).toBe(true)
    expect(isPremiumUpgradeMessage('Noise Cleanup requires Videorc Premium.')).toBe(true)
    // Streaming quality is free (Plan 075): its over-limit copy must never
    // read as an upgrade prompt.
    expect(isPremiumUpgradeMessage(streamingLimitReason)).toBe(false)
    expect(isPremiumUpgradeMessage('No streaming destination is ready.')).toBe(false)
    expect(isPremiumUpgradeMessage('You can stream to up to 5 destinations at once.')).toBe(false)
    expect(
      isPremiumUpgradeMessage(
        'You can stream to up to 5 destinations at once; this session has 6 ready destination(s).'
      )
    ).toBe(false)
  })

  it('returns the first premium error issue from Go Live preflight', () => {
    expect(
      premiumRequiredIssueMessage({
        issues: [
          {
            severity: 'warning',
            message: 'Twitch category is missing.'
          },
          {
            severity: 'error',
            message: 'You can stream to up to 5 destinations at once.'
          },
          {
            severity: 'error',
            message: premiumCloudReason
          }
        ]
      })
    ).toBe(premiumCloudReason)
  })
})
