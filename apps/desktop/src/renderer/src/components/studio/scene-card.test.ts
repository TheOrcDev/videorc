// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { SceneCard, SceneGalleryReason } from './scene-card'

// Plan 174 S3.3 (B-20, V-4) and plan 231 S6: one card for every scene, one
// structure (picture, name row, meta row) at fixed heights, and one selected
// look that reads in both themes.

const noop = (): void => {}

function props(extra: Partial<Parameters<typeof SceneCard>[0]> = {}) {
  return {
    label: 'Screen + camera',
    thumb: createElement('div', { 'data-thumb': '' }),
    onSelect: noop,
    ...extra
  }
}

function render(extra: Partial<Parameters<typeof SceneCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, { children: createElement(SceneCard, props(extra)) })
  )
}

const slot = (markup: string, name: string): string | undefined =>
  new RegExp(`<span class="([^"]*)"[^>]*data-slot="${name}"`).exec(markup)?.[1]

describe('SceneCard', () => {
  it('is a MediaCard whose button holds the picture, the name and the meta row', () => {
    const markup = render({ meta: 'Front window', keys: createElement('kbd', null, '⌃⌥1') })
    expect(markup).toContain('data-slot="media-card"')
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-slot="scene-card-button"/)
    const order = ['data-thumb', 'Screen + camera', 'Front window', '⌃⌥1'].map((part) =>
      markup.indexOf(part)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('keeps every card the same: a one-line name and a meta row at fixed heights', () => {
    const markup = render({ meta: "Figma isn't open", keys: createElement('kbd', null, '⌃⌥1') })
    // One line, cut with "…" (the whole name on hover), never broken inside a word.
    expect(slot(markup, 'scene-card-label')).toContain('truncate')
    expect(slot(markup, 'scene-card-label')).not.toContain('line-clamp')
    expect(slot(markup, 'scene-card-name')).toContain('h-5')
    expect(slot(markup, 'scene-card-meta')).toContain('h-5')
    // The keys close the meta row, so chips line up from card to card.
    const meta = /data-slot="scene-card-meta"[\s\S]*?<\/span><\/span>/.exec(markup)?.[0]
    expect(meta?.indexOf('Figma isn')).toBeLessThan(meta!.indexOf('⌃⌥1'))
  })

  it('first-run setup wraps a long name to two lines instead (#1083)', () => {
    const markup = render({ size: 'sm' })
    expect(slot(markup, 'scene-card-label')).toContain('line-clamp-2')
    expect(markup).not.toContain('data-slot="scene-card-meta"')
  })

  it('marks the scene in use beyond its check: the plate, a ring and aria-pressed', () => {
    const markup = render({ selected: true })
    expect(markup).toContain('data-selected="true"')
    expect(markup).toContain('aria-pressed="true"')
    // A ring in the text's own tone: as plain in light as in dark.
    expect(slot(markup, 'scene-card-thumb')).toContain('outline-foreground')
    expect(slot(render(), 'scene-card-thumb')).not.toContain('outline')
    expect(markup).not.toContain('Applied')
    expect(render()).not.toContain('scene-card-check')
  })

  it('puts the check at the end of the name row, where the ⋯ shows on hover', () => {
    const markup = render({
      selected: true,
      menu: createElement('button', { 'aria-label': 'Actions' })
    })
    const name = /data-slot="scene-card-name"[\s\S]*?<\/span><\/span>/.exec(markup)?.[0]
    expect(name).toContain('data-testid="scene-card-check"')
    expect(markup).toMatch(
      /group-hover\/kebab-host:opacity-0[^"]*"[^>]*data-testid="scene-card-check"/
    )
    // Without a menu the check stays put.
    expect(render({ selected: true })).not.toContain('group-hover/kebab-host:opacity-0')
  })

  it('puts the menu beside the button, never inside it', () => {
    const markup = render({ menu: createElement('button', { 'aria-label': 'Actions' }) })
    const button = /<button[^>]*data-slot="scene-card-button"[\s\S]*?<\/button>/.exec(markup)?.[0]
    expect(button).not.toContain('Actions')
    expect(markup).toContain('aria-label="Actions"')
  })

  it("describes a disabled card's own reason, and only while disabled", () => {
    const reason = 'Figma has no window open'
    const disabled = render({ disabled: true, disabledReason: reason, meta: reason })
    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain(reason)
    // The reason in the meta row is essential: never dimmed with the card.
    expect(slot(disabled, 'scene-card-meta')).not.toContain('opacity')
    expect(slot(disabled, 'scene-card-thumb')).toContain('opacity-50')
    expect(render({ disabledReason: reason })).not.toContain(reason)
  })
})

describe('SceneCard: the whole name when the line cuts it', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function mount(cut: boolean): Promise<HTMLButtonElement> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    // happy-dom lays nothing out: the name's line is 100 px, its text 118 when cut.
    const width = (element: HTMLElement, scroll: boolean): number =>
      element.dataset.slot === 'scene-card-label' && scroll && cut ? 118 : 100
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return width(this, false)
    })
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return width(this, true)
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root!.render(
        createElement(TooltipProvider, {
          delay: 0,
          children: createElement(SceneCard, props({ label: 'T3 Code (Nightly)' }))
        })
      )
    )
    return container.querySelector<HTMLButtonElement>('[data-slot="scene-card-button"]')!
  }

  it('shows it in a tooltip on focus only when it was cut', async () => {
    const cut = await mount(true)
    await act(async () => cut.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe(
      'T3 Code (Nightly)'
    )
    await act(async () => root!.unmount())
    container!.remove()
    document.body.innerHTML = ''
    vi.restoreAllMocks()

    const whole = await mount(false)
    await act(async () => whole.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
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
