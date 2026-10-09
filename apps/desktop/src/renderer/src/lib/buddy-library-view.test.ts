import { describe, expect, it } from 'vitest'

import type { AiCapabilities, BuddyLibraryEntry, BuddyLibraryState } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import {
  EMPTY_BUDDY_ONBOARDING_INPUT,
  BUDDY_INVITATION_STORAGE_KEY,
  buddyCreateFailureLine,
  buddyCreateGate,
  buddyInvitationVisible,
  buddyLibraryIsFull,
  buddyLibraryView,
  buddyOnboardingAllowanceLine,
  buddyOnboardingCanAdvance,
  buddyOnboardingCanSkip,
  buddyOnboardingCreateParams,
  buddyOnboardingReachable,
  readBuddyInvitationDismissed,
  writeBuddyInvitationDismissed,
  type BuddyOnboardingInput
} from './buddy-library-view'
import { BUDDY_OFFICIAL_CATALOG } from '../../../shared/buddy-library'

const MINE = '7c9e6679-7425-40de-944b-e07fc1ee9a51'
const OLDER = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

function entry(id: string, name: string): BuddyLibraryEntry {
  return {
    id,
    name,
    description: `${name} as asked`,
    personality: '',
    context: '',
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    poses: {
      idle: `videorc-asset://buddy/library/${id}/idle-0a1b2c3d.png`,
      talk: null,
      laugh: null,
      think: null
    }
  }
}

function library(patch: Partial<BuddyLibraryState> = {}): BuddyLibraryState {
  return {
    signedIn: true,
    official: BUDDY_OFFICIAL_CATALOG.map(({ description: _description, ...rest }) => rest),
    mine: [entry(MINE, 'Grum'), entry(OLDER, 'Pebble')],
    activeAvatarId: MINE,
    serverActiveAvatarId: null,
    limit: 30,
    busy: null,
    ...patch
  }
}

const premium: EntitlementUiGate = { allowed: true }
const free: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Premium',
  upgradeUrl: 'https://example.test/premium'
}
function caps(
  remainingToday = 24,
  buddyLibrary?: { enabled: boolean; count: number; limit: number },
  enabled = true
): Pick<AiCapabilities, 'cohost'> {
  return {
    cohost: { avatar: { enabled, remainingToday, dailyLimit: 24 }, buddyLibrary }
  } as Pick<AiCapabilities, 'cohost'>
}

describe('buddyLibraryView (plan 170 D16)', () => {
  it('groups the official five and mine, newest first, with the active one marked', () => {
    const view = buddyLibraryView({ library: library(), persona: null })
    expect(view.official.map((card) => card.name)).toEqual([
      'Buddy',
      'Golmar',
      'Nib',
      'Captain Barnacle',
      'Bolt'
    ])
    expect(view.official.map((card) => card.subtitle)).toEqual([
      'The original. Steady as stone.',
      'Loud, loyal, all horde.',
      'Small, sly and in on the joke.',
      'Calls your chat his crew.',
      'Polite, precise, loves a stat.'
    ])
    expect(view.official.every((card) => card.kind === 'official' && !card.active)).toBe(true)
    expect(view.mine?.map((card) => [card.name, card.active])).toEqual([
      ['Grum', true],
      ['Pebble', false]
    ])
    expect(view.mine?.[0]?.idleUrl).toBe(`videorc-asset://buddy/library/${MINE}/idle-0a1b2c3d.png`)
  })

  it('shows the catalog and the persona link before the backend answers', () => {
    const view = buddyLibraryView({
      library: null,
      persona: { source: 'default' }
    })
    expect(view.official).toHaveLength(5)
    expect(view.official[0]).toMatchObject({ id: 'official:golem', active: true })
    expect(view.mine).toBeNull()
    expect(view.signedIn).toBe(false)
  })

  it('hides mine when signed out and keeps official usable', () => {
    const view = buddyLibraryView({
      library: library({ signedIn: false, mine: null, activeAvatarId: 'official:orc' }),
      persona: null
    })
    expect(view.mine).toBeNull()
    expect(view.official.find((card) => card.active)?.name).toBe('Golmar')
  })

  it('names the Buddy picked on videorc.com when sync would not apply it', () => {
    expect(
      buddyLibraryView({
        library: library({ activeAvatarId: null, serverActiveAvatarId: OLDER }),
        persona: null
      }).pickedElsewhere
    ).toEqual({ id: OLDER, name: 'Pebble' })
    expect(
      buddyLibraryView({
        library: library({ activeAvatarId: null, serverActiveAvatarId: 'official:pirate' }),
        persona: null
      }).pickedElsewhere
    ).toEqual({ id: 'official:pirate', name: 'Captain Barnacle' })
    // An id this app cannot name yet says nothing rather than a blank name.
    expect(
      buddyLibraryView({
        library: library({ serverActiveAvatarId: '11111111-2222-4333-8444-555555555555' }),
        persona: null
      }).pickedElsewhere
    ).toBeNull()
  })

  it('marks the card a job acts on, and a sync as syncing', () => {
    const using = buddyLibraryView({
      library: library({ busy: { kind: 'use', avatarId: 'official:robot' } }),
      persona: null
    })
    expect(using.busy).toBe(true)
    expect(using.syncing).toBe(false)
    expect(using.official.find((card) => card.busy)?.name).toBe('Bolt')
    const syncing = buddyLibraryView({
      library: library({ busy: { kind: 'sync' } }),
      persona: null
    })
    expect(syncing.syncing).toBe(true)
    expect(
      buddyLibraryView({
        library: library({ error: { code: 'network', message: 'Could not reach Videorc.' } }),
        persona: null
      }).error
    ).toBe('Could not reach Videorc.')
  })

  it('is full at the limit, by the web count first', () => {
    expect(buddyLibraryIsFull(caps(24, { enabled: true, count: 30, limit: 30 }), null)).toBe(true)
    expect(buddyLibraryIsFull(caps(24, { enabled: true, count: 3, limit: 30 }), library())).toBe(
      false
    )
    expect(buddyLibraryIsFull(null, library({ limit: 2 }))).toBe(true)
  })
})

