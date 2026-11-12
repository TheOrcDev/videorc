import { describe, expect, it } from 'vitest'

import type {
  GoLiveDestinationPreflight,
  StreamMetadataDraft,
  StreamTargetMetadataDraft,
  StreamTargetSettings
} from './backend'
import {
  ALLOW_NON_PUBLIC_HINT,
  effectiveInstantYouTubePrivacy,
  goLivePrivacyConfirmCopy,
  headlessNonPublicRefusal,
  instantYouTubePrivacyPatch,
  nonPublicPrivacyLine,
  nonPublicYouTubeDestinations,
  type NonPublicYouTubeDestination
} from './go-live-privacy'

// Owner report (2026-11-12): live on four platforms with YouTube Unlisted and
// nothing said so. Every non-public YouTube destination asks once more.

const NOW = '2026-11-12T12:00:00.000Z'

function target(
  id: string,
  platform: StreamTargetSettings['platform'],
  overrides: Partial<StreamTargetSettings> = {}
): StreamTargetSettings {
  return {
    id,
    platform,
    label: platform === 'youtube' ? 'YouTube' : platform === 'twitch' ? 'Twitch' : 'Kick',
    enabled: true,
    serverUrl: 'rtmp://127.0.0.1/live',
    streamKey: '',
    streamKeyPresent: true,
    authMode: 'oauth',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function override(patch: Partial<StreamTargetMetadataDraft> = {}): StreamTargetMetadataDraft {
  return {
    platform: 'youtube',
    customize: false,
    title: '',
    description: '',
    privacy: 'public',
    updatedAt: NOW,
    ...patch
  }
}

function draft(patch: Partial<StreamMetadataDraft> = {}): StreamMetadataDraft {
  return {
    title: 'Friday build',
    description: '',
    defaultPrivacy: 'public',
    targetOverrides: [],
    updatedAt: NOW,
    ...patch
  }
}

function row(
  targetId: string,
  patch: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  return {
    targetId,
    platform: 'youtube',
    label: 'YouTube',
    authMode: 'oauth',
    ready: true,
    title: 'Friday build',
    description: '',
    message: '',
    chatRead: 'ready',
    chatWrite: 'ready',
    chatMessage: '',
    ...patch
  }
}

describe('the privacy an instant YouTube broadcast gets', () => {
  it("is the draft's privacy, and Private with no draft (the backend's default)", () => {
    expect(effectiveInstantYouTubePrivacy(draft({ defaultPrivacy: 'unlisted' }))).toBe('unlisted')
    expect(effectiveInstantYouTubePrivacy(draft())).toBe('public')
    expect(effectiveInstantYouTubePrivacy(null)).toBe('private')
  })

  it("is YouTube's own override when it is customised, as youtube.rs reads it", () => {
    expect(
      effectiveInstantYouTubePrivacy(
        draft({ targetOverrides: [override({ customize: true, privacy: 'unlisted' })] })
      )
    ).toBe('unlisted')
    // An override that isn't customised keeps the draft's privacy.
    expect(
      effectiveInstantYouTubePrivacy(
        draft({ targetOverrides: [override({ customize: false, privacy: 'private' })] })
      )
    ).toBe('public')
  })

  it('is set where the backend reads it', () => {
    expect(instantYouTubePrivacyPatch(draft(), 'unlisted')).toEqual({ defaultPrivacy: 'unlisted' })
    expect(instantYouTubePrivacyPatch(null, 'public')).toEqual({ defaultPrivacy: 'public' })
    const twitch = override({ platform: 'twitch', customize: true, privacy: 'private' })
    const customised = draft({
      targetOverrides: [twitch, override({ customize: true, privacy: 'unlisted' })]
    })
    expect(instantYouTubePrivacyPatch(customised, 'public')).toEqual({
      targetOverrides: [twitch, override({ customize: true, privacy: 'public' })]
    })
  })
})

describe('nonPublicYouTubeDestinations', () => {
  const fourPlatforms = [
    target('youtube', 'youtube'),
    target('twitch', 'twitch'),
    target('kick', 'kick'),
    target('x', 'x', { label: 'X' })
  ]

  it('names the YouTube destination that is Unlisted among four platforms', () => {
    expect(
      nonPublicYouTubeDestinations({
        sentTargets: fourPlatforms,
        draft: draft({ defaultPrivacy: 'unlisted' })
      })
    ).toEqual([{ targetId: 'youtube', label: 'YouTube', privacy: 'unlisted', scheduled: false }])
  })

  it('is empty for Public and for a livestream with no YouTube', () => {
    expect(nonPublicYouTubeDestinations({ sentTargets: fourPlatforms, draft: draft() })).toEqual([])
    expect(
      nonPublicYouTubeDestinations({
        sentTargets: fourPlatforms.filter((entry) => entry.platform !== 'youtube'),
        draft: draft({ defaultPrivacy: 'private' })
      })
    ).toEqual([])
  })

  it('counts the Private fallback when no draft has loaded', () => {
    expect(
      nonPublicYouTubeDestinations({ sentTargets: [target('youtube', 'youtube')], draft: null })
    ).toEqual([{ targetId: 'youtube', label: 'YouTube', privacy: 'private', scheduled: false }])
  })

  it("uses the preflight row's name, and the scheduled event's own privacy", () => {
    const sentTargets = [
      target('youtube', 'youtube', { label: 'Main channel' }),
      target('youtube-event', 'youtube', {
        scheduledEventId: 'event-1',
        scheduledPrivacy: 'public'
      })
    ]
    const found = nonPublicYouTubeDestinations({
      sentTargets,
      destinations: [
        row('youtube', { label: 'Main channel' }),
        row('youtube-event', {
          label: 'Events',
          scheduled: {
            eventId: 'event-1',
            fingerprint: 'f',
            title: 'Launch',
            privacy: 'unlisted',
            startUtc: NOW
          }
        })
      ],
      // The draft is Public: only the scheduled event isn't, and the
      // preflight's word (fresh from YouTube) wins over the saved copy.
      draft: draft()
    })
    expect(found).toEqual([
      { targetId: 'youtube-event', label: 'Events', privacy: 'unlisted', scheduled: true }
    ])
  })

  it('falls back to the saved event privacy, and skips one never learned', () => {
    expect(
      nonPublicYouTubeDestinations({
        sentTargets: [
          target('a', 'youtube', { scheduledEventId: 'event-a', scheduledPrivacy: 'private' }),
          target('b', 'youtube', { scheduledEventId: 'event-b' })
        ],
        draft: draft({ defaultPrivacy: 'unlisted' })
      })
    ).toEqual([{ targetId: 'a', label: 'YouTube', privacy: 'private', scheduled: true }])
  })
})

describe('the privacy step words', () => {
  const youtube = (
    privacy: NonPublicYouTubeDestination['privacy'],
    patch: Partial<NonPublicYouTubeDestination> = {}
  ): NonPublicYouTubeDestination => ({
    targetId: 'youtube',
    label: 'YouTube',
    privacy,
    scheduled: false,
    ...patch
  })

  it("says the owner's sentence for Unlisted", () => {
    expect(goLivePrivacyConfirmCopy([youtube('unlisted')])).toEqual({
      title: 'Go live unlisted?',
      description: 'YouTube is Unlisted. Only people with the link can watch.',
      confirmLabel: 'Go live unlisted',
      cancelLabel: 'Change privacy'
    })
  })

  it('says Private the same way', () => {
    expect(goLivePrivacyConfirmCopy([youtube('private')])).toEqual({
      title: 'Go live private?',
      description: 'YouTube is Private. Only you can watch.',
      confirmLabel: 'Go live private',
      cancelLabel: 'Change privacy'
    })
  })

  it('names each destination, grouped by privacy, with "Go live anyway" for a mix', () => {
    const copy = goLivePrivacyConfirmCopy([
      youtube('unlisted'),
      youtube('unlisted', { targetId: 'v', label: 'YouTube Vertical' }),
      youtube('private', { targetId: 'e', label: 'Events', scheduled: true })
    ])
    expect(copy.description).toBe(
      'YouTube and YouTube Vertical are Unlisted. Only people with the link can watch. The scheduled event on Events (YouTube) is Private. Only you can watch.'
    )
    expect(copy.title).toBe('Go live unlisted and private?')
    expect(copy.confirmLabel).toBe('Go live anyway')
    expect(copy.cancelLabel).toBe('Change privacy')
  })

  it('goes back, not to a Privacy field, when only scheduled events are not public', () => {
    expect(goLivePrivacyConfirmCopy([youtube('unlisted', { scheduled: true })]).cancelLabel).toBe(
      'Go back'
    )
  })

  it("gives a row its privacy and an agent the step's sentence with the way ahead", () => {
    expect(nonPublicPrivacyLine('unlisted')).toBe('Unlisted. Only people with the link can watch.')
    expect(headlessNonPublicRefusal([youtube('unlisted')])).toBe(
      `YouTube is Unlisted. Only people with the link can watch. ${ALLOW_NON_PUBLIC_HINT}`
    )
  })
})
