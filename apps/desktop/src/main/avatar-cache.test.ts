import { describe, expect, it } from 'vitest'

import {
  AVATAR_MAX_BYTES,
  avatarCacheFileName,
  avatarCacheRejectionKey,
  avatarCacheRejectionMessage,
  avatarHostAllowed,
  avatarUrlDecision,
  httpStatusClass,
  redactAvatarFetchError,
  type AvatarCacheRejection
} from './avatar-cache'

describe('avatarHostAllowed', () => {
  it('allows the platform CDNs over https only', () => {
    expect(avatarHostAllowed('https://yt3.ggpht.com/abc/photo=s64')).toBe(true)
    expect(avatarHostAllowed('https://lh3.googleusercontent.com/a/user=s96')).toBe(true)
    expect(avatarHostAllowed('https://static-cdn.jtvnw.net/jtv_user_pictures/x.png')).toBe(true)
    expect(avatarHostAllowed('http://yt3.ggpht.com/abc')).toBe(false)
  })

  it('allows every Vercel Blob store the web may upload account avatars to', () => {
    // Parity with the web's isAccountAvatarBlobUrl: bare host or any subdomain.
    expect(avatarHostAllowed('https://blob.vercel-storage.com/avatars/u.png')).toBe(true)
    expect(avatarHostAllowed('https://abc123.public.blob.vercel-storage.com/avatars/u.png')).toBe(
      true
    )
    expect(avatarHostAllowed('https://abc123.blob.vercel-storage.com/avatars/u.png')).toBe(true)
    expect(avatarHostAllowed('http://abc123.public.blob.vercel-storage.com/avatars/u.png')).toBe(
      false
    )
    expect(avatarHostAllowed('https://blob.vercel-storage.com.attacker.dev/u.png')).toBe(false)
    expect(avatarHostAllowed('https://notblob.vercel-storage.com/u.png')).toBe(false)
  })

  it('rejects lookalike hosts, other origins, and garbage', () => {
    expect(avatarHostAllowed('https://evil-yt3.ggpht.com.attacker.dev/x.png')).toBe(false)
    expect(avatarHostAllowed('https://notgoogleusercontent.com/x.png')).toBe(false)
    expect(avatarHostAllowed('https://example.com/avatar.png')).toBe(false)
    expect(avatarHostAllowed('file:///etc/passwd')).toBe(false)
    expect(avatarHostAllowed('not a url')).toBe(false)
  })
})

describe('avatarUrlDecision', () => {
  it('names the host for an allowed URL', () => {
    expect(avatarUrlDecision('https://LH3.googleusercontent.com/a/user=s96')).toEqual({
      allowed: true,
      host: 'lh3.googleusercontent.com'
    })
  })

  it('explains each rejection with host and scheme only', () => {
    expect(avatarUrlDecision(42)).toEqual({
      allowed: false,
      rejection: { kind: 'not-a-url' }
    })
    expect(avatarUrlDecision('not a url')).toEqual({
      allowed: false,
      rejection: { kind: 'not-a-url' }
    })
    expect(avatarUrlDecision('http://yt3.ggpht.com/abc?token=secret')).toEqual({
      allowed: false,
      rejection: { kind: 'scheme', scheme: 'http', host: 'yt3.ggpht.com' }
    })
    expect(avatarUrlDecision('https://cdn.example.com/u.png?sig=secret')).toEqual({
      allowed: false,
      rejection: { kind: 'host', scheme: 'https', host: 'cdn.example.com' }
    })
  })
})

