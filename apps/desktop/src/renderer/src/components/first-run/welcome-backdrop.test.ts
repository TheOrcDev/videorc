import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WelcomeBackdrop } from './welcome-backdrop'

// Plan 203 S4: the backdrop is decoration with a DOM contract for the smoke.

const theme = vi.hoisted(() => ({ resolvedTheme: undefined as string | undefined }))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: theme.resolvedTheme }) }))

/** The opening tag of the first element carrying `attribute` (or the first `<img>`). */
function tagWith(html: string, attribute: string): string {
  const pattern =
    attribute === 'img'
      ? /<img\s[^>]*>/
      : new RegExp(`<[a-z]+\\s[^>]*?${attribute}(?=[=\\s/>])[^>]*>`)
  const match = pattern.exec(html)
  if (!match) throw new Error(`no element with ${attribute}`)
  return match[0]
}

describe('WelcomeBackdrop', () => {
  beforeEach(() => {
    theme.resolvedTheme = undefined
  })

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

  it('under dark draws the chrome as it is, the shader Dim matched on the poster', () => {
    theme.resolvedTheme = 'dark'
    const html = renderToStaticMarkup(createElement(WelcomeBackdrop))
    expect(tagWith(html, 'data-first-run-backdrop')).toContain(
      'data-first-run-backdrop-tone="normal"'
    )
    expect(tagWith(html, 'data-first-run-backdrop-picture')).not.toContain('filter')
    expect(tagWith(html, 'img')).toContain('filter:brightness(0.7)')
  })

  it('under light turns the picture around, poster and canvas together, never the solid (plan 208 D3)', () => {
    theme.resolvedTheme = 'light'
    const html = renderToStaticMarkup(createElement(WelcomeBackdrop))
    const root = tagWith(html, 'data-first-run-backdrop')
    expect(root).toContain('data-first-run-backdrop-tone="inverse"')
    expect(root).toContain('bg-glass-solid')
    expect(root).not.toContain('filter')
    expect(tagWith(html, 'data-first-run-backdrop-picture')).toContain('filter:invert(1)')
    // The shader takes no Dim under light, so the poster takes none either.
    expect(tagWith(html, 'img')).not.toContain('filter')
    // Both the poster and the canvas host sit inside the inverted picture.
    const picture = html.slice(html.indexOf('data-first-run-backdrop-picture'))
    expect(picture).toMatch(/<img[^>]+live-liquid-chrome-polished/)
    expect(picture).toContain('data-first-run-backdrop-canvas')
  })

  it('under light the poster stays inverted when it is the still', () => {
    theme.resolvedTheme = 'light'
    const html = renderToStaticMarkup(
      createElement(WelcomeBackdrop, { hardwareAccelerationDisabled: true })
    )
    expect(html).toContain('data-first-run-backdrop="still"')
    expect(tagWith(html, 'data-first-run-backdrop-picture')).toContain('filter:invert(1)')
  })
})
