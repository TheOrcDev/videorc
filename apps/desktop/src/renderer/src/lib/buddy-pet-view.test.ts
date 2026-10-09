// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { AiCapabilities } from '@/lib/backend'
import {
  closeBuddyPetCreator,
  openBuddyPetCreator,
  useBuddyPetCreatorOpen
} from '@/lib/buddy-pet-creator-nav'
import {
  BUDDY_CREATE_CONSENT_OFF,
  BUDDY_CREATE_SIGNED_OUT,
  BUDDY_CREATE_USED_UP,
  BUDDY_REACTION_DEFAULT_VALUE,
  buddyChoosableReactions,
  buddyPetCapability,
  buddyPetCreateAvailability,
  buddyPetPosesLabel,
  buddyPetSourceLabel,
  buddyReactionLabel,
  buddySleepChoices,
  buddySleepLabel,
  buddyTriggerOutcome,
  withBuddyTriggerReaction
} from '@/lib/buddy-pet-view'
import { BUDDY_GENERATE_NOT_AVAILABLE } from '@/lib/buddy-persona-view'

const STILL = ['talk', 'laugh', 'think']
const PAGE_PET = ['laugh', 'surprised', 'wink', 'kiss', 'blink', 'sleep', 'proud', 'excited']

describe('buddyTriggerOutcome (D14)', () => {
  it('takes the first default the pack has, then hops, and leaves a failed destination alone', () => {
    expect(buddyTriggerOutcome('follow', {}, PAGE_PET)).toEqual({ kind: 'reaction', id: 'proud' })
    expect(buddyTriggerOutcome('follow', {}, [...PAGE_PET, 'wave'])).toEqual({
      kind: 'reaction',
      id: 'wave'
    })
    expect(buddyTriggerOutcome('follow', {}, STILL)).toEqual({ kind: 'hop', id: 'wave' })
    expect(buddyTriggerOutcome('tip', {}, PAGE_PET)).toEqual({ kind: 'reaction', id: 'surprised' })
    expect(buddyTriggerOutcome('destination-failed', {}, PAGE_PET)).toEqual({ kind: 'none' })
  })

  it('lets the persona override it, turn it off, or name an id the pack lacks', () => {
    expect(buddyTriggerOutcome('raid', { raid: 'laugh' }, STILL)).toEqual({
      kind: 'reaction',
      id: 'laugh'
    })
    expect(buddyTriggerOutcome('raid', { raid: 'none' }, PAGE_PET)).toEqual({ kind: 'none' })
    expect(buddyTriggerOutcome('raid', { raid: 'dance' }, PAGE_PET)).toEqual({
      kind: 'hop',
      id: 'dance'
    })
    expect(
      buddyTriggerOutcome('destination-failed', { 'destination-failed': 'worried' }, PAGE_PET)
    ).toEqual({ kind: 'hop', id: 'worried' })
  })

  it('writes and clears one trigger in the table', () => {
    expect(withBuddyTriggerReaction({ raid: 'laugh' }, 'follow', 'proud')).toEqual({
      raid: 'laugh',
      follow: 'proud'
    })
    expect(
      withBuddyTriggerReaction({ raid: 'laugh' }, 'raid', BUDDY_REACTION_DEFAULT_VALUE)
    ).toEqual({})
    expect(withBuddyTriggerReaction({}, 'gift', 'none')).toEqual({ gift: 'none' })
  })

  it('never offers blink or sleep, and labels ids plainly', () => {
    expect(buddyChoosableReactions(PAGE_PET)).toEqual([
      'laugh',
      'surprised',
      'wink',
      'kiss',
      'proud',
      'excited'
    ])
    expect(buddyReactionLabel('talk-a')).toBe('Talk a')
    expect(buddyReactionLabel('surprised')).toBe('Surprised')
  })
})

