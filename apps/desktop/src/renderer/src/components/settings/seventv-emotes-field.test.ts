import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ChatEmotesSettings } from '@/lib/backend'

import {
  ChatEmoteSettingsView,
  SevenTvEmotesFieldView,
  TwitchGifsFieldView
} from './seventv-emotes-field'

const render = (settings: ChatEmotesSettings | null, error: string | null = null): string =>
  renderToStaticMarkup(
    createElement(SevenTvEmotesFieldView, { settings, error, onSevenTvChange: () => undefined })
  )
const renderGifs = (settings: ChatEmotesSettings | null): string =>
  renderToStaticMarkup(createElement(TwitchGifsFieldView, { settings, onChange: () => undefined }))
const renderBoth = (settings: ChatEmotesSettings | null, error: string | null): string =>
  renderToStaticMarkup(
    createElement(ChatEmoteSettingsView, {
      settings,
      error,
      onSevenTvChange: () => undefined,
      onTwitchGifsChange: () => undefined
    })
  )

describe('Settings → General → Show 7TV emotes in chat', () => {
  it('waits for the backend with the switch disabled', () => {
    const markup = render(null)
    expect(markup).toContain('Show 7TV emotes in chat')
    expect(markup).toMatch(/<button[^>]*disabled=""/)
    expect(markup).not.toContain('data-slot="seventv-status"')
  })

  it('shows the switch on, with the loaded set under it', () => {
    const markup = render({
      sevenTv: true,
      sevenTvStatus: { state: 'linked', setName: 'Channel Emotes', emoteCount: 42 },
      twitchGifs: 'animated'
    })
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('“Channel Emotes” · 42 emotes')
  })

  it('shows no status line when off, and steps aside for a failure', () => {
    const off = render({ sevenTv: false, sevenTvStatus: { state: 'off' }, twitchGifs: 'animated' })
    expect(off).toContain('aria-checked="false"')
    expect(off).not.toContain('data-slot="seventv-status"')
    const failed = render(
      { sevenTv: true, sevenTvStatus: { state: 'idle' }, twitchGifs: 'animated' },
      "Couldn't save the chat settings. Try again."
    )
    expect(failed).not.toContain('Loads when you go live.')
  })
})

describe('Settings → General → Stream Manager chat rows (plan 174 I-8)', () => {
  it('says why both rows are locked once, ahead of them, when the settings could not be read', () => {
    const markup = renderBoth(
      null,
      "Couldn't read the chat settings. Reopen Settings to try again."
    )
    expect(markup.match(/Couldn&#x27;t read the chat settings/g)).toHaveLength(1)
    const alert = markup.indexOf('data-testid="chat-emote-error"')
    expect(alert).toBeGreaterThan(-1)
    expect(alert).toBeLessThan(markup.indexOf('Show 7TV emotes in chat'))
    expect(alert).toBeLessThan(markup.indexOf('GIFs in Twitch chat'))
    // Both controls are off while the reason stands.
    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(2)
  })

  it('shows no alert while the settings work', () => {
    const markup = renderBoth(
      { sevenTv: true, sevenTvStatus: { state: 'idle' }, twitchGifs: 'animated' },
      null
    )
    expect(markup).not.toContain('chat-emote-error')
    expect(markup).not.toMatch(/<button[^>]*disabled=""/)
  })
})

describe('Settings → General → GIFs in Twitch chat (plan 155)', () => {
  it('waits for the backend with the select disabled', () => {
    const markup = renderGifs(null)
    expect(markup).toContain('GIFs in Twitch chat')
    expect(markup).toContain("Twitch's GIF Keyboard".replace("'", '&#x27;'))
    expect(markup).toMatch(/<button[^>]*disabled=""/)
  })

  it('shows the saved mode', () => {
    const still = renderGifs({
      sevenTv: true,
      sevenTvStatus: { state: 'idle' },
      twitchGifs: 'still'
    })
    expect(still).toContain('data-slot="twitch-gifs-mode">Still<')
    expect(still).not.toMatch(/<button[^>]*disabled=""/)
    const off = renderGifs({ sevenTv: true, sevenTvStatus: { state: 'idle' }, twitchGifs: 'off' })
    expect(off).toContain('data-slot="twitch-gifs-mode">Off<')
  })
})
