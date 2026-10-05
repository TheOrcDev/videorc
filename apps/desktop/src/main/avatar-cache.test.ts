import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHAT_GIF_MAX_BYTES } from '../shared/chat-gif'
import {
  AvatarFetchTimeoutError,
  AVATAR_CACHE_MAX_BYTES,
  AVATAR_CACHE_MAX_FILES,
  AVATAR_MAX_BYTES,
  AVATAR_PRUNE_MIN_INTERVAL_MS,
  avatarCacheFileName,
  avatarCacheRejectionKey,
  avatarCacheRejectionMessage,
  avatarHostAllowed,
  avatarPruneDelayMs,
  avatarPrunePlan,
  avatarUrlDecision,
  chatGifUrlDecision,
  httpStatusClass,
  redactAvatarFetchError,
  withAvatarFetchDeadline,
  type AvatarCacheRejection
} from './avatar-cache'

afterEach(() => vi.useRealTimers())

describe('withAvatarFetchDeadline', () => {
  it('settles at the deadline and aborts a fetch that never replies', async () => {
    vi.useFakeTimers()
    let fetchSignal: AbortSignal | undefined
    const pending = withAvatarFetchDeadline((signal) => {
      fetchSignal = signal
      return new Promise<string>(() => undefined)
    }, 50)
    let settled = false
    void pending
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(49)
    expect(settled).toBe(false)
    expect(fetchSignal?.aborted).toBe(false)

    const rejection = expect(pending).rejects.toBeInstanceOf(AvatarFetchTimeoutError)
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(fetchSignal?.aborted).toBe(true)
    expect(settled).toBe(true)
  })
})