describe('the first-launch invitation (plan 170 D16)', () => {
  it('shows only for the untouched default Buddy, until dismissed', () => {
    const base = { library: { activeAvatarId: 'official:golem' }, dismissed: false }
    expect(buddyInvitationVisible({ ...base, persona: { source: 'default' } })).toBe(true)
    expect(
      buddyInvitationVisible({ ...base, dismissed: true, persona: { source: 'default' } })
    ).toBe(false)
    // Picked on purpose: linked, so not untouched.
    expect(
      buddyInvitationVisible({
        ...base,
        persona: { source: 'default', libraryAvatarId: 'official:golem' }
      })
    ).toBe(false)
    expect(buddyInvitationVisible({ ...base, persona: { source: 'generated' } })).toBe(false)
    expect(
      buddyInvitationVisible({
        library: { activeAvatarId: 'official:orc' },
        persona: { source: 'default' },
        dismissed: false
      })
    ).toBe(false)
    expect(buddyInvitationVisible({ ...base, library: null, persona: { source: 'default' } })).toBe(
      false
    )
  })

  it('remembers the dismissal per machine, and survives broken storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
    expect(readBuddyInvitationDismissed(storage)).toBe(false)
    writeBuddyInvitationDismissed(storage)
    expect(store.get(BUDDY_INVITATION_STORAGE_KEY)).toBe('1')
    expect(readBuddyInvitationDismissed(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(readBuddyInvitationDismissed(broken)).toBe(false)
    expect(() => writeBuddyInvitationDismissed(broken)).not.toThrow()
  })
})

describe('the onboarding steps (plan 170 D14)', () => {
  const input = (patch: Partial<BuddyOnboardingInput> = {}): BuddyOnboardingInput => ({
    ...EMPTY_BUDDY_ONBOARDING_INPUT,
    ...patch
  })

  it('advances step 2 with a description or a picture, within 600 characters', () => {
    expect(buddyOnboardingCanAdvance(1, input())).toBe(true)
    expect(buddyOnboardingCanAdvance(2, input())).toBe(false)
    expect(buddyOnboardingCanAdvance(2, input({ description: '   ' }))).toBe(false)
    expect(buddyOnboardingCanAdvance(2, input({ description: 'A mossy golem' }))).toBe(true)
    expect(buddyOnboardingCanAdvance(2, input({ hasPicture: true }))).toBe(true)
    expect(buddyOnboardingCanAdvance(2, input({ description: 'x'.repeat(601) }))).toBe(false)
  })

  it('advances step 3 with a 1 to 24 character name and bounded optional fields', () => {
    expect(buddyOnboardingCanAdvance(3, input())).toBe(false)
    expect(buddyOnboardingCanAdvance(3, input({ name: '  ' }))).toBe(false)
    expect(buddyOnboardingCanAdvance(3, input({ name: 'Grum' }))).toBe(true)
    expect(buddyOnboardingCanAdvance(3, input({ name: 'x'.repeat(24) }))).toBe(true)
    expect(buddyOnboardingCanAdvance(3, input({ name: 'x'.repeat(25) }))).toBe(false)
    // An emoji is one character.
    expect(buddyOnboardingCanAdvance(3, input({ name: '🪨'.repeat(24) }))).toBe(true)
    expect(
      buddyOnboardingCanAdvance(3, input({ name: 'Grum', personality: 'x'.repeat(1201) }))
    ).toBe(false)
    expect(buddyOnboardingCanAdvance(3, input({ name: 'Grum', about: 'x'.repeat(4001) }))).toBe(
      false
    )
    expect(buddyOnboardingCanAdvance(4, input({ name: 'Grum' }))).toBe(false)
  })

  it('offers Skip for now on step 3 once the name is filled', () => {
    expect(buddyOnboardingCanSkip(3, input())).toBe(false)
    expect(buddyOnboardingCanSkip(3, input({ name: 'Grum' }))).toBe(true)
    expect(buddyOnboardingCanSkip(2, input({ name: 'Grum' }))).toBe(false)
  })

  it('never lands past a step that is not done', () => {
    expect(buddyOnboardingReachable(4, input())).toBe(2)
    expect(buddyOnboardingReachable(4, input({ description: 'A buddy' }))).toBe(3)
    expect(buddyOnboardingReachable(4, input({ description: 'A buddy', name: 'Grum' }))).toBe(4)
    expect(buddyOnboardingReachable(1, input())).toBe(1)
  })

  it('creates with every field, trimmed, leaving out the empty ones', () => {
    const full = input({
      description: ' A mossy golem ',
      hasPicture: true,
      name: ' Grum ',
      personality: ' Grumpy but kind. ',
      about: ' I stream on Tuesdays. '
    })
    expect(buddyOnboardingCreateParams(full, 'base64-picture')).toEqual({
      description: 'A mossy golem',
      inspirationBase64: 'base64-picture',
      name: 'Grum',
      personality: 'Grumpy but kind.',
      context: 'I stream on Tuesdays.'
    })
    expect(buddyOnboardingCreateParams({ ...full, skipDetails: true }, null)).toEqual({
      description: 'A mossy golem',
      name: 'Grum'
    })
    expect(buddyOnboardingCreateParams(input({ name: 'Grum' }), 'pic')).toEqual({
      inspirationBase64: 'pic',
      name: 'Grum'
    })
  })
})

describe('step 4 gates (plan 170 D15)', () => {
  const allowed = {
    signedIn: true,
    gate: premium,
    consented: true,
    capabilities: caps(),
    library: library()
  }

  it('lets a Premium account with consent, room and images create', () => {
    expect(buddyCreateGate(allowed)).toBeNull()
    expect(buddyOnboardingAllowanceLine(caps(20))).toBe('Uses 4 of your 20 images left today.')
    expect(buddyOnboardingAllowanceLine(null)).toBeNull()
  })

  it('checks in the order a streamer can fix them, each with its line and actions', () => {
    expect(buddyCreateGate({ ...allowed, signedIn: false, gate: free, consented: false })).toEqual({
      kind: 'signed-out',
      line: 'Sign in to create your Buddy.',
      actions: ['sign-in']
    })
    expect(buddyCreateGate({ ...allowed, gate: free, consented: false })).toEqual({
      kind: 'premium',
      line: 'Creating your own Buddy is part of Videorc Premium.',
      actions: ['see-premium', 'start-from-ours']
    })
    expect(buddyCreateGate({ ...allowed, consented: false })).toEqual({
      kind: 'cloud-ai',
      line: 'Allow cloud AI to create a Buddy.',
      actions: ['allow-cloud-ai']
    })
    expect(
      buddyCreateGate({
        ...allowed,
        capabilities: caps(0, { enabled: true, count: 30, limit: 30 })
      })
    ).toEqual({
      kind: 'full',
      line: 'Your library is full (30 Buddies). Delete one to make room.',
      actions: []
    })
    expect(buddyCreateGate({ ...allowed, capabilities: caps(24, undefined, false) })?.kind).toBe(
      'unavailable'
    )
    expect(buddyCreateGate({ ...allowed, capabilities: null })?.kind).toBe('unavailable')
    // A Buddy is four images: three left is not enough.
    expect(buddyCreateGate({ ...allowed, capabilities: caps(3) })).toEqual({
      kind: 'allowance',
      line: "You've used today's images. You get more tomorrow.",
      actions: []
    })
    expect(buddyCreateGate({ ...allowed, capabilities: caps(4) })).toBeNull()
  })

  it('says why a create made nothing, in the gate words when the web named one', () => {
    expect(buddyCreateFailureLine(null)).toBeNull()
    expect(buddyCreateFailureLine({ code: 'buddy-library-full' }, 30)).toBe(
      'Your library is full (30 Buddies). Delete one to make room.'
    )
    expect(buddyCreateFailureLine({ code: 'quota-exhausted' })).toBe(
      "You've used today's images. You get more tomorrow."
    )
    expect(buddyCreateFailureLine({ code: 'avatar-timeout' })).toBe(
      'Your Buddy could not be drawn. Nothing was used from your allowance. Try again.'
    )
  })
})
