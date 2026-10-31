import { describe, expect, it } from 'vitest'

import { OFFLINE_LOCK_REASON, SESSION_LOCK_REASON, sessionLockReason } from './lock-reason'

// Plan 174 S1.5 (D-13, J2-9) and S3.5a (D-15): one wording per lock, for the
// LockAlert, a disabled control's reason and an agent's refusal alike.

describe('lock reasons', () => {
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
})
