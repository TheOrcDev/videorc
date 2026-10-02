import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionMicSliver } from './session-mic-sliver'

describe('session mic sliver (plan 092)', () => {
  it('renders nothing without a session or a microphone', () => {
    const render = (sessionActive: boolean, deviceName: string | undefined): string =>
      renderToStaticMarkup(
        createElement(SessionMicSliver, { sessionActive, deviceName, muted: false })
      )
    expect(render(false, 'Studio Mic')).toBe('')
    expect(render(true, undefined)).toBe('')
  })

  it('keeps its width with five flat bars while muted', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionMicSliver, {
        sessionActive: true,
        deviceName: 'Studio Mic',
        muted: true
      })
    )
    expect(markup).toContain('data-videorc-session-mic-sliver')
    expect(markup).toContain('title="Microphone muted"')
    expect(markup).toContain('w-9')
    expect(markup.match(/data-slot="bar-visualizer-bar"/g)).toHaveLength(5)
  })
})
