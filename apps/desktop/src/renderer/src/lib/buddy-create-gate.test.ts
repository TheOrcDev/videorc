import { describe, expect, it } from 'vitest'

import type { AiCapabilities, BuddyLibraryState } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { BUDDY_ONBOARDING_GATES } from '@/lib/buddy-onboarding-copy'
import { BUDDY_GENERATE_NOT_AVAILABLE } from '@/lib/buddy-persona-view'

import {
  BUDDY_ALIVE_CONSENT_OFF,
  BUDDY_ALIVE_NONE_LEFT_GATE,
  BUDDY_ALIVE_PREMIUM,
  BUDDY_ALIVE_SIGNED_OUT,
  buddyAliveCreateGate,
  buddyImagesLeftLine,
  buddyLookCreateGate,
  buddyLookRedoGate,
  buddyRedoLabel
} from './buddy-create-gate'

const premium: EntitlementUiGate = { allowed: true }
const free: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Buddy requires Videorc Premium.',
  upgradeUrl: 'https://example.test/premium'
}

function caps(
  remainingToday = 24,
  buddyLibrary: { enabled: boolean; count: number; limit: number } | undefined = {
    enabled: true,
    count: 3,
    limit: 30
  },
  avatarEnabled = true,
  pet: { enabled: boolean; creationsRemainingThisMonth: number; monthlyLimit: number } = {
    enabled: true,
    creationsRemainingThisMonth: 2,
    monthlyLimit: 3
  }
): AiCapabilities {
  return {
    cohost: {
      avatar: { enabled: avatarEnabled, remainingToday, dailyLimit: 24 },
      ...(buddyLibrary ? { buddyLibrary } : {}),
      pet
    }
  } as unknown as AiCapabilities
}

const library = { limit: 30, mine: [] } as unknown as Pick<BuddyLibraryState, 'limit' | 'mine'>

describe('buddyLookCreateGate (plan 174 G-5): one model, one line, one action', () => {
  const allowed = { signedIn: true, gate: premium, consented: true, capabilities: caps(), library }

  it('lets a Premium account with consent, room and images create', () => {
    expect(buddyLookCreateGate(allowed)).toBeNull()
    expect(buddyLookCreateGate({ ...allowed, capabilities: caps(4) })).toBeNull()
  })

  it('checks in the order a streamer can fix them', () => {
    expect(
      buddyLookCreateGate({ ...allowed, signedIn: false, gate: free, consented: false })
    ).toEqual({
      kind: 'signed-out',
      reason: BUDDY_ONBOARDING_GATES.signedOut,
      action: { kind: 'sign-in' }
    })
    expect(buddyLookCreateGate({ ...allowed, gate: free, consented: false })).toEqual({
      kind: 'premium',
      reason: BUDDY_ONBOARDING_GATES.free,
      action: { kind: 'view-premium', url: 'https://example.test/premium' }
    })
    expect(buddyLookCreateGate({ ...allowed, consented: false })).toEqual({
      kind: 'cloud-ai',
      reason: BUDDY_ONBOARDING_GATES.cloudAiOff,
      action: { kind: 'allow-cloud-ai' }
    })
    expect(
      buddyLookCreateGate({
        ...allowed,
        capabilities: caps(24, { enabled: true, count: 30, limit: 30 })
      })
    ).toEqual({
      kind: 'full',
      reason: 'Your library is full (30 Buddies). Delete one to make room.',
      action: null
    })
    expect(buddyLookCreateGate({ ...allowed, capabilities: caps(24, undefined, false) })).toEqual({
      kind: 'unavailable',
      reason: BUDDY_GENERATE_NOT_AVAILABLE,
      action: null
    })
    expect(buddyLookCreateGate({ ...allowed, capabilities: null })?.kind).toBe('unavailable')
    // A Buddy is four images: three left is not enough.
    expect(buddyLookCreateGate({ ...allowed, capabilities: caps(3) })).toEqual({
      kind: 'allowance',
      reason: BUDDY_ONBOARDING_GATES.allowanceUsed,
      action: null
    })
  })

  it('gates Redo the same way, without the library room, and one image is enough', () => {
    const redo = { signedIn: true, gate: premium, consented: true, capabilities: caps(1) }
    expect(buddyLookRedoGate(redo)).toBeNull()
    expect(
      buddyLookRedoGate({ ...redo, capabilities: caps(1, { enabled: true, count: 30, limit: 30 }) })
    ).toBeNull()
    expect(buddyLookRedoGate({ ...redo, capabilities: caps(0) })?.kind).toBe('allowance')
    expect(buddyLookRedoGate({ ...redo, consented: false })?.action).toEqual({
      kind: 'allow-cloud-ai'
    })
  })

  it('falls back to the Premium page when the gate names no link', () => {
    const { upgradeUrl: _upgradeUrl, ...plain } = free
    expect(buddyLookCreateGate({ ...allowed, gate: plain })?.action).toEqual({
      kind: 'view-premium',
      url: 'https://www.videorc.com/premium'
    })
  })
})

describe('buddyAliveCreateGate (plan 174 G-5)', () => {
  const on = { signedIn: true, gate: premium, consented: true, capabilities: caps() }

  it('names the one reason creating moves is off, in the same order', () => {
    expect(buddyAliveCreateGate(on)).toBeNull()
    expect(buddyAliveCreateGate({ ...on, signedIn: false })).toEqual({
      kind: 'signed-out',
      reason: BUDDY_ALIVE_SIGNED_OUT,
      action: { kind: 'sign-in' }
    })
    expect(buddyAliveCreateGate({ ...on, gate: free })).toEqual({
      kind: 'premium',
      reason: BUDDY_ALIVE_PREMIUM,
      action: { kind: 'view-premium', url: 'https://example.test/premium' }
    })
    expect(buddyAliveCreateGate({ ...on, consented: false })).toEqual({
      kind: 'cloud-ai',
      reason: BUDDY_ALIVE_CONSENT_OFF,
      action: { kind: 'allow-cloud-ai' }
    })
    expect(buddyAliveCreateGate({ ...on, capabilities: null })).toEqual({
      kind: 'unavailable',
      reason: BUDDY_GENERATE_NOT_AVAILABLE,
      action: null
    })
    expect(
      buddyAliveCreateGate({
        ...on,
        capabilities: caps(24, undefined, true, {
          enabled: true,
          creationsRemainingThisMonth: 0,
          monthlyLimit: 3
        })
      })
    ).toBe(BUDDY_ALIVE_NONE_LEFT_GATE)
  })
})

describe('what a redo costs (plan 174 G-14)', () => {
  it('prices Redo and counts the images left', () => {
    expect(buddyRedoLabel('Redo')).toBe('Redo · 1 image')
    expect(buddyImagesLeftLine(caps(12))).toBe('12 images left today')
    expect(buddyImagesLeftLine(caps(1))).toBe('1 image left today')
    expect(buddyImagesLeftLine(caps(24, undefined, false))).toBeNull()
    expect(buddyImagesLeftLine(null)).toBeNull()
  })
})
