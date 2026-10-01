import { describe, expect, it } from 'vitest'

import type { LiveChatMessageFragment } from '@/lib/backend'

import { groupEmoteOverlays, type ChatMessagePiece } from './chat-emotes'

const cdn = (id: string): string => `https://cdn.7tv.app/emote/${id}/2x.webp`
const text = (value: string): LiveChatMessageFragment => ({ type: 'text', text: value })
const emote = (name: string, zeroWidth = false): LiveChatMessageFragment => ({
  type: 'emote',
  text: name,
  imageUrl: cdn(name),
  ...(zeroWidth ? { zeroWidth: true } : {})
})
const image = (name: string): { text: string; url: string } => ({ text: name, url: cdn(name) })
const inline = (name: string): ChatMessagePiece => ({
  kind: 'emote',
  emote: image(name),
  overlays: []
})

describe('groupEmoteOverlays', () => {
  it('stacks a zero-width emote on the emote before it and drops the space between', () => {
    expect(groupEmoteOverlays([emote('catJAM'), text(' '), emote('RainTime', true)])).toEqual([
      { kind: 'emote', emote: image('catJAM'), overlays: [image('RainTime')] }
    ])
  })

  it('stacks several overlays in order, then carries on with the text', () => {
    expect(
      groupEmoteOverlays([
        text('look '),
        emote('catJAM'),
        text(' '),
        emote('RainTime', true),
        text(' '),
        emote('PETPET', true),
        text(' nice')
      ])
    ).toEqual([
      { kind: 'text', text: 'look ' },
      { kind: 'emote', emote: image('catJAM'), overlays: [image('RainTime'), image('PETPET')] },
      { kind: 'text', text: ' nice' }
    ])
  })

  it('draws a zero-width emote inline when no emote comes right before it', () => {
    expect(groupEmoteOverlays([emote('RainTime', true), text(' hi')])).toEqual([
      inline('RainTime'),
      { kind: 'text', text: ' hi' }
    ])
    expect(groupEmoteOverlays([text('hi '), emote('RainTime', true)])).toEqual([
      { kind: 'text', text: 'hi ' },
      inline('RainTime')
    ])
    expect(groupEmoteOverlays([emote('catJAM'), text(' wow '), emote('RainTime', true)])).toEqual([
      inline('catJAM'),
      { kind: 'text', text: ' wow ' },
      inline('RainTime')
    ])
  })

  it('keeps ordinary emotes and their spacing exactly', () => {
    expect(
      groupEmoteOverlays([emote('catJAM'), text('  '), emote('EZ'), text(' '), text('@you')])
    ).toEqual([
      inline('catJAM'),
      { kind: 'text', text: '  ' },
      inline('EZ'),
      { kind: 'text', text: ' ' },
      { kind: 'text', text: '@you' }
    ])
  })

  it('treats Twitch and Kick emotes as bases for a 7TV overlay', () => {
    const kappa: LiveChatMessageFragment = {
      type: 'emote',
      text: 'Kappa',
      imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
    }
    expect(groupEmoteOverlays([kappa, text(' '), emote('RainTime', true)])).toEqual([
      {
        kind: 'emote',
        emote: { text: 'Kappa', url: kappa.imageUrl },
        overlays: [image('RainTime')]
      }
    ])
  })
})