describe('avatarHostAllowed', () => {
  it('allows the platform CDNs over https only', () => {
    expect(avatarHostAllowed('https://yt3.ggpht.com/abc/photo=s64')).toBe(true)
    expect(avatarHostAllowed('https://lh3.googleusercontent.com/a/user=s96')).toBe(true)
    expect(avatarHostAllowed('https://static-cdn.jtvnw.net/jtv_user_pictures/x.png')).toBe(true)
    expect(avatarHostAllowed('https://pbs.twimg.com/profile_images/1/a_normal.jpg')).toBe(true)
    expect(avatarHostAllowed('https://pbs.twimg.com.evil.example/a.jpg')).toBe(false)
    expect(avatarHostAllowed('https://files.kick.com/images/user/1/profile_image/a.webp')).toBe(
      true
    )
    expect(avatarHostAllowed('https://notkick.com/a.webp')).toBe(false)
    // Stream Manager emotes (plan 055, S10): Twitch's own emote CDN.
    expect(avatarHostAllowed('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0')).toBe(
      true
    )
    // 7TV emotes (plan 089): its CDN host exactly, never a lookalike.
    expect(avatarHostAllowed('https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp')).toBe(
      true
    )
    expect(avatarHostAllowed('https://cdn.7tv.app.evil.example/emote/x/2x.webp')).toBe(false)
    expect(avatarHostAllowed('https://7tv.app/emote/x/2x.webp')).toBe(false)
    expect(avatarHostAllowed('http://cdn.7tv.app/emote/x/2x.webp')).toBe(false)
    // Other third-party emote CDNs are refused like any other host.
    expect(avatarHostAllowed('https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/1x')).toBe(
      false
    )
    // Kick chat emotes (plan 085) come from Kick's own file host.
    expect(avatarHostAllowed('https://files.kick.com/emotes/1579033/fullsize')).toBe(true)
    expect(avatarHostAllowed('http://yt3.ggpht.com/abc')).toBe(false)
  })

  it("allows X's default avatars, which live on abs.twimg.com (plan 095)", () => {
    expect(
      avatarHostAllowed('https://abs.twimg.com/sticky/default_profile_images/default_profile.png')
    ).toBe(true)
    expect(avatarHostAllowed('https://abs.twimg.com.evil.example/a.png')).toBe(false)
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
    expect(avatarHostAllowed('https://www.videorc.com/api/account/avatar/u1/a.png')).toBe(true)
    expect(avatarHostAllowed('https://videorc.com/api/account/avatar/u1/a.png')).toBe(true)
    expect(avatarHostAllowed('https://videorc.com.attacker.dev/u.png')).toBe(false)
    expect(avatarHostAllowed('https://notvideorc.com/u.png')).toBe(false)
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
    {
      kind: 'too-large',
      host: 'lh3.googleusercontent.com',
      bytes: AVATAR_MAX_BYTES + 1,
      cap: AVATAR_MAX_BYTES
    },
    { kind: 'not-an-image', host: 'media2.giphy.com' },
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
      avatarCacheRejectionMessage({
        kind: 'too-large',
        host: 'h.example',
        bytes: 3_000_000,
        cap: AVATAR_MAX_BYTES
      })
    ).toBe(`Chat avatar not cached: h.example returned 3000000 bytes (cap ${AVATAR_MAX_BYTES}).`)
  })

  it('names the GIF subject and its own cap for Twitch GIFs (plan 155)', () => {
    expect(
      avatarCacheRejectionMessage(
        { kind: 'too-large', host: 'media2.giphy.com', bytes: 9_000_000, cap: CHAT_GIF_MAX_BYTES },
        'Chat GIF'
      )
    ).toBe(
      `Chat GIF not cached: media2.giphy.com returned 9000000 bytes (cap ${CHAT_GIF_MAX_BYTES}).`
    )
    expect(
      avatarCacheRejectionMessage({ kind: 'not-an-image', host: 'media2.giphy.com' }, 'Chat GIF')
    ).toBe('Chat GIF not cached: media2.giphy.com returned a body that is not a GIF, WebP or PNG.')
  })

  it('dedupes by host and reason so a busy chat logs each cause once', () => {
    const keys = rejections.map(avatarCacheRejectionKey)
    expect(new Set(keys).size).toBe(rejections.length)
    expect(
      avatarCacheRejectionKey({ kind: 'too-large', host: 'h.example', bytes: 1, cap: 10 })
    ).toBe(avatarCacheRejectionKey({ kind: 'too-large', host: 'h.example', bytes: 2, cap: 10 }))
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

  it('keeps .webp for 7TV emotes, so the asset protocol serves them as WebP', () => {
    expect(
      avatarCacheFileName('https://cdn.7tv.app/emote/01FCY771D800007PQ2DF3GDTN6/2x.webp')
    ).toMatch(/^[0-9a-f]{32}\.webp$/)
  })
})

describe('chatGifUrlDecision (plan 155)', () => {
  it('allows https GIPHY and Twitch CDN assets, naming the host', () => {
    expect(chatGifUrlDecision('https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif')).toEqual({
      allowed: true,
      host: 'media2.giphy.com'
    })
    expect(chatGifUrlDecision('https://static-cdn.jtvnw.net/gifs/abc.gif')).toEqual({
      allowed: true,
      host: 'static-cdn.jtvnw.net'
    })
  })

  it('refuses avatar and emote CDNs, lookalikes, http and garbage', () => {
    expect(chatGifUrlDecision('https://cdn.7tv.app/emote/x/2x.webp')).toEqual({
      allowed: false,
      rejection: { kind: 'host', scheme: 'https', host: 'cdn.7tv.app' }
    })
    expect(chatGifUrlDecision('https://yt3.ggpht.com/abc')).toMatchObject({ allowed: false })
    expect(chatGifUrlDecision('https://giphy.com.evil.example/a.gif')).toEqual({
      allowed: false,
      rejection: { kind: 'host', scheme: 'https', host: 'giphy.com.evil.example' }
    })
    expect(chatGifUrlDecision('http://media.giphy.com/a.gif')).toEqual({
      allowed: false,
      rejection: { kind: 'scheme', scheme: 'http', host: 'media.giphy.com' }
    })
    expect(chatGifUrlDecision(42)).toEqual({ allowed: false, rejection: { kind: 'not-a-url' } })
    expect(chatGifUrlDecision('not a url')).toEqual({
      allowed: false,
      rejection: { kind: 'not-a-url' }
    })
  })
})

describe('avatarPrunePlan (plan 155)', () => {
  const entry = (name: string, mtimeMs: number, bytes: number) => ({
    filePath: `/cache/${name}`,
    mtimeMs,
    bytes
  })

  it('keeps everything while both caps hold', () => {
    const entries = [entry('a', 3, 10), entry('b', 2, 10), entry('c', 1, 10)]
    expect(avatarPrunePlan(entries, { maxFiles: 3, maxBytes: 30 })).toEqual([])
    expect(avatarPrunePlan(entries)).toEqual([])
  })

  it('drops the oldest files once the count cap is reached', () => {
    const entries = [entry('old', 1, 1), entry('new', 3, 1), entry('mid', 2, 1)]
    expect(avatarPrunePlan(entries, { maxFiles: 2, maxBytes: 1_000 })).toEqual(['/cache/old'])
  })

  it('drops oldest-first until the bytes fit, so a few large GIFs cannot keep the cache over budget', () => {
    const entries = [
      entry('gif-new', 4, 6_000_000),
      entry('emote', 3, 50_000),
      entry('gif-old', 2, 6_000_000),
      entry('avatar', 1, 20_000)
    ]
    expect(avatarPrunePlan(entries, { maxFiles: 1_000, maxBytes: 8_000_000 })).toEqual([
      '/cache/gif-old',
      '/cache/avatar'
    ])
  })

  it('uses the production caps by default', () => {
    const many = Array.from({ length: AVATAR_CACHE_MAX_FILES + 1 }, (_, index) =>
      entry(`f${index}`, AVATAR_CACHE_MAX_FILES + 1 - index, 1)
    )
    expect(avatarPrunePlan(many)).toEqual([`/cache/f${AVATAR_CACHE_MAX_FILES}`])
    const twoLarge = [entry('big-new', 2, AVATAR_CACHE_MAX_BYTES), entry('big-old', 1, 1)]
    expect(avatarPrunePlan(twoLarge)).toEqual(['/cache/big-old'])
  })
})

describe('avatarPruneDelayMs', () => {
  it('prunes at once the first time, then at most once per interval', () => {
    expect(avatarPruneDelayMs(null, 1_000)).toBe(0)
    expect(avatarPruneDelayMs(1_000, 1_000)).toBe(AVATAR_PRUNE_MIN_INTERVAL_MS)
    expect(avatarPruneDelayMs(1_000, 3_000)).toBe(AVATAR_PRUNE_MIN_INTERVAL_MS - 2_000)
    expect(avatarPruneDelayMs(1_000, 1_000 + AVATAR_PRUNE_MIN_INTERVAL_MS)).toBe(0)
    expect(avatarPruneDelayMs(1_000, 1_000_000)).toBe(0)
  })
})