describe('avatar cache rejection diagnostics', () => {
  const rejections: AvatarCacheRejection[] = [
    { kind: 'not-a-url' },
    { kind: 'scheme', scheme: 'http', host: 'yt3.ggpht.com' },
    { kind: 'host', scheme: 'https', host: 'cdn.example.com' },
    { kind: 'http-status', host: 'static-cdn.jtvnw.net', statusClass: '4xx' },
    { kind: 'empty-body', host: 'yt3.ggpht.com' },
    { kind: 'too-large', host: 'lh3.googleusercontent.com', bytes: AVATAR_MAX_BYTES + 1 },
    { kind: 'fetch-error', host: 'yt3.ggpht.com', message: 'net::ERR_NAME_NOT_RESOLVED' }
  ]

  it('writes one readable line per rejection, never a path or query', () => {
    for (const rejection of rejections) {
      const message = avatarCacheRejectionMessage(rejection)
      expect(message.startsWith('Chat avatar not cached:')).toBe(true)
      expect(message).not.toMatch(/[?&]\w+=|\/\w+\.(png|jpg)/)
      if ('host' in rejection) {
        expect(message).toContain(rejection.host)
      }
    }
    expect(
      avatarCacheRejectionMessage({ kind: 'http-status', host: 'h.example', statusClass: '5xx' })
    ).toBe('Chat avatar not cached: h.example answered 5xx.')
    expect(
      avatarCacheRejectionMessage({ kind: 'too-large', host: 'h.example', bytes: 3_000_000 })
    ).toBe(`Chat avatar not cached: h.example returned 3000000 bytes (cap ${AVATAR_MAX_BYTES}).`)
  })

  it('dedupes by host and reason so a busy chat logs each cause once', () => {
    const keys = rejections.map(avatarCacheRejectionKey)
    expect(new Set(keys).size).toBe(rejections.length)
    expect(avatarCacheRejectionKey({ kind: 'too-large', host: 'h.example', bytes: 1 })).toBe(
      avatarCacheRejectionKey({ kind: 'too-large', host: 'h.example', bytes: 2 })
    )
    expect(avatarCacheRejectionKey({ kind: 'fetch-error', host: 'h.example', message: 'a' })).toBe(
      avatarCacheRejectionKey({ kind: 'fetch-error', host: 'h.example', message: 'b' })
    )
    expect(
      avatarCacheRejectionKey({ kind: 'http-status', host: 'h.example', statusClass: '4xx' })
    ).not.toBe(
      avatarCacheRejectionKey({ kind: 'http-status', host: 'h.example', statusClass: '5xx' })
    )
  })

  it('classifies HTTP statuses without leaking the exact code', () => {
    expect(httpStatusClass(200)).toBe('2xx')
    expect(httpStatusClass(403)).toBe('4xx')
    expect(httpStatusClass(503)).toBe('5xx')
    expect(httpStatusClass(Number.NaN)).toBe('unknown')
    expect(httpStatusClass(0)).toBe('unknown')
  })

  it('redacts URL-shaped text from fetch errors and bounds the length', () => {
    expect(
      redactAvatarFetchError(
        new Error('request to https://yt3.ggpht.com/abc?token=secret failed, reason: ECONNRESET')
      )
    ).toBe('request to <url> failed, reason: ECONNRESET')
    expect(redactAvatarFetchError('net::ERR_NAME_NOT_RESOLVED')).toBe('net::ERR_NAME_NOT_RESOLVED')
    expect(redactAvatarFetchError(new Error('x'.repeat(500)))).toHaveLength(160)
  })
})

describe('avatarCacheFileName', () => {
  it('is deterministic and keeps a safe extension from the URL path', () => {
    const first = avatarCacheFileName('https://static-cdn.jtvnw.net/pic/user.png')
    expect(first).toBe(avatarCacheFileName('https://static-cdn.jtvnw.net/pic/user.png'))
    expect(first).toMatch(/^[0-9a-f]{32}\.png$/)
    expect(avatarCacheFileName('https://yt3.ggpht.com/abc=s64')).toMatch(/^[0-9a-f]{32}\.img$/)
  })

  it('never leaks path characters into the file name', () => {
    expect(avatarCacheFileName('https://yt3.ggpht.com/../../../etc/passwd')).toMatch(
      /^[0-9a-f]{32}\.img$/
    )
  })
})
