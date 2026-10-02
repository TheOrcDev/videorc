import { describe, expect, it } from 'vitest'

import {
  CHAT_AVATAR_MAX_BYTES,
  chatAvatarBytesWithinCap,
  managedAvatarFileName
} from './chat-avatar-bytes'

const cached = 'videorc-asset://avatar/0123456789abcdef0123456789abcdef.png'

describe('managedAvatarFileName', () => {
  it('names the cache file of a managed avatar URL', () => {
    expect(managedAvatarFileName(cached)).toBe('0123456789abcdef0123456789abcdef.png')
    expect(
      managedAvatarFileName('videorc-asset://avatar/0123456789abcdef0123456789abcdef.webp')
    ).toBe('0123456789abcdef0123456789abcdef.webp')
    // Emotes from URLs without an image extension are stored as `.img`.
    expect(
      managedAvatarFileName('videorc-asset://avatar/0123456789abcdef0123456789abcdef.img')
    ).toBe('0123456789abcdef0123456789abcdef.img')
  })

  it('refuses every other host, scheme and path shape', () => {
    // Other hosts of the scheme never leak through the avatar read.
    expect(
      managedAvatarFileName('videorc-asset://background/0123456789abcdef0123456789abcdef.png')
    ).toBeNull()
    expect(managedAvatarFileName('videorc-asset://screen/takeover.png')).toBeNull()
    expect(managedAvatarFileName('https://yt3.ggpht.com/a.png')).toBeNull()
    expect(managedAvatarFileName('file:///etc/passwd')).toBeNull()
    // Traversal, separators, encoded separators and bare names.
    expect(managedAvatarFileName('videorc-asset://avatar/../prefs.json')).toBeNull()
    expect(managedAvatarFileName('videorc-asset://avatar/..%2Fprefs.json')).toBeNull()
    expect(managedAvatarFileName('videorc-asset://avatar/a/b.png')).toBeNull()
    expect(managedAvatarFileName('videorc-asset://avatar/a\\b.png')).toBeNull()
    expect(managedAvatarFileName('videorc-asset://avatar/')).toBeNull()
    expect(managedAvatarFileName('videorc-asset://avatar/notahash.png')).toBeNull()
    expect(
      managedAvatarFileName('videorc-asset://avatar/0123456789ABCDEF0123456789ABCDEF.png')
    ).toBeNull()
    expect(managedAvatarFileName(`${cached}?x=1`)).toBeNull()
    expect(managedAvatarFileName(42)).toBeNull()
    expect(managedAvatarFileName(null)).toBeNull()
    expect(managedAvatarFileName(`videorc-asset://avatar/${'a'.repeat(600)}`)).toBeNull()
  })
})

describe('chatAvatarBytesWithinCap', () => {
  it('accepts a non-empty payload up to the 2 MB cap and nothing else', () => {
    expect(chatAvatarBytesWithinCap(1)).toBe(true)
    expect(chatAvatarBytesWithinCap(CHAT_AVATAR_MAX_BYTES)).toBe(true)
    expect(chatAvatarBytesWithinCap(CHAT_AVATAR_MAX_BYTES + 1)).toBe(false)
    expect(chatAvatarBytesWithinCap(0)).toBe(false)
    expect(chatAvatarBytesWithinCap(-1)).toBe(false)
    expect(chatAvatarBytesWithinCap(Number.NaN)).toBe(false)
  })
})
