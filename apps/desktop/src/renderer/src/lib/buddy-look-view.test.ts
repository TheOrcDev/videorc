import { describe, expect, it, vi } from 'vitest'

import type { AiCapabilities, CohostAvatarDraft } from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  BUDDY_LOOK_PICTURE_SIZE_ERROR,
  BUDDY_LOOK_PICTURE_TOO_LARGE,
  BUDDY_LOOK_PICTURE_TYPE_ERROR,
  BUDDY_LOOK_SEND_MAX_BYTES,
  buddyLookAvailability,
  buddyLookDraftImages,
  buddyLookFit,
  prepareBuddyLookPicture,
  type BuddyLookPictureDeps
} from './buddy-look-view'
import {
  BUDDY_GENERATE_CONSENT_OFF,
  BUDDY_GENERATE_NOT_AVAILABLE,
  BUDDY_GENERATE_QUOTA,
  BUDDY_GENERATE_SIGNED_OUT
} from './buddy-persona-view'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Buddy requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}
const left = (remainingToday: number): AiCapabilities =>
  ({
    cohost: { tick: 4, avatar: { enabled: true, remainingToday, dailyLimit: 24 } }
  }) as unknown as AiCapabilities

describe('buddyLookAvailability (plan 169 D13)', () => {
  const on = { signedIn: true, gate: premium, consented: true, capabilities: left(24) }

  it('names the one reason Create is off, in the order a streamer fixes them', () => {
    expect(buddyLookAvailability(on)).toEqual({
      allowed: true,
      redoAllowed: true,
      reason: null,
      remaining: 24
    })
    expect(buddyLookAvailability({ ...on, signedIn: false }).reason).toBe(BUDDY_GENERATE_SIGNED_OUT)
    expect(buddyLookAvailability({ ...on, gate: basic }).reason).toBe(basic.reason)
    expect(buddyLookAvailability({ ...on, consented: false }).reason).toBe(
      BUDDY_GENERATE_CONSENT_OFF
    )
    expect(buddyLookAvailability({ ...on, capabilities: null }).reason).toBe(
      BUDDY_GENERATE_NOT_AVAILABLE
    )
    expect(
      buddyLookAvailability({
        ...on,
        capabilities: {
          cohost: { avatar: { enabled: false, remainingToday: 24, dailyLimit: 24 } }
        } as AiCapabilities
      }).reason
    ).toBe(BUDDY_GENERATE_NOT_AVAILABLE)
    expect(buddyLookAvailability({ ...on, capabilities: left(0) }).reason).toBe(
      BUDDY_GENERATE_QUOTA
    )
  })

  it('needs four images for a new look and one for a redo', () => {
    const three = buddyLookAvailability({ ...on, capabilities: left(3) })
    expect(three).toEqual({
      allowed: false,
      redoAllowed: true,
      reason: 'A new look uses 4 images; 3 images left today.',
      remaining: 3
    })
    expect(buddyLookAvailability({ ...on, capabilities: left(1) }).reason).toBe(
      'A new look uses 4 images; 1 image left today.'
    )
    expect(buddyLookAvailability({ ...on, capabilities: left(0) }).redoAllowed).toBe(false)
    expect(buddyLookAvailability({ ...on, capabilities: left(4) }).allowed).toBe(true)
  })
})

describe('buddyLookDraftImages', () => {
  const draft: CohostAvatarDraft = {
    requestId: '3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8',
    images: {
      idle: 'p/drafts/3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8/idle.png',
      talk: 'p/drafts/3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8/talk.png'
    },
    failed: {}
  }

  it('versions the paths once a pose was redone, so it loads fresh', () => {
    expect(buddyLookDraftImages(draft, 0)).toEqual(draft.images)
    expect(buddyLookDraftImages(draft, 2).talk).toBe(`${draft.images.talk}?v=2`)
  })
})

