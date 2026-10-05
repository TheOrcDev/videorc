import { describe, expect, it } from 'vitest'

import type { LiveChatMessageFragment } from '@/lib/backend'
import {
  HIGHLIGHT_MAX_TEXT_LINES,
  HIGHLIGHT_NAME_WEIGHT,
  HIGHLIGHT_TEXT_WEIGHT,
  highlightMetrics,
  layoutCommentHighlight,
  wrapHighlightText,
  type HighlightTextMeasurer
} from './comment-highlight'
import {
  HIGHLIGHT_EMOTE_MAX_ASPECT,
  HIGHLIGHT_MAX_EMOTES,
  highlightEmoteBox,
  highlightEmoteBoxHeightPx,
  highlightEmoteImageUrl,
  highlightEmoteUrls,
  highlightTokens,
  layoutCommentHighlightTokens,
  wrapHighlightTokens,
  type HighlightEmoteSizer,
  type HighlightLine
} from './comment-highlight-layout'

const measure = (text: string, fontPx: number): number => text.length * fontPx * 0.55
const metrics = highlightMetrics(1920, 1080)
const square: HighlightEmoteSizer = () => ({ width: 112, height: 112 })
const none: HighlightEmoteSizer = () => null

const emote = (text: string, id = text, extra: Partial<LiveChatMessageFragment> = {}) => ({
  type: 'emote',
  text,
  imageUrl: `https://cdn.7tv.app/emote/${id}/2x.webp`,
  ...extra
})
const text = (value: string): LiveChatMessageFragment => ({ type: 'text', text: value })

const lineText = (line: HighlightLine): string =>
  line.items
    .map((item) => (item.kind === 'word' ? item.text : `[${item.url.split('/')[4]}]`))
    .join(' ')

describe('highlightTokens', () => {
  it('uses the plain text when no fragment carries an image', () => {
    expect(highlightTokens('Resub · 14 months: hello  there', [text('hello  there')])).toEqual([
      { kind: 'word', text: 'Resub' },
      { kind: 'word', text: '·' },
      { kind: 'word', text: '14' },
      { kind: 'word', text: 'months:' },
      { kind: 'word', text: 'hello' },
      { kind: 'word', text: 'there' }
    ])
    expect(highlightTokens('hi', undefined)).toEqual([{ kind: 'word', text: 'hi' }])
  })

  it('turns image fragments into emote tokens and stacks zero-width overlays', () => {
    const tokens = highlightTokens('ignored', [
      text('gg '),
      emote('catJAM'),
      text(' '),
      emote('RainTime', 'RainTime', { zeroWidth: true }),
      text(' wow')
    ])
    expect(tokens).toEqual([
      { kind: 'word', text: 'gg' },
      {
        kind: 'emote',
        name: 'catJAM',
        url: 'https://cdn.7tv.app/emote/catJAM/2x.webp',
        overlays: ['https://cdn.7tv.app/emote/RainTime/2x.webp']
      },
      { kind: 'word', text: 'wow' }
    ])
  })

  it('lists distinct emote images, base before overlays, capped at 20', () => {
    const fragments = Array.from({ length: 30 }, (_, index) => emote(`e${index}`))
    expect(highlightEmoteUrls(highlightTokens('', fragments))).toHaveLength(HIGHLIGHT_MAX_EMOTES)
    const stacked = highlightTokens('', [
      emote('a'),
      emote('z', 'z', { zeroWidth: true }),
      emote('a'),
      emote('b')
    ])
    expect(highlightEmoteUrls(stacked).map((url) => url.split('/')[4])).toEqual(['a', 'z', 'b'])
  })
})

describe('highlightEmoteBox', () => {
  it('is 1.2 text sizes high with the width from the decoded aspect ratio', () => {
    const heightPx = highlightEmoteBoxHeightPx(metrics)
    expect(heightPx).toBe(Math.round(metrics.textFontPx * 1.2))
    expect(highlightEmoteBox({ width: 112, height: 112 }, metrics)).toEqual({
      widthPx: heightPx,
      heightPx
    })
    expect(highlightEmoteBox({ width: 224, height: 112 }, metrics)).toEqual({
      widthPx: heightPx * 2,
      heightPx
    })
  })

  it('caps a wide 7TV emote and refuses a missing or degenerate size', () => {
    const heightPx = highlightEmoteBoxHeightPx(metrics)
    expect(highlightEmoteBox({ width: 1000, height: 100 }, metrics)).toEqual({
      widthPx: heightPx * HIGHLIGHT_EMOTE_MAX_ASPECT,
      heightPx
    })
    expect(highlightEmoteBox(null, metrics)).toBeNull()
    expect(highlightEmoteBox({ width: 0, height: 10 }, metrics)).toBeNull()
  })
})

