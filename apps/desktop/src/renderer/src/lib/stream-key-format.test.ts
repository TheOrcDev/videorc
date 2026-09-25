import { describe, expect, it } from 'vitest'

import {
  detectStreamKeyPlatform,
  streamKeyPlatformMismatch,
  streamKeyTailHint
} from './stream-key-format'

describe('stream-key-format', () => {
  it('detects twitch-shaped keys', () => {
    expect(detectStreamKeyPlatform('live_123456789_AbCdEfGhIjKlMnOp')).toBe('twitch')
    expect(detectStreamKeyPlatform('  live_42_xyz  ')).toBe('twitch')
  })

  it('detects youtube-shaped keys', () => {
    expect(detectStreamKeyPlatform('abcd-efgh-ijkl-mnop')).toBe('youtube')
    expect(detectStreamKeyPlatform('a1b2-c3d4-e5f6-g7h8-i9j0')).toBe('youtube')
  })

  it('detects kick-shaped keys', () => {
    expect(
      detectStreamKeyPlatform('sk_us-west-2_AbC123dEf456_GhIjKlMnOpQrStUvWxYz0123456789')
    ).toBe('kick')
    expect(streamKeyPlatformMismatch('twitch', 'sk_us-west-2_abc_def')).toMatch(
      /looks like a Kick stream key, but you are saving it to Twitch/
    )
    expect(streamKeyPlatformMismatch('kick', 'sk_us-west-2_abc_def')).toBeNull()
  })

  it('stays quiet on ambiguous keys', () => {
    expect(detectStreamKeyPlatform('some-arbitrary-rtmp-key')).toBeNull()
    expect(detectStreamKeyPlatform('sk_live_stripe_looking')).toBeNull()
    expect(detectStreamKeyPlatform('')).toBeNull()
  })

  it('warns when a twitch key lands in the youtube field', () => {
    const warning = streamKeyPlatformMismatch('youtube', 'live_123456789_AbCdEf')
    expect(warning).toMatch(/looks like a Twitch stream key/)
    expect(warning).toMatch(/saving it to YouTube/)
  })

  it('warns when a youtube key lands in the twitch field', () => {
    expect(streamKeyPlatformMismatch('twitch', 'abcd-efgh-ijkl-mnop')).toMatch(
      /looks like a YouTube stream key/
    )
  })

  it('does not warn for matching or undetected formats', () => {
    expect(streamKeyPlatformMismatch('twitch', 'live_123_abc')).toBeNull()
    expect(streamKeyPlatformMismatch('youtube', 'totally-custom-key-shape-123')).toBeNull()
    expect(streamKeyPlatformMismatch('custom', 'live_123_abc')).toMatch(/Twitch/)
  })

  it('masks all but the key tail', () => {
    expect(streamKeyTailHint('live_123456789_AbCdWXYZ')).toBe('••••WXYZ')
    expect(streamKeyTailHint('tiny')).toBe('••••')
  })
})
