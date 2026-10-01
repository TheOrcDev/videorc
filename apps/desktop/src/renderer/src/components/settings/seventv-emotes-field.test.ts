import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ChatEmotesSettings } from '@/lib/backend'

import { SevenTvEmotesFieldView } from './seventv-emotes-field'

const render = (settings: ChatEmotesSettings | null, error: string | null = null): string =>
  renderToStaticMarkup(
    createElement(SevenTvEmotesFieldView, { settings, error, onSevenTvChange: () => undefined })
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
      sevenTvStatus: { state: 'linked', setName: 'Channel Emotes', emoteCount: 42 }
    })
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('“Channel Emotes” · 42 emotes')
  })

  it('shows no status line when off, and the error when the setting failed', () => {
    const off = render({ sevenTv: false, sevenTvStatus: { state: 'off' } })
    expect(off).toContain('aria-checked="false"')
    expect(off).not.toContain('data-slot="seventv-status"')
    const failed = render(
      { sevenTv: true, sevenTvStatus: { state: 'idle' } },
      "Couldn't save this setting. Try again."
    )
    expect(failed).toContain('Couldn&#x27;t save this setting. Try again.')
    expect(failed).not.toContain('Loads when you go live.')
  })
})
