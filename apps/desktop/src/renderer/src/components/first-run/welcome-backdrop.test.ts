import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WelcomeBackdrop } from './welcome-backdrop'

// Plan 203 S4: the backdrop is decoration with a DOM contract for the smoke.

describe('WelcomeBackdrop', () => {
  it('paints the poster at once, hidden from assistive tech, with the canvas host waiting', () => {
    const html = renderToStaticMarkup(createElement(WelcomeBackdrop))
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('data-first-run-backdrop="starting"')
    expect(html).toContain('data-first-run-backdrop-look="polished"')
    expect(html).toMatch(/<img[^>]+live-liquid-chrome-polished/)
    // The player brings its own canvas into this host on the client.
    expect(html).toContain('data-first-run-backdrop-canvas')
    expect(html).not.toContain('data-first-run-backdrop-reason')
  })

  it('stays a still, with no canvas, when hardware acceleration is off', () => {
    const html = renderToStaticMarkup(
      createElement(WelcomeBackdrop, { hardwareAccelerationDisabled: true })
    )
    expect(html).toContain('data-first-run-backdrop="still"')
    expect(html).toContain('data-first-run-backdrop-reason="hardware-acceleration-off"')
    expect(html).not.toContain('data-first-run-backdrop-canvas')
  })

  it('shows the chosen look', () => {
    const html = renderToStaticMarkup(createElement(WelcomeBackdrop, { look: 'mercury' }))
    expect(html).toContain('data-first-run-backdrop-look="mercury"')
    expect(html).toMatch(/<img[^>]+live-liquid-chrome-mercury/)
  })
})
