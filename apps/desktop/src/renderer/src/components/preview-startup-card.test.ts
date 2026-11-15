import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { previewStartupView } from '../../../shared/preview-startup'
import {
  OPEN_SOURCES_LABEL,
  PreviewStartupCard,
  previewStartupSegmentState
} from './preview-startup-card'

const camera = { kind: 'camera' as const, name: 'ZV-E10M2', live: false }

function render(view: ReturnType<typeof previewStartupView>, onOpenSources?: () => void): string {
  return renderToStaticMarkup(createElement(PreviewStartupCard, { view, onOpenSources }))
}

describe('previewStartupSegmentState', () => {
  it('marks finished, running and coming steps', () => {
    const view = { step: 2 as const, stalled: false }
    expect(previewStartupSegmentState(1, view)).toBe('done')
    expect(previewStartupSegmentState(2, view)).toBe('current')
    expect(previewStartupSegmentState(3, view)).toBe('next')
    expect(previewStartupSegmentState(2, { step: 2, stalled: true })).toBe('stalled')
  })
})

describe('PreviewStartupCard', () => {
  it('shows the title, the step in words and three segments', () => {
    const html = render(
      previewStartupView({ engineConnected: true, sources: [camera], stalled: false })
    )
    expect(html).toContain('Starting the preview')
    expect(html).toContain('Connecting ZV-E10M2')
    expect(html).toContain('Step 2 of 3')
    expect(html.match(/data-preview-startup-segment="done"/g)).toHaveLength(1)
    expect(html.match(/data-preview-startup-segment="current"/g)).toHaveLength(1)
    expect(html.match(/data-preview-startup-segment="next"/g)).toHaveLength(1)
    // The stage is dark in both themes, so the card scopes the dark tokens.
    expect(html).toMatch(/class="dark /)
    expect(html).not.toContain(OPEN_SOURCES_LABEL)
  })

  it('offers Open Sources when a source is stuck', () => {
    const view = previewStartupView({ engineConnected: true, sources: [camera], stalled: true })
    const html = render(view, () => {})
    expect(html).toContain('ZV-E10M2 hasn’t sent a picture yet.')
    expect(html).toContain('data-preview-startup-segment="stalled"')
    expect(html).toContain(OPEN_SOURCES_LABEL)
    // Without a way to open Sources the card names the problem only.
    expect(render(view)).not.toContain(OPEN_SOURCES_LABEL)
  })
})
