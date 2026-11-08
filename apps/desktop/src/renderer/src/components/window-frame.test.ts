import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WINDOW_TITLE_CLASS } from './pane'
import {
  TRAFFIC_LIGHT_GUTTER_CLASS,
  useTrafficLightGutter,
  WindowFrame,
  WindowHeader
} from './window-frame'

describe('useTrafficLightGutter', () => {
  const gutter = (platform: string): string => {
    function Probe(): ReactElement {
      return createElement('span', null, useTrafficLightGutter(platform))
    }
    return renderToStaticMarkup(createElement(Probe))
  }

  it('keeps the traffic-light gutter on macOS whatever the window size', () => {
    // A fullscreen header still shares its row with the lights (2026-09-25).
    expect(gutter('darwin')).toBe(`<span>${TRAFFIC_LIGHT_GUTTER_CLASS}</span>`)
    expect(gutter('win32')).toBe('<span>pl-3</span>')
    expect(gutter('linux')).toBe('<span>pl-3</span>')
  })
})

describe('WindowFrame', () => {
  it('paints the content coat for a single-pane glass window', () => {
    const markup = renderToStaticMarkup(createElement(WindowFrame, null, 'body'))
    expect(markup).toContain('data-slot="window-frame"')
    expect(markup).toContain('bg-glass-content')
  })
})

describe('WindowHeader', () => {
  // Plan 174 S1.6b (H-28, J1-18, D-25, I-29): one title row for Stream
  // Manager, Notes and the Captions reader, in the main window's recipe.

  it('titles the window with an h1 at 14 px / 600 on a 40 px drag band by the lights', () => {
    const markup = renderToStaticMarkup(
      createElement(WindowHeader, { title: 'Stream Manager', platform: 'darwin' })
    )
    expect(markup).toContain('data-slot="window-header"')
    expect(markup).toContain(
      `<h1 class="${WINDOW_TITLE_CLASS} shrink-0" data-slot="window-header-title">Stream Manager</h1>`
    )
    expect(markup).toContain('h-toolbar')
    expect(markup).toContain('[-webkit-app-region:drag]')
    expect(markup).toContain(TRAFFIC_LIGHT_GUTTER_CLASS)
    // The title alone: no controls slot unless a window passes controls.
    expect(markup).not.toContain('window-header-actions')
    expect(markup).not.toContain('<button')
  })

  it('puts a quiet fact after the title and the controls at the end, out of the drag band', () => {
    const markup = renderToStaticMarkup(
      createElement(
        WindowHeader,
        { title: 'Notes', meta: createElement('span', null, 'Listening') },
        createElement('button', { type: 'button' }, 'Pin')
      )
    )
    expect(markup).toContain('data-slot="window-header-meta"><span>Listening</span>')
    expect(markup).toMatch(
      /class="ml-auto[^"]*\[-webkit-app-region:no-drag\]" data-slot="window-header-actions"><button/
    )
  })
})
