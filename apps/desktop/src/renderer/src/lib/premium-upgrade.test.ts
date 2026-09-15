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

  // The still-Premium streaming-quality reason (videoProfileEntitlementGate);
  // multistreaming is free, so its destination-cap copy must NOT match.
  const premiumProfileReason =
    '3840x2160 @ 30 FPS requires Videorc Premium. Your streaming limit is 1920x1080 @ 30 FPS and 6000 kbps.'

  it('detects premium blocker copy', () => {
    expect(isPremiumUpgradeMessage(premiumProfileReason)).toBe(true)
    expect(isPremiumUpgradeMessage('Cloud AI is a Videorc Premium feature.')).toBe(true)
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
            message: premiumProfileReason
          }
        ]
      })
    ).toBe(premiumProfileReason)
  })
})