/** A fake decode/draw/encode: sizes from `encodedBytes(type, quality, width)`. */
function fakeDeps(
  source: { width: number; height: number; transparent: boolean },
  encodedBytes: (type: string, quality: number | undefined, width: number) => number
) {
  const draws: { width: number; height: number }[] = []
  const encodes: { type: string; quality?: number; width: number }[] = []
  const closed = vi.fn()
  const deps: BuddyLookPictureDeps = {
    decode: vi.fn(async () => ({
      width: source.width,
      height: source.height,
      source: 'bitmap',
      close: closed
    })),
    draw: vi.fn(async (_image: unknown, width: number, height: number) => {
      draws.push({ width, height })
      return {
        transparent: source.transparent,
        encode: async (type: string, quality?: number) => {
          encodes.push({ type, quality, width })
          return new Blob([new Uint8Array(encodedBytes(type, quality, width))], { type })
        }
      }
    }),
    toBase64: vi.fn(async (blob: Blob) => `base64:${blob.type}:${blob.size}`)
  }
  return { deps, draws, encodes, closed }
}

const file = (type: string, size = 1000): File =>
  new File([new Uint8Array(size)], 'pet.png', { type })

describe('prepareBuddyLookPicture (plan 169 D13, Phase A request cap)', () => {
  it('fits a photo within 1024 px and sends an opaque one as a JPEG', async () => {
    const { deps, draws, encodes, closed } = fakeDeps(
      { width: 3000, height: 2000, transparent: false },
      () => 900_000
    )
    const picture = await prepareBuddyLookPicture(file('image/jpeg'), deps)
    expect(draws).toEqual([{ width: 1024, height: 683 }])
    expect(encodes).toEqual([{ type: 'image/jpeg', quality: 0.9, width: 1024 }])
    expect(picture).toEqual({
      base64: 'base64:image/jpeg:900000',
      type: 'image/jpeg',
      width: 1024,
      height: 683,
      bytes: 900_000
    })
    expect(closed).toHaveBeenCalled()
  })

  it('keeps a transparent picture as a PNG when it stays under 3 MB', async () => {
    const { deps, encodes } = fakeDeps(
      { width: 800, height: 1200, transparent: true },
      () => 2_000_000
    )
    const picture = await prepareBuddyLookPicture(file('image/png'), deps)
    expect(picture.type).toBe('image/png')
    expect({ width: picture.width, height: picture.height }).toEqual({ width: 683, height: 1024 })
    expect(encodes).toEqual([{ type: 'image/png', quality: undefined, width: 683 }])
  })

  it('turns a transparent PNG over 3 MB into WebP, stepping the quality down', async () => {
    const { deps, encodes } = fakeDeps(
      { width: 2048, height: 2048, transparent: true },
      (type, quality) =>
        type === 'image/png' ? 5_000_000 : quality === 0.9 ? 3_500_000 : 2_500_000
    )
    const picture = await prepareBuddyLookPicture(file('image/png'), deps)
    expect(picture.type).toBe('image/webp')
    expect(encodes.map((step) => [step.type, step.quality])).toEqual([
      ['image/png', undefined],
      ['image/webp', 0.9],
      ['image/webp', 0.8]
    ])
  })

  it('makes it smaller when no quality fits, and never upscales', async () => {
    const { deps, draws } = fakeDeps(
      { width: 4000, height: 3000, transparent: false },
      (_t, _q, width) => (width > 900 ? BUDDY_LOOK_SEND_MAX_BYTES + 1 : 1_000_000)
    )
    const picture = await prepareBuddyLookPicture(file('image/webp'), deps)
    expect(draws.map((draw) => draw.width)).toEqual([1024, 819])
    expect(picture.width).toBe(819)
    expect(buddyLookFit(300, 200, 1024)).toEqual({ width: 300, height: 200 })
  })

  it('refuses with a plain line only when nothing fits, and checks the file first', async () => {
    const { deps } = fakeDeps({ width: 4000, height: 4000, transparent: false }, () => 9_000_000)
    await expect(prepareBuddyLookPicture(file('image/jpeg'), deps)).rejects.toThrow(
      BUDDY_LOOK_PICTURE_TOO_LARGE
    )
    await expect(prepareBuddyLookPicture(file('image/gif'), deps)).rejects.toThrow(
      BUDDY_LOOK_PICTURE_TYPE_ERROR
    )
    await expect(
      prepareBuddyLookPicture(file('image/png', 10 * 1024 * 1024 + 1), deps)
    ).rejects.toThrow(BUDDY_LOOK_PICTURE_SIZE_ERROR)
  })
})