describe('Motion and pack copy', () => {
  it('lists Sleep after choices and keeps a stored value outside them', () => {
    expect(buddySleepChoices(180)).toEqual([0, 60, 180, 300, 600])
    expect(buddySleepChoices(90)).toEqual([0, 60, 90, 180, 300, 600])
    expect([0, 30, 60, 90, 600, 1800].map(buddySleepLabel)).toEqual([
      'Never',
      '30 s',
      '1 min',
      '1 min 30 s',
      '10 min',
      '30 min'
    ])
  })

  it('names a pack by its poses and where it came from', () => {
    expect(
      buddyPetPosesLabel({ gazeCount: 25, reactions: PAGE_PET.concat(['a', 'b', 'c', 'd']) })
    ).toBe('37 poses')
    expect(buddyPetPosesLabel({ gazeCount: 1, reactions: [] })).toBe('1 pose')
    expect(buddyPetSourceLabel({ packId: 'bundled:buddy', source: 'videorc-creator' })).toBe(
      'Built in'
    )
    expect(buddyPetSourceLabel({ packId: 'x', source: 'videorc-creator' })).toBe('Made in Videorc')
    expect(buddyPetSourceLabel({ packId: 'x', source: 'page-pet-import' })).toBe('Imported')
  })
})

describe('Create availability (D20)', () => {
  const on = {
    signedIn: true,
    gate: { allowed: true } as const,
    consented: true,
    capabilities: {
      cohost: { pet: { enabled: true, creationsRemainingThisMonth: 2, monthlyLimit: 3 } }
    } as unknown as AiCapabilities
  }

  it('reads the web block leniently: absent, partial or odd numbers', () => {
    expect(buddyPetCapability(null)).toBeNull()
    expect(buddyPetCapability({ cohost: { tick: 4 } } as AiCapabilities)).toBeNull()
    expect(
      buddyPetCapability({ cohost: { pet: { enabled: true } } } as unknown as AiCapabilities)
    ).toEqual({ enabled: true, remaining: null, limit: null })
    expect(
      buddyPetCapability({
        cohost: { pet: { enabled: 'yes', creationsRemainingThisMonth: -1, monthlyLimit: 3.7 } }
      } as unknown as AiCapabilities)
    ).toEqual({ enabled: false, remaining: null, limit: 3 })
  })

  it('names the one reason Create is off, in the order a streamer fixes them', () => {
    expect(buddyPetCreateAvailability(on)).toEqual({
      allowed: true,
      reason: null,
      allowance: '2 of 3 left this month'
    })
    expect(buddyPetCreateAvailability({ ...on, signedIn: false }).reason).toBe(
      BUDDY_CREATE_SIGNED_OUT
    )
    expect(
      buddyPetCreateAvailability({
        ...on,
        gate: {
          allowed: false,
          featureId: 'live-cohost',
          reason: 'Golem requires Videorc Premium.',
          upgradeUrl: 'https://www.videorc.com/premium'
        }
      }).reason
    ).toBe('Golem requires Videorc Premium.')
    expect(buddyPetCreateAvailability({ ...on, consented: false }).reason).toBe(
      BUDDY_CREATE_CONSENT_OFF
    )
    expect(buddyPetCreateAvailability({ ...on, capabilities: null })).toEqual({
      allowed: false,
      reason: BUDDY_GENERATE_NOT_AVAILABLE,
      allowance: null
    })
    expect(
      buddyPetCreateAvailability({
        ...on,
        capabilities: {
          cohost: { pet: { enabled: true, creationsRemainingThisMonth: 0, monthlyLimit: 3 } }
        } as unknown as AiCapabilities
      })
    ).toEqual({ allowed: false, reason: BUDDY_CREATE_USED_UP, allowance: '0 of 3 left this month' })
  })
})

describe('buddy-pet-creator-nav', () => {
  it('opens and closes the creator for every reader', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const seen: boolean[] = []
    function Probe(): null {
      seen.push(useBuddyPetCreatorOpen())
      return null
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(createElement(Probe)))
    await act(async () => openBuddyPetCreator())
    await act(async () => openBuddyPetCreator())
    await act(async () => closeBuddyPetCreator())
    expect(seen).toEqual([false, true, false])
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  })
})