describe('wrapHighlightTokens', () => {
  it('lays out an emote-only message as one line of boxes', () => {
    const lines = wrapHighlightTokens(
      highlightTokens('', [emote('a'), text(' '), emote('b')]),
      metrics,
      measure,
      square
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]!.items.map((item) => item.kind)).toEqual(['emote', 'emote'])
    const box = highlightEmoteBoxHeightPx(metrics)
    expect(lines[0]!.items[0]).toMatchObject({ xPx: 0, widthPx: box, heightPx: box })
    expect(lines[0]!.items[1]!.xPx).toBe(box + measure(' ', metrics.textFontPx))
    expect(lines[0]!.widthPx).toBe(box * 2 + measure(' ', metrics.textFontPx))
  })

  it('wraps words and emotes across lines without exceeding the width budget', () => {
    const fragments: LiveChatMessageFragment[] = []
    for (let index = 0; index < 14; index += 1) {
      fragments.push(text(` wordy${index} `), emote(`e${index}`))
    }
    const lines = wrapHighlightTokens(highlightTokens('', fragments), metrics, measure, square)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_TEXT_LINES)
    for (const line of lines) {
      expect(line.widthPx).toBeLessThanOrEqual(metrics.maxTextWidthPx)
      for (const item of line.items) {
        expect(item.xPx + item.widthPx).toBeLessThanOrEqual(metrics.maxTextWidthPx)
      }
    }
    // Mixed lines: a line that starts with a word continues with an emote.
    expect(lines[0]!.items.map((item) => item.kind).slice(0, 2)).toEqual(['word', 'emote'])
  })

  it('keeps a wide emote at the cap on its own line when nothing else fits', () => {
    const wide: HighlightEmoteSizer = () => ({ width: 4000, height: 100 })
    const narrow = { ...metrics, maxTextWidthPx: highlightEmoteBoxHeightPx(metrics) * 3 + 2 }
    const lines = wrapHighlightTokens(
      highlightTokens('', [emote('banner'), text(' hi')]),
      narrow,
      measure,
      wide
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]!.items[0]).toMatchObject({
      kind: 'emote',
      widthPx: highlightEmoteBoxHeightPx(metrics) * HIGHLIGHT_EMOTE_MAX_ASPECT
    })
    expect(lineText(lines[1]!)).toBe('hi')
  })

  it('keeps a zero-width stack in one box', () => {
    const lines = wrapHighlightTokens(
      highlightTokens('', [
        emote('catJAM'),
        text(' '),
        emote('RainTime', 'RainTime', { zeroWidth: true })
      ]),
      metrics,
      measure,
      square
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]!.items).toHaveLength(1)
    expect(lines[0]!.items[0]).toMatchObject({
      kind: 'emote',
      overlays: ['https://cdn.7tv.app/emote/RainTime/2x.webp']
    })
  })

  it('cuts at three lines with a trailing ellipsis, glued to a word or after an emote', () => {
    const many = Array.from({ length: 80 }, (_, index) => `w${index}`).join(' ')
    const wordLines = wrapHighlightTokens(highlightTokens(many, undefined), metrics, measure, none)
    expect(wordLines).toHaveLength(HIGHLIGHT_MAX_TEXT_LINES)
    const lastWord = wordLines[2]!.items.at(-1)!
    expect(lastWord.kind === 'word' && lastWord.text.endsWith('…')).toBe(true)
    expect(wordLines[2]!.widthPx).toBeLessThanOrEqual(metrics.maxTextWidthPx)
    // Text-only wrapping agrees with the eager text layout's lines.
    expect(wordLines.map(lineText)).toEqual(wrapHighlightText(many, metrics, measure))

    const fragments: LiveChatMessageFragment[] = []
    for (let index = 0; index < 60; index += 1) fragments.push(emote(`e${index}`), text(' '))
    const emoteLines = wrapHighlightTokens(highlightTokens('', fragments), metrics, measure, square)
    expect(emoteLines).toHaveLength(HIGHLIGHT_MAX_TEXT_LINES)
    const tail = emoteLines[2]!.items.at(-1)!
    expect(tail).toMatchObject({ kind: 'word', text: '…' })
    expect(emoteLines[2]!.items.at(-2)!.kind).toBe('emote')
    expect(emoteLines[2]!.widthPx).toBeLessThanOrEqual(metrics.maxTextWidthPx)
  })

  it('draws an emote whose image failed as its name', () => {
    const lines = wrapHighlightTokens(
      highlightTokens('', [text('gg '), emote('Kappa')]),
      metrics,
      measure,
      none
    )
    expect(lineText(lines[0]!)).toBe('gg Kappa')
    expect(lines[0]!.items.every((item) => item.kind === 'word')).toBe(true)
  })

  it('returns no lines for an empty message', () => {
    expect(wrapHighlightTokens([], metrics, measure, square)).toEqual([])
    expect(
      wrapHighlightTokens(highlightTokens('   ', [text('  ')]), metrics, measure, square)
    ).toEqual([])
  })
})

