import { describe, expect, it } from 'vitest'

import type { AiCapabilities, GolemLibraryEntry, GolemLibraryState } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

import {
  EMPTY_GOLEM_ONBOARDING_INPUT,
  GOLEM_INVITATION_STORAGE_KEY,
  golemCreateFailureLine,
  golemCreateGate,
  golemInvitationVisible,
  golemLibraryIsFull,
  golemLibraryView,
  golemOnboardingAllowanceLine,
  golemOnboardingCanAdvance,
  golemOnboardingCanSkip,
  golemOnboardingCreateParams,
  golemOnboardingReachable,
  readGolemInvitationDismissed,
  writeGolemInvitationDismissed,
  type GolemOnboardingInput
} from './golem-library-view'
import { GOLEM_OFFICIAL_CATALOG } from '../../../shared/golem-library'

const MINE = '7c9e6679-7425-40de-944b-e07fc1ee9a51'
const OLDER = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

function entry(id: string, name: string): GolemLibraryEntry {
  return {
    id,
    name,
    description: `${name} as asked`,
    personality: '',
    context: '',
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    poses: {
      idle: `videorc-asset://golem/library/${id}/idle-0a1b2c3d.png`,
      talk: null,
      laugh: null,
      think: null
    }
  }
}

function library(patch: Partial<GolemLibraryState> = {}): GolemLibraryState {
  return {
    signedIn: true,
    official: GOLEM_OFFICIAL_CATALOG.map(({ description: _description, ...rest }) => rest),
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
  golemLibrary?: { enabled: boolean; count: number; limit: number },
  enabled = true
): Pick<AiCapabilities, 'cohost'> {
  return {
    cohost: { avatar: { enabled, remainingToday, dailyLimit: 24 }, golemLibrary }
  } as Pick<AiCapabilities, 'cohost'>
}

describe('golemLibraryView (plan 170 D16)', () => {
  it('groups the official five and mine, newest first, with the active one marked', () => {
    const view = golemLibraryView({ library: library(), persona: null })
    expect(view.official.map((card) => card.name)).toEqual([
      'Golem',
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
    expect(view.mine?.[0]?.idleUrl).toBe(`videorc-asset://golem/library/${MINE}/idle-0a1b2c3d.png`)
  })

  it('shows the catalog and the persona link before the backend answers', () => {
    const view = golemLibraryView({
      library: null,
      persona: { source: 'default' }
    })
    expect(view.official).toHaveLength(5)
    expect(view.official[0]).toMatchObject({ id: 'official:golem', active: true })
    expect(view.mine).toBeNull()
    expect(view.signedIn).toBe(false)
  })

  it('hides mine when signed out and keeps official usable', () => {
    const view = golemLibraryView({
      library: library({ signedIn: false, mine: null, activeAvatarId: 'official:orc' }),
      persona: null
    })
    expect(view.mine).toBeNull()
    expect(view.official.find((card) => card.active)?.name).toBe('Golmar')
  })

  it('names the Golem picked on videorc.com when sync would not apply it', () => {
    expect(
      golemLibraryView({
        library: library({ activeAvatarId: null, serverActiveAvatarId: OLDER }),
        persona: null
      }).pickedElsewhere
    ).toEqual({ id: OLDER, name: 'Pebble' })
    expect(
      golemLibraryView({
        library: library({ activeAvatarId: null, serverActiveAvatarId: 'official:pirate' }),
        persona: null
      }).pickedElsewhere
    ).toEqual({ id: 'official:pirate', name: 'Captain Barnacle' })
    // An id this app cannot name yet says nothing rather than a blank name.
    expect(
      golemLibraryView({
        library: library({ serverActiveAvatarId: '11111111-2222-4333-8444-555555555555' }),
        persona: null
      }).pickedElsewhere
    ).toBeNull()
  })

  it('marks the card a job acts on, and a sync as syncing', () => {
    const using = golemLibraryView({
      library: library({ busy: { kind: 'use', avatarId: 'official:robot' } }),
      persona: null
    })
    expect(using.busy).toBe(true)
    expect(using.syncing).toBe(false)
    expect(using.official.find((card) => card.busy)?.name).toBe('Bolt')
    const syncing = golemLibraryView({
      library: library({ busy: { kind: 'sync' } }),
      persona: null
    })
    expect(syncing.syncing).toBe(true)
    expect(
      golemLibraryView({
        library: library({ error: { code: 'network', message: 'Could not reach Videorc.' } }),
        persona: null
      }).error
    ).toBe('Could not reach Videorc.')
  })

  it('is full at the limit, by the web count first', () => {
    expect(golemLibraryIsFull(caps(24, { enabled: true, count: 30, limit: 30 }), null)).toBe(true)
    expect(golemLibraryIsFull(caps(24, { enabled: true, count: 3, limit: 30 }), library())).toBe(
      false
    )
    expect(golemLibraryIsFull(null, library({ limit: 2 }))).toBe(true)
  })
})

describe('the first-launch invitation (plan 170 D16)', () => {
  it('shows only for the untouched default Golem, until dismissed', () => {
    const base = { library: { activeAvatarId: 'official:golem' }, dismissed: false }
    expect(golemInvitationVisible({ ...base, persona: { source: 'default' } })).toBe(true)
    expect(
      golemInvitationVisible({ ...base, dismissed: true, persona: { source: 'default' } })
    ).toBe(false)
    // Picked on purpose: linked, so not untouched.
    expect(
      golemInvitationVisible({
        ...base,
        persona: { source: 'default', libraryAvatarId: 'official:golem' }
      })
    ).toBe(false)
    expect(golemInvitationVisible({ ...base, persona: { source: 'generated' } })).toBe(false)
    expect(
      golemInvitationVisible({
        library: { activeAvatarId: 'official:orc' },
        persona: { source: 'default' },
        dismissed: false
      })
    ).toBe(false)
    expect(golemInvitationVisible({ ...base, library: null, persona: { source: 'default' } })).toBe(
      false
    )
  })

  it('remembers the dismissal per machine, and survives broken storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
    expect(readGolemInvitationDismissed(storage)).toBe(false)
    writeGolemInvitationDismissed(storage)
    expect(store.get(GOLEM_INVITATION_STORAGE_KEY)).toBe('1')
    expect(readGolemInvitationDismissed(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(readGolemInvitationDismissed(broken)).toBe(false)
    expect(() => writeGolemInvitationDismissed(broken)).not.toThrow()
  })
})

describe('the onboarding steps (plan 170 D14)', () => {
  const input = (patch: Partial<GolemOnboardingInput> = {}): GolemOnboardingInput => ({
    ...EMPTY_GOLEM_ONBOARDING_INPUT,
    ...patch
  })

  it('advances step 2 with a description or a picture, within 600 characters', () => {
    expect(golemOnboardingCanAdvance(1, input())).toBe(true)
    expect(golemOnboardingCanAdvance(2, input())).toBe(false)
    expect(golemOnboardingCanAdvance(2, input({ description: '   ' }))).toBe(false)
    expect(golemOnboardingCanAdvance(2, input({ description: 'A mossy golem' }))).toBe(true)
    expect(golemOnboardingCanAdvance(2, input({ hasPicture: true }))).toBe(true)
    expect(golemOnboardingCanAdvance(2, input({ description: 'x'.repeat(601) }))).toBe(false)
  })

  it('advances step 3 with a 1 to 24 character name and bounded optional fields', () => {
    expect(golemOnboardingCanAdvance(3, input())).toBe(false)
    expect(golemOnboardingCanAdvance(3, input({ name: '  ' }))).toBe(false)
    expect(golemOnboardingCanAdvance(3, input({ name: 'Grum' }))).toBe(true)
    expect(golemOnboardingCanAdvance(3, input({ name: 'x'.repeat(24) }))).toBe(true)
    expect(golemOnboardingCanAdvance(3, input({ name: 'x'.repeat(25) }))).toBe(false)
    // An emoji is one character.
    expect(golemOnboardingCanAdvance(3, input({ name: '🪨'.repeat(24) }))).toBe(true)
    expect(
      golemOnboardingCanAdvance(3, input({ name: 'Grum', personality: 'x'.repeat(1201) }))
    ).toBe(false)
    expect(golemOnboardingCanAdvance(3, input({ name: 'Grum', about: 'x'.repeat(4001) }))).toBe(
      false
    )
    expect(golemOnboardingCanAdvance(4, input({ name: 'Grum' }))).toBe(false)
  })

  it('offers Skip for now on step 3 once the name is filled', () => {
    expect(golemOnboardingCanSkip(3, input())).toBe(false)
    expect(golemOnboardingCanSkip(3, input({ name: 'Grum' }))).toBe(true)
    expect(golemOnboardingCanSkip(2, input({ name: 'Grum' }))).toBe(false)
  })

  it('never lands past a step that is not done', () => {
    expect(golemOnboardingReachable(4, input())).toBe(2)
    expect(golemOnboardingReachable(4, input({ description: 'A golem' }))).toBe(3)
    expect(golemOnboardingReachable(4, input({ description: 'A golem', name: 'Grum' }))).toBe(4)
    expect(golemOnboardingReachable(1, input())).toBe(1)
  })

  it('creates with every field, trimmed, leaving out the empty ones', () => {
    const full = input({
      description: ' A mossy golem ',
      hasPicture: true,
      name: ' Grum ',
      personality: ' Grumpy but kind. ',
      about: ' I stream on Tuesdays. '
    })
    expect(golemOnboardingCreateParams(full, 'base64-picture')).toEqual({
      description: 'A mossy golem',
      inspirationBase64: 'base64-picture',
      name: 'Grum',
      personality: 'Grumpy but kind.',
      context: 'I stream on Tuesdays.'
    })
    expect(golemOnboardingCreateParams({ ...full, skipDetails: true }, null)).toEqual({
      description: 'A mossy golem',
      name: 'Grum'
    })
    expect(golemOnboardingCreateParams(input({ name: 'Grum' }), 'pic')).toEqual({
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
    expect(golemCreateGate(allowed)).toBeNull()
    expect(golemOnboardingAllowanceLine(caps(20))).toBe('Uses 4 of your 20 images left today.')
    expect(golemOnboardingAllowanceLine(null)).toBeNull()
  })

  it('checks in the order a streamer can fix them, each with its line and actions', () => {
    expect(golemCreateGate({ ...allowed, signedIn: false, gate: free, consented: false })).toEqual({
      kind: 'signed-out',
      line: 'Sign in to create your Golem.',
      actions: ['sign-in']
    })
    expect(golemCreateGate({ ...allowed, gate: free, consented: false })).toEqual({
      kind: 'premium',
      line: 'Creating your own Golem is part of Videorc Premium.',
      actions: ['see-premium', 'start-from-ours']
    })
    expect(golemCreateGate({ ...allowed, consented: false })).toEqual({
      kind: 'cloud-ai',
      line: 'Allow cloud AI to create a Golem.',
      actions: ['allow-cloud-ai']
    })
    expect(
      golemCreateGate({
        ...allowed,
        capabilities: caps(0, { enabled: true, count: 30, limit: 30 })
      })
    ).toEqual({
      kind: 'full',
      line: 'Your library is full (30 Golems). Delete one to make room.',
      actions: []
    })
    expect(golemCreateGate({ ...allowed, capabilities: caps(24, undefined, false) })?.kind).toBe(
      'unavailable'
    )
    expect(golemCreateGate({ ...allowed, capabilities: null })?.kind).toBe('unavailable')
    // A Golem is four images: three left is not enough.
    expect(golemCreateGate({ ...allowed, capabilities: caps(3) })).toEqual({
      kind: 'allowance',
      line: "You've used today's images. You get more tomorrow.",
      actions: []
    })
    expect(golemCreateGate({ ...allowed, capabilities: caps(4) })).toBeNull()
  })

  it('says why a create made nothing, in the gate words when the web named one', () => {
    expect(golemCreateFailureLine(null)).toBeNull()
    expect(golemCreateFailureLine({ code: 'golem-library-full' }, 30)).toBe(
      'Your library is full (30 Golems). Delete one to make room.'
    )
    expect(golemCreateFailureLine({ code: 'quota-exhausted' })).toBe(
      "You've used today's images. You get more tomorrow."
    )
    expect(golemCreateFailureLine({ code: 'avatar-timeout' })).toBe(
      'Your Golem could not be drawn. Nothing was used from your allowance. Try again.'
    )
  })
})
