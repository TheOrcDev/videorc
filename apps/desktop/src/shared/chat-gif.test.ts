import { describe, expect, it } from 'vitest'

import {
  CHAT_GIF_MAX_BYTES,
  MAX_CHAT_GIF_URL_LENGTH,
  gifTitle,
  sniffChatImage,
  twitchGifAssetUrl
} from './chat-gif'

describe('twitchGifAssetUrl (plan 154)', () => {
  it('returns an allowlisted https URL exactly as sent', () => {
    const url = 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif?cid=abc'
    expect(twitchGifAssetUrl(url)).toBe(url)
    expect(twitchGifAssetUrl('https://i.giphy.com/x.gif')).toBe('https://i.giphy.com/x.gif')
    expect(twitchGifAssetUrl('https://static-cdn.jtvnw.net/gifs/a.gif')).toBe(
      'https://static-cdn.jtvnw.net/gifs/a.gif'
    )
    // Host matching is case-insensitive; the string is still untouched.
    expect(twitchGifAssetUrl('https://Media0.GIPHY.com/a.gif')).toBe(
      'https://Media0.GIPHY.com/a.gif'
    )
  })

  it('refuses every other scheme, host, credential and shape', () => {
    for (const refused of [
      'http://media0.giphy.com/a.gif',
      'https://user:pw@media0.giphy.com/a.gif',
      'https://user@media0.giphy.com/a.gif',
      'https://giphy.com.evil.example/a.gif',
      'https://notgiphy.com/a.gif',
      'https://cdn.7tv.app/emote/x/2x.webp',
      'https://static-cdn.jtvnw.net.evil.example/a.gif',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      '',
      42,
      null,
      undefined
    ]) {
      expect(twitchGifAssetUrl(refused)).toBeNull()
    }
    expect(
      twitchGifAssetUrl(`https://i.giphy.com/${'a'.repeat(MAX_CHAT_GIF_URL_LENGTH)}`)
    ).toBeNull()
  })
})

describe('gifTitle', () => {
  it('strips the brackets and the GIF suffix Twitch adds', () => {
    expect(gifTitle('[Y A Y Yes GIF]')).toBe('Y A Y Yes')
    expect(gifTitle('[Clap GIF]')).toBe('Clap')
    expect(gifTitle('[GIF]')).toBe('GIF')
    expect(gifTitle('Y A Y Yes GIF')).toBe('Y A Y Yes')
    expect(gifTitle('[no suffix]')).toBe('no suffix')
    expect(gifTitle('  plain  ')).toBe('plain')
    expect(gifTitle('')).toBe('')
    expect(gifTitle('[ GIF ]')).toBe('GIF')
  })
})

describe('sniffChatImage', () => {
  const padded = (head: number[]): Uint8Array => {
    const bytes = new Uint8Array(Math.max(16, head.length))
    bytes.set(head)
    return bytes
  }
  const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))

  it('recognises GIF, WebP and PNG by their magic bytes', () => {
    expect(sniffChatImage(padded(ascii('GIF89a')))).toBe('gif')
    expect(sniffChatImage(padded(ascii('GIF87a')))).toBe('gif')
    expect(sniffChatImage(padded([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]))).toBe('webp')
    expect(sniffChatImage(padded([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
  })

  it('refuses HTML, MP4, JPEG and short bodies', () => {
    expect(sniffChatImage(padded(ascii('<!DOCTYPE html>')))).toBeNull()
    expect(sniffChatImage(padded([0, 0, 0, 0x18, ...ascii('ftypmp42')]))).toBeNull()
    expect(sniffChatImage(padded([0xff, 0xd8, 0xff, 0xe0]))).toBeNull()
    expect(sniffChatImage(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull()
    expect(sniffChatImage(new Uint8Array())).toBeNull()
  })

  it('caps GIFs above the avatar cap, below ten megabytes', () => {
    expect(CHAT_GIF_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})
