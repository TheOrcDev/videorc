import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { SceneCard, SceneGalleryReason } from './scene-card'

// Plan 174 S3.3 (B-20, V-4): one card for built-in, saved and vertical-stream
// scenes, one selected marker, and names that wrap instead of "Screen …".

const noop = (): void => {}

function render(props: Partial<Parameters<typeof SceneCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(SceneCard, {
        label: 'Screen + camera',
        thumb: createElement('div', { 'data-thumb': '' }),
        onSelect: noop,
        ...props
      })
    })
  )
}

describe('SceneCard', () => {
  it('is a MediaCard whose button holds the picture and the name', () => {
    const markup = render()
    expect(markup).toContain('data-slot="media-card"')
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-slot="scene-card-button"/)
    expect(markup.indexOf('data-thumb')).toBeLessThan(markup.indexOf('Screen + camera'))
  })

  it('wraps a long name to two lines instead of cutting it (V-4)', () => {
    const label = /<span class="([^"]*)" data-slot="scene-card-label"/.exec(render())?.[1]
    expect(label).toContain('line-clamp-2')
    expect(label).not.toContain('truncate')
  })

  it('marks the scene in use one way: the selected look, a check and aria-pressed', () => {
    const markup = render({ selected: true })
    expect(markup).toContain('data-selected="true"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('<svg')
    expect(markup).not.toContain('Applied')
    expect(render()).not.toContain('<svg')
  })

  it('keeps the choice apart from what is shown in use when they differ', () => {
    const markup = render({ selected: false, pressed: true })
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('data-selected')
  })

  it('puts the menu beside the button, never inside it', () => {
    const markup = render({ menu: createElement('button', { 'aria-label': 'Actions' }) })
    const button = /<button[^>]*data-slot="scene-card-button"[\s\S]*?<\/button>/.exec(markup)?.[0]
    expect(button).not.toContain('Actions')
    expect(markup).toContain('aria-label="Actions"')
  })

  it("describes a disabled card's own reason, and only while disabled", () => {
    const reason = 'Stop the recording or stream before switching orientation.'
    const disabled = render({ disabled: true, disabledReason: reason })
    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain(reason)
    expect(render({ disabledReason: reason })).not.toContain(reason)
  })
})

describe('SceneGalleryReason', () => {
  it('renders the one line with its action, and nothing when every scene works', () => {
    expect(renderToStaticMarkup(createElement(SceneGalleryReason, { reason: null }))).toBe('')
    const markup = renderToStaticMarkup(
      createElement(SceneGalleryReason, {
        reason: 'Camera is off. Choose one in Sources to use Camera only.',
        action: createElement('button', null, 'Open Sources')
      })
    )
    expect(markup).toContain('data-slot="scene-gallery-reason"')
    expect(markup).toContain('Camera is off.')
    expect(markup).toContain('Open Sources')
  })
})
