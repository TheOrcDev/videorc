import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { isNativeFullscreenSize, WindowFrame } from './window-frame'

const screen = { screenWidth: 1512, screenHeight: 982 }

describe('isNativeFullscreenSize', () => {
  it('is true only when the window covers the whole screen, menu bar included', () => {
    expect(isNativeFullscreenSize({ outerWidth: 1512, outerHeight: 982, ...screen })).toBe(true)
    // Zoomed (maximized) windows stop under the menu bar.
    expect(isNativeFullscreenSize({ outerWidth: 1512, outerHeight: 949, ...screen })).toBe(false)
    expect(isNativeFullscreenSize({ outerWidth: 1180, outerHeight: 780, ...screen })).toBe(false)
  })
})

describe('WindowFrame', () => {
  it('paints the content coat for a single-pane glass window', () => {
    const markup = renderToStaticMarkup(createElement(WindowFrame, null, 'body'))
    expect(markup).toContain('data-slot="window-frame"')
    expect(markup).toContain('bg-glass-content')
  })
})
