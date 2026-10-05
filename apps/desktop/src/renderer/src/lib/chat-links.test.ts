import { describe, expect, it } from 'vitest'

import { chatLinksIn, splitLinks } from '@/lib/chat-links'

import { openableChatLink } from '../../../shared/chat-link'

function links(text: string): string[] {
  return chatLinksIn(text).map((link) => link.href)
}

describe('splitLinks (plan 151, D7)', () => {
  it('keeps the text around a link, in order', () => {
    expect(splitLinks('grab it at https://videorc.com/download today')).toEqual([
      { kind: 'text', text: 'grab it at ' },
      {
        kind: 'link',
        text: 'https://videorc.com/download',
        href: 'https://videorc.com/download',
        host: 'videorc.com'
      },
      { kind: 'text', text: ' today' }
    ])
    expect(splitLinks('no links here')).toEqual([{ kind: 'text', text: 'no links here' }])
    expect(splitLinks('')).toEqual([])
  })

  it('leaves sentence punctuation outside the link', () => {
    expect(links('see https://videorc.com/download.')).toEqual(['https://videorc.com/download'])
    expect(links('really? https://videorc.com!')).toEqual(['https://videorc.com'])
    expect(links('(see videorc.com)')).toEqual(['https://videorc.com'])
    expect(links('(https://videorc.com)')).toEqual(['https://videorc.com'])
    expect(links('"https://videorc.com"')).toEqual(['https://videorc.com'])
  })

  it('keeps a bracket the link itself opened', () => {
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    ])
  })

  it('opens www. and bare names over https, and shows the host', () => {
    const [www] = chatLinksIn('www.twitch.tv/x')
    expect(www).toMatchObject({ href: 'https://www.twitch.tv/x', host: 'twitch.tv' })
    expect(links('t.co/abc')).toEqual(['https://t.co/abc'])
    expect(links('come to videorc.com')).toEqual(['https://videorc.com'])
    expect(links('http://example.com/plain')).toEqual(['http://example.com/plain'])
  })

  it('never makes file names, other TLDs or other schemes into links', () => {
    for (const text of [
      'node.js is great',
      'open file.txt',
      'version 1.5',
      'e.g. this',
      'javascript:alert(1)',
      'mailto:a@b.co',
      'write me at someone@videorc.com',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://videorc.com'
    ]) {
      expect(links(text), text).toEqual([])
    }
  })

  it('refuses a link with a username or password, or one too long to be real', () => {
    expect(links('https://user:pass@videorc.com')).toEqual([])
    expect(links('user:pass@videorc.com')).toEqual([])
    expect(links(`https://videorc.com/${'a'.repeat(3000)}`)).toEqual([])
  })

  it('finds every link once, and stops at emoji and spaces', () => {
    expect(links('a https://videorc.com and twitch.tv/orcdev and https://videorc.com')).toEqual([
      'https://videorc.com',
      'https://twitch.tv/orcdev'
    ])
    expect(links('🔥https://videorc.com🔥 look')).toEqual(['https://videorc.com'])
    expect(links('看这个 https://videorc.com/download 。')).toEqual([
      'https://videorc.com/download'
    ])
  })
})

describe('openableChatLink (plan 151, D14)', () => {
  it('opens http and https only, without credentials, within the length', () => {
    expect(openableChatLink('https://videorc.com/download')).toBe('https://videorc.com/download')
    expect(openableChatLink('http://example.com')).toBe('http://example.com/')
    for (const value of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'mailto:a@b.co',
      'https://user:pass@videorc.com',
      'https://user@videorc.com',
      'not a url',
      '',
      42,
      undefined,
      `https://videorc.com/${'a'.repeat(3000)}`
    ]) {
      expect(openableChatLink(value), String(value)).toBeNull()
    }
  })
})
