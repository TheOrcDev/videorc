import { afterEach, describe, expect, it } from 'vitest'

import { EMPTY_BUDDY_ONBOARDING_INPUT } from '@/lib/buddy-library-view'

import {
  EMPTY_BUDDY_ONBOARDING_DRAFT,
  buddyOnboardingDraftDirty,
  clearBuddyOnboardingDraft,
  clearBuddyOnboardingRequest,
  patchBuddyOnboardingDraft,
  patchBuddyOnboardingInput,
  readBuddyOnboardingDraft,
  readBuddyOnboardingRequest,
  requestBuddyOnboarding
} from './buddy-onboarding-store'

afterEach(() => {
  clearBuddyOnboardingDraft()
  clearBuddyOnboardingRequest()
})

describe('the onboarding draft store (plan 174 G-12, G-13)', () => {
  it('keeps what was typed, the step and the picture across readers', () => {
    expect(readBuddyOnboardingDraft()).toBe(EMPTY_BUDDY_ONBOARDING_DRAFT)
    patchBuddyOnboardingInput({ description: 'A goblin' })
    patchBuddyOnboardingDraft({ step: 3 })
    expect(readBuddyOnboardingDraft()).toEqual({
      input: { ...EMPTY_BUDDY_ONBOARDING_INPUT, description: 'A goblin' },
      picture: null,
      step: 3,
      leftBehindDraftId: null
    })
    clearBuddyOnboardingDraft()
    expect(readBuddyOnboardingDraft()).toBe(EMPTY_BUDDY_ONBOARDING_DRAFT)
  })

  it('is dirty with any text or a picture, and clean otherwise', () => {
    expect(buddyOnboardingDraftDirty(EMPTY_BUDDY_ONBOARDING_DRAFT)).toBe(false)
    expect(
      buddyOnboardingDraftDirty({
        input: { ...EMPTY_BUDDY_ONBOARDING_INPUT, name: '   ' },
        picture: null
      })
    ).toBe(false)
    expect(
      buddyOnboardingDraftDirty({
        input: { ...EMPTY_BUDDY_ONBOARDING_INPUT, about: 'I stream on Fridays.' },
        picture: null
      })
    ).toBe(true)
    expect(
      buddyOnboardingDraftDirty({
        input: EMPTY_BUDDY_ONBOARDING_INPUT,
        picture: {
          name: 'cat.png',
          url: 'blob:cat',
          prepared: { base64: 'AAAA', type: 'image/png', width: 1, height: 1, bytes: 4 }
        }
      })
    ).toBe(true)
  })

  it('asks My Buddies to open the sheet with a fresh nonce each time (G-4)', () => {
    expect(readBuddyOnboardingRequest()).toBeNull()
    requestBuddyOnboarding(2)
    expect(readBuddyOnboardingRequest()).toEqual({ nonce: 1, step: 2 })
    requestBuddyOnboarding()
    expect(readBuddyOnboardingRequest()).toEqual({ nonce: 2, step: 1 })
    clearBuddyOnboardingRequest()
    expect(readBuddyOnboardingRequest()).toBeNull()
  })
})
