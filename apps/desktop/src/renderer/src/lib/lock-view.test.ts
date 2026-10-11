import { describe, expect, it } from 'vitest'

import {
  OFFLINE_LOCK_REASON,
  SESSION_LOCK_REASON,
  sessionLockReason,
  unlockActionForGate,
  unlockActionForReason,
  unlockActionLabel
} from './lock-view'
import { VIDEORC_PREMIUM_URL } from './premium-upgrade'

// Plan 174 S1.5 (D-13, J2-9): locked means disabled with one reason and at
// most one action.

describe('lock view', () => {
  it('has one wording for a session lock and one for an offline backend', () => {
    expect(SESSION_LOCK_REASON).toBe(
      "Locked while you're recording or live. Changes apply the next time you record or go live."
    )
    expect(OFFLINE_LOCK_REASON).toBe(
      'Videorc is reconnecting. These controls come back in a moment.'
    )
    for (const copy of [SESSION_LOCK_REASON, OFFLINE_LOCK_REASON]) expect(copy).not.toMatch(/—/)
  })

  it('names what a session lock locks when asked, with the same second sentence', () => {
    expect(sessionLockReason()).toBe(SESSION_LOCK_REASON)
    expect(sessionLockReason('Destinations and stream details')).toBe(
      "Destinations and stream details are locked while you're recording or live. Changes apply the next time you record or go live."
    )
  })

  it('labels the two actions', () => {
    expect(unlockActionLabel({ kind: 'sign-in' })).toBe('Sign in')
    expect(unlockActionLabel({ kind: 'view-premium', url: VIDEORC_PREMIUM_URL })).toBe(
      'View Premium'
    )
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
