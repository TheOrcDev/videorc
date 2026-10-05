import { describe, expect, it } from 'vitest'

import { effectiveTwitchGifMode } from '../../../shared/chat-gif'
import type { LiveChatMessageFragment } from '@/lib/backend'

import { isGifFragment, splitGifFragments } from './chat-gifs'

const GIF_URL = 'https://media2.giphy.com/media/aUovxH8Vf9qDu/giphy.gif'
const gif = (): LiveChatMessageFragment => ({
  type: 'gif',
  text: '[Y A Y Yes GIF]',
  imageUrl: GIF_URL
})
const text = (value: string): LiveChatMessageFragment => ({ type: 'text', text: value })
const emote = (): LiveChatMessageFragment => ({
  type: 'emote',
  text: 'Kappa',
  imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
})

describe('splitGifFragments (plan 154)', () => {
  it('keeps a GIF-only message as one GIF part', () => {
    expect(splitGifFragments([gif()])).toEqual([{ kind: 'gif', fragment: gif() }])
  })

  it('splits text and emotes around the GIF, in order, dropping empty runs', () => {
    expect(splitGifFragments([text('gg '), emote(), text(' '), gif(), text(' wow')])).toEqual([
      { kind: 'fragments', fragments: [text('gg '), emote(), text(' ')] },
      { kind: 'gif', fragment: gif() },
      { kind: 'fragments', fragments: [text(' wow')] }
    ])
    expect(splitGifFragments([text(' '), gif()])).toEqual([{ kind: 'gif', fragment: gif() }])
  })

  it('leaves a gif fragment the backend refused (no URL) in the text run, as its title', () => {
    const refused: LiveChatMessageFragment = { type: 'gif', text: '[Nope GIF]' }
    expect(isGifFragment(refused)).toBe(false)
    expect(splitGifFragments([refused])).toEqual([{ kind: 'fragments', fragments: [refused] }])
  })

  it('never treats an emote as a GIF', () => {
    expect(isGifFragment(emote())).toBe(false)
    expect(splitGifFragments([emote()])).toEqual([{ kind: 'fragments', fragments: [emote()] }])
  })
})

describe('effectiveTwitchGifMode (plan 154, D6)', () => {
  it('forces Still when the system reduces motion, and never turns Off back on', () => {
    expect(effectiveTwitchGifMode('animated', false)).toBe('animated')
    expect(effectiveTwitchGifMode('animated', true)).toBe('still')
    expect(effectiveTwitchGifMode('still', true)).toBe('still')
    expect(effectiveTwitchGifMode('off', true)).toBe('off')
    expect(effectiveTwitchGifMode('off', false)).toBe('off')
  })
})
