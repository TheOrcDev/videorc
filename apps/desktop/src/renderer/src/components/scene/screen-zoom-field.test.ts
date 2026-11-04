import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ScreenZoomField } from './screen-zoom-field'

// Plan 215 E4 (D2): the screen's Zoom slider in Freeform.

function render(transform: { x: number; y: number; width: number; height: number }): string {
  return renderToStaticMarkup(
    createElement(ScreenZoomField, {
      source: {
        id: 'source:base',
        transform: { ...transform, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }
      },
      onCommit: () => {}
    })
  )
}

describe('ScreenZoomField', () => {
  it('runs 100 to 400 percent, reads the box, and says what zooming does', () => {
    const markup = render({ x: -0.25, y: -0.25, width: 1.5, height: 1.5 })
    expect(markup).toContain('Zoom')
    // Base UI's thumb is a range input: the slider's bounds and value.
    expect(markup).toContain('min="100"')
    expect(markup).toContain('max="400"')
    expect(markup).toContain('aria-valuenow="150"')
    expect(markup).toContain('Zooming softens text. Crop to show part of the screen sharply.')
  })

  it('reads 100 for a box within the canvas', () => {
    expect(render({ x: 0, y: 0, width: 1, height: 1 })).toContain('aria-valuenow="100"')
  })
})