describe('layoutCommentHighlightTokens', () => {
  it('sizes a text-only card exactly like the eager layout', () => {
    const params = {
      authorName: 'Orc Dev',
      text: 'hello there, this is a longer message that wraps once at least',
      canvasWidth: 1920,
      canvasHeight: 1080,
      platform: 'twitch' as const,
      measure
    }
    const tokens = layoutCommentHighlightTokens({ ...params, emoteSize: none })
    const plain = layoutCommentHighlight(params)
    expect(tokens?.cardWidthPx).toBe(plain?.cardWidthPx)
    expect(tokens?.cardHeightPx).toBe(plain?.cardHeightPx)
    expect(tokens?.name).toBe(plain?.name)
    expect(tokens?.lines.map(lineText)).toEqual(plain?.textLines)
  })

  it('counts emote boxes in the card width and keeps the width cap', () => {
    const fragments = [text('gg '), emote('a'), text(' '), emote('b')]
    const layout = layoutCommentHighlightTokens({
      authorName: 'Orc Dev',
      text: 'gg a b',
      fragments,
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure,
      emoteSize: () => ({ width: 300, height: 100 })
    })!
    const box = highlightEmoteBoxHeightPx(metrics)
    const expectedLine =
      measure('gg', metrics.textFontPx) + 2 * measure(' ', metrics.textFontPx) + box * 3 * 2
    expect(layout.lines[0]!.widthPx).toBe(expectedLine)
    expect(layout.cardWidthPx).toBe(Math.ceil(metrics.paddingPx * 2 + expectedLine))
    expect(layout.cardWidthPx).toBeLessThanOrEqual(Math.floor(1920 * 0.6))
    expect(layout.cardHeightPx).toBe(
      Math.ceil(metrics.paddingPx * 2 + metrics.avatarPx + metrics.rowGapPx + metrics.lineHeightPx)
    )
  })

  it('places an emote one regular-weight space after the regular-weight words', () => {
    // Semibold runs 10% wider: measuring the message at the name's weight put
    // the emote a gap past the words the card paints regular.
    const weighted: HighlightTextMeasurer = (value, fontPx, weight) =>
      value.length * fontPx * (weight === HIGHLIGHT_NAME_WEIGHT ? 0.605 : 0.55)
    const regular = (value: string): number =>
      weighted(value, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
    const layout = layoutCommentHighlightTokens({
      authorName: 'Orc',
      text: 'you just have to get some rich viewers',
      fragments: [text('you just have to get some rich viewers '), emote('Kappa')],
      canvasWidth: 1920,
      canvasHeight: 1080,
      measure: weighted,
      emoteSize: square
    })!
    const words = 'you just have to get some rich viewers'.split(' ')
    const wordsPx =
      words.reduce((sum, word) => sum + regular(word), 0) + (words.length - 1) * regular(' ')
    const [line] = layout.lines
    const placed = line!.items[line!.items.length - 1]!
    expect(placed.kind).toBe('emote')
    expect(placed.xPx).toBeCloseTo(wordsPx + regular(' '))
    const lineWidth = wordsPx + regular(' ') + highlightEmoteBoxHeightPx(metrics)
    expect(layout.cardWidthPx).toBe(Math.ceil(metrics.paddingPx * 2 + lineWidth))
  })

  it('keeps a portrait card inside its 0.78 width cap with emotes', () => {
    const fragments = Array.from({ length: 12 }, (_, index) => emote(`e${index}`))
    const layout = layoutCommentHighlightTokens({
      authorName: 'Orc Dev',
      text: '',
      fragments,
      canvasWidth: 1080,
      canvasHeight: 1920,
      measure,
      emoteSize: () => ({ width: 300, height: 100 })
    })!
    expect(layout.cardWidthPx).toBeLessThanOrEqual(Math.floor(1080 * 0.78))
    expect(layout.lines.length).toBeLessThanOrEqual(HIGHLIGHT_MAX_TEXT_LINES)
  })
})

describe('highlightEmoteImageUrl', () => {
  it('asks Twitch for the 3.0 emote and leaves every other CDN alone', () => {
    expect(
      highlightEmoteImageUrl('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0')
    ).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0')
    for (const untouched of [
      'https://cdn.7tv.app/emote/01ABC/2x.webp',
      'https://files.kick.com/emotes/37226/fullsize',
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'
    ]) {
      expect(highlightEmoteImageUrl(untouched)).toBe(untouched)
    }
  })
})
