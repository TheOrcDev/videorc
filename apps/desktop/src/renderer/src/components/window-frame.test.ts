import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TRAFFIC_LIGHT_GUTTER_CLASS, useTrafficLightGutter, WindowFrame } from './window-frame'

describe('useTrafficLightGutter', () => {
  it('keeps the traffic-light gutter whatever the window size', () => {
    // A fullscreen header still shares its row with the lights (2026-09-25).
    const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    expect(useTrafficLightGutter()).toBe(mac ? TRAFFIC_LIGHT_GUTTER_CLASS : 'pl-3')
  })
})

describe('WindowFrame', () => {
  it('paints the content coat for a single-pane glass window', () => {
    const markup = renderToStaticMarkup(createElement(WindowFrame, null, 'body'))
    expect(markup).toContain('data-slot="window-frame"')
    expect(markup).toContain('bg-glass-content')
  })
})
