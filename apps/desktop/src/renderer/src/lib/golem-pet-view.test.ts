// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { AiCapabilities } from '@/lib/backend'
import {
  closeGolemPetCreator,
  openGolemPetCreator,
  useGolemPetCreatorOpen
} from '@/lib/golem-pet-creator-nav'
import {
  GOLEM_CREATE_CONSENT_OFF,
  GOLEM_CREATE_SIGNED_OUT,
  GOLEM_CREATE_USED_UP,
  GOLEM_REACTION_DEFAULT_VALUE,
  golemChoosableReactions,
  golemPetCapability,
  golemPetCreateAvailability,
  golemPetPosesLabel,
  golemPetSourceLabel,
  golemReactionLabel,
  golemSleepChoices,
  golemSleepLabel,
  golemTriggerOutcome,
  withGolemTriggerReaction
} from '@/lib/golem-pet-view'
import { GOLEM_GENERATE_NOT_AVAILABLE } from '@/lib/golem-persona-view'

const STILL = ['talk', 'laugh', 'think']
const PAGE_PET = ['laugh', 'surprised', 'wink', 'kiss', 'blink', 'sleep', 'proud', 'excited']

describe('golemTriggerOutcome (D14)', () => {
  it('takes the first default the pack has, then hops, and leaves a failed destination alone', () => {
    expect(golemTriggerOutcome('follow', {}, PAGE_PET)).toEqual({ kind: 'reaction', id: 'proud' })
    expect(golemTriggerOutcome('follow', {}, [...PAGE_PET, 'wave'])).toEqual({
      kind: 'reaction',
      id: 'wave'
    })
    expect(golemTriggerOutcome('follow', {}, STILL)).toEqual({ kind: 'hop', id: 'wave' })
    expect(golemTriggerOutcome('tip', {}, PAGE_PET)).toEqual({ kind: 'reaction', id: 'surprised' })
    expect(golemTriggerOutcome('destination-failed', {}, PAGE_PET)).toEqual({ kind: 'none' })
  })

  it('lets the persona override it, turn it off, or name an id the pack lacks', () => {
    expect(golemTriggerOutcome('raid', { raid: 'laugh' }, STILL)).toEqual({
      kind: 'reaction',
      id: 'laugh'
    })
    expect(golemTriggerOutcome('raid', { raid: 'none' }, PAGE_PET)).toEqual({ kind: 'none' })
    expect(golemTriggerOutcome('raid', { raid: 'dance' }, PAGE_PET)).toEqual({
      kind: 'hop',
      id: 'dance'
    })
    expect(
      golemTriggerOutcome('destination-failed', { 'destination-failed': 'worried' }, PAGE_PET)
    ).toEqual({ kind: 'hop', id: 'worried' })
  })

  it('writes and clears one trigger in the table', () => {
    expect(withGolemTriggerReaction({ raid: 'laugh' }, 'follow', 'proud')).toEqual({
      raid: 'laugh',
      follow: 'proud'
    })
    expect(
      withGolemTriggerReaction({ raid: 'laugh' }, 'raid', GOLEM_REACTION_DEFAULT_VALUE)
    ).toEqual({})
    expect(withGolemTriggerReaction({}, 'gift', 'none')).toEqual({ gift: 'none' })
  })

  it('never offers blink or sleep, and labels ids plainly', () => {
    expect(golemChoosableReactions(PAGE_PET)).toEqual([
      'laugh',
      'surprised',
      'wink',
      'kiss',
      'proud',
      'excited'
    ])
    expect(golemReactionLabel('talk-a')).toBe('Talk a')
    expect(golemReactionLabel('surprised')).toBe('Surprised')
  })
})

describe('Motion and pack copy', () => {
  it('lists Sleep after choices and keeps a stored value outside them', () => {
    expect(golemSleepChoices(180)).toEqual([0, 60, 180, 300, 600])
    expect(golemSleepChoices(90)).toEqual([0, 60, 90, 180, 300, 600])
    expect([0, 30, 60, 90, 600, 1800].map(golemSleepLabel)).toEqual([
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
      golemPetPosesLabel({ gazeCount: 25, reactions: PAGE_PET.concat(['a', 'b', 'c', 'd']) })
    ).toBe('37 poses')
    expect(golemPetPosesLabel({ gazeCount: 1, reactions: [] })).toBe('1 pose')
    expect(golemPetSourceLabel({ packId: 'bundled:golem', source: 'videorc-creator' })).toBe(
      'Built in'
    )
    expect(golemPetSourceLabel({ packId: 'x', source: 'videorc-creator' })).toBe('Made in Videorc')
    expect(golemPetSourceLabel({ packId: 'x', source: 'page-pet-import' })).toBe('Imported')
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
    expect(golemPetCapability(null)).toBeNull()
    expect(golemPetCapability({ cohost: { tick: 4 } } as AiCapabilities)).toBeNull()
    expect(
      golemPetCapability({ cohost: { pet: { enabled: true } } } as unknown as AiCapabilities)
    ).toEqual({ enabled: true, remaining: null, limit: null })
    expect(
      golemPetCapability({
        cohost: { pet: { enabled: 'yes', creationsRemainingThisMonth: -1, monthlyLimit: 3.7 } }
      } as unknown as AiCapabilities)
    ).toEqual({ enabled: false, remaining: null, limit: 3 })
  })

  it('names the one reason Create is off, in the order a streamer fixes them', () => {
    expect(golemPetCreateAvailability(on)).toEqual({
      allowed: true,
      reason: null,
      allowance: '2 of 3 left this month'
    })
    expect(golemPetCreateAvailability({ ...on, signedIn: false }).reason).toBe(
      GOLEM_CREATE_SIGNED_OUT
    )
    expect(
      golemPetCreateAvailability({
        ...on,
        gate: {
          allowed: false,
          featureId: 'live-cohost',
          reason: 'Golem requires Videorc Premium.',
          upgradeUrl: 'https://www.videorc.com/premium'
        }
      }).reason
    ).toBe('Golem requires Videorc Premium.')
    expect(golemPetCreateAvailability({ ...on, consented: false }).reason).toBe(
      GOLEM_CREATE_CONSENT_OFF
    )
    expect(golemPetCreateAvailability({ ...on, capabilities: null })).toEqual({
      allowed: false,
      reason: GOLEM_GENERATE_NOT_AVAILABLE,
      allowance: null
    })
    expect(
      golemPetCreateAvailability({
        ...on,
        capabilities: {
          cohost: { pet: { enabled: true, creationsRemainingThisMonth: 0, monthlyLimit: 3 } }
        } as unknown as AiCapabilities
      })
    ).toEqual({ allowed: false, reason: GOLEM_CREATE_USED_UP, allowance: '0 of 3 left this month' })
  })
})

describe('golem-pet-creator-nav', () => {
  it('opens and closes the creator for every reader', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const seen: boolean[] = []
    function Probe(): null {
      seen.push(useGolemPetCreatorOpen())
      return null
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(createElement(Probe)))
    await act(async () => openGolemPetCreator())
    await act(async () => openGolemPetCreator())
    await act(async () => closeGolemPetCreator())
    expect(seen).toEqual([false, true, false])
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  })
})
