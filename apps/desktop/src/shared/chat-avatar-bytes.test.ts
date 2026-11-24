import { describe, expect, it } from 'vitest'

import {
  CHAT_AVATAR_MAX_BYTES,
  chatAvatarBytesWithinCap,
  chatImageRoute,
  chatImageRouteUrl
} from './chat-avatar-bytes'

const key = 'fedcba9876543210fedcba9876543210'
const cached = `http://127.0.0.1:4321/chat-images/0123456789abcdef0123456789abcdef.png?key=${key}`

describe('chatImageRoute', () => {
  it('names the port, file and key of a backend chat image URL', () => {
    expect(chatImageRoute(cached)).toEqual({
      port: 4321,
      fileName: '0123456789abcdef0123456789abcdef.png',
      key
    })
    // Emotes from URLs without an image extension are stored as `.img`.
    const emote = cached.replace('.png', '.img')
    expect(chatImageRoute(emote)?.fileName).toBe('0123456789abcdef0123456789abcdef.img')
    expect(chatImageRouteUrl(chatImageRoute(emote)!)).toBe(emote)
  })

  it('refuses every other host, scheme, path, name and query shape', () => {
    for (const refused of [
      cached.replace('127.0.0.1', 'localhost'),
      cached.replace('http://', 'https://'),
      cached.replace('/chat-images/', '/preview/'),
      cached.replace(':4321', ''),
      cached.replace(':4321', ':999999'),
      cached.replace(':4321', ':0'),
      cached.replace('0123456789abcdef0123456789abcdef', '0123456789ABCDEF0123456789ABCDEF'),
      cached.replace('0123456789abcdef0123456789abcdef.png', '../videorc.sqlite3'),
      cached.replace('0123456789abcdef0123456789abcdef.png', '..%2Fvideorc.sqlite3'),
      cached.replace('.png', '.svg'),
      cached.replace(`?key=${key}`, ''),
      cached.replace(key, 'short'),
      `${cached}&x=1`,
      `${cached}#x`,
      'videorc-asset://avatar/0123456789abcdef0123456789abcdef.png',
      'https://yt3.ggpht.com/a.png',
      'file:///etc/passwd',
      `${cached}${'a'.repeat(300)}`,
      42,
      null
    ]) {
      expect(chatImageRoute(refused), String(refused)).toBeNull()
    }
    expect(() => chatImageRouteUrl({ port: 4321, fileName: '../videorc.sqlite3', key })).toThrow()
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
