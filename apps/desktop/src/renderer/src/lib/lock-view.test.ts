import { describe, expect, it, vi } from 'vitest'

import { lockAlertAction, unlockActionForGate, unlockActionForReason } from './lock-view'
import { VIDEORC_PREMIUM_URL } from './premium-upgrade'
import { beginVideorcSignIn, openVideorcWebLink } from './videorc-web-links'

vi.mock('./videorc-web-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./videorc-web-links')>()),
  beginVideorcSignIn: vi.fn(),
  openVideorcWebLink: vi.fn()
}))

// Plan 174 S1.5 (D-13, J2-9): locked means disabled with one reason and at
// most one action.

describe('lock view', () => {
  it("hands the LockAlert Videorc's sign-in and the system browser", () => {
    expect(lockAlertAction(null)).toBeNull()
    expect(lockAlertAction({ kind: 'sign-in' })).toEqual({
      kind: 'sign-in',
      onClick: beginVideorcSignIn
    })
    expect(lockAlertAction({ kind: 'view-premium', url: VIDEORC_PREMIUM_URL })).toEqual({
      kind: 'view-premium',
      url: VIDEORC_PREMIUM_URL,
      onClick: openVideorcWebLink
    })
  })

  it('offers View Premium only for a Premium gate', () => {
    expect(unlockActionForGate({ allowed: true })).toBeNull()
    expect(
      unlockActionForGate({
        allowed: false,
        featureId: 'cloud-ai',
        reason: 'Cloud AI is part of Videorc Premium.',
        upgradeUrl: VIDEORC_PREMIUM_URL
      })
    ).toEqual({ kind: 'view-premium', url: VIDEORC_PREMIUM_URL })
    // A pipeline limit locks with its reason alone.
    expect(
      unlockActionForGate({
        allowed: false,
        featureId: 'multistreaming',
        reason: 'You can stream to up to 5 destinations at once.'
      })
    ).toBeNull()
  })

  it('reads a bare reason by the same Premium rule', () => {
    expect(unlockActionForReason('Livestreaming is part of Videorc Premium.')).toEqual({
      kind: 'view-premium',
      url: VIDEORC_PREMIUM_URL
    })
    expect(unlockActionForReason('This Videorc feature is not enabled.')).toBeNull()
    expect(unlockActionForReason(null)).toBeNull()
  })
})
