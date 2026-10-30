// @vitest-environment happy-dom
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LivestreamIcon } from '@/components/icons'
import { GroupedList, ListRow } from './list-row'
import { NavigableRow } from './navigable-row'
import { PanelSection } from './panel-section'
import { SectionLabel } from './section-label'
import { Field, FieldDescription, FieldLabel, SettingsRow } from './ui/field'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

// Plan 174 S1.6a: one row, one label, one type scale.

const openingTag = (markup: string, slot: string): string =>
  markup.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0] ?? ''

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element))
}

describe('ListRow (I-7 primitive, A-15)', () => {
  it('is a fact by default: no hover, a div, the chip radius on its icon tile', () => {
    const markup = renderToStaticMarkup(h(ListRow, { icon: h('span'), title: 'Twitch' }))
    const row = openingTag(markup, 'list-row')
    expect(row.startsWith('<div')).toBe(true)
    expect(row).not.toContain('hover:bg-accent')
    expect(openingTag(markup, 'list-row-icon')).toContain('rounded-chip')
    expect(markup).not.toContain('rounded-[5px]')
  })

  it('takes the hover when it acts', () => {
    const row = openingTag(
      renderToStaticMarkup(h(ListRow, { interactive: true, title: 'Pack' })),
      'list-row'
    )
    expect(row).toContain('hover:bg-accent')
  })

  it('renders as one button with the focus ring, and acts on a click', async () => {
    const onClick = vi.fn()
    await render(h(ListRow, { as: 'button', meta: 'Connected', title: 'YouTube', onClick }))
    const button = container.querySelector('button[data-slot="list-row"]') as HTMLButtonElement
    expect(button.type).toBe('button')
    expect(button.className).toContain('hover:bg-accent')
    expect(button.className).toContain('focus-visible:ring-2')
    expect(button.textContent).toBe('YouTubeConnected')
    await act(async () => button.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('GroupedList and SectionLabel', () => {
  it('labels the group with the one section label and forwards attributes to the list', () => {
    const markup = renderToStaticMarkup(
      h(GroupedList, {
        'aria-label': 'Greeting templates',
        children: h(ListRow, { title: 'One' }),
        label: 'Packs'
      })
    )
    const label = openingTag(markup, 'section-label')
    expect(label).toContain('text-label')
    expect(label).toContain('text-subtle')
    const list = openingTag(markup, 'grouped-list')
    expect(list).toContain('aria-label="Greeting templates"')
    expect(list).toContain('bg-inset')
  })

  it('is 11 px / 600 tertiary, as a span or the element asked for', () => {
    const span = renderToStaticMarkup(h(SectionLabel, null, 'Lens'))
    expect(span).toMatch(
      /^<span[^>]*class="text-label font-semibold text-subtle"[^>]*>Lens<\/span>$/
    )
    expect(renderToStaticMarkup(h(SectionLabel, { as: 'h3' }, 'States'))).toMatch(/^<h3/)
  })
})

describe('NavigableRow (B-25)', () => {
  it("has the Session rows' metrics, flush in a group", () => {
    const tag = openingTag(
      renderToStaticMarkup(
        h(NavigableRow, { icon: LivestreamIcon, label: 'Streaming', value: 'Off' })
      ),
      'navigable-row'
    )
    expect(tag.startsWith('<div')).toBe(true)
    for (const metric of ['h-row', 'px-3', 'gap-2.5', 'in-data-[slot=grouped-list]:rounded-none']) {
      expect(tag).toContain(metric)
    }
  })

  it('is a button with the focus ring when it navigates, and keeps its tooltip', async () => {
    const onNavigate = vi.fn()
    await render(h(NavigableRow, { label: 'Buddy', hint: 'Reading chat', value: 'On', onNavigate }))
    const button = container.querySelector('button[data-slot="navigable-row"]') as HTMLElement
    expect(button.className).toContain('focus-visible:ring-2')
    expect(button.className).toContain('hover:bg-accent')
    // The hint is a Tooltip the keyboard reaches, never a native title (S1.10).
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.hasAttribute('data-base-ui-tooltip-trigger')).toBe(true)
    await act(async () => button.click())
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})

describe('PanelSection (A-24)', () => {
  it('heads a section with an h2 under the toolbar, or an h3 when nested', () => {
    expect(renderToStaticMarkup(h(PanelSection, { children: 'x', title: 'Session' }))).toMatch(
      /<h2[^>]*text-section[^>]*>Session<\/h2>/
    )
    expect(
      renderToStaticMarkup(h(PanelSection, { children: 'x', headingLevel: 3, title: 'Nested' }))
    ).toMatch(/<h3[^>]*>Nested<\/h3>/)
  })
})

describe('SettingsRow and FieldDescription (I-7, F-17)', () => {
  it('reads descriptions at 12 px', () => {
    expect(renderToStaticMarkup(h(FieldDescription, null, 'Help'))).toContain('text-meta')
  })

  it('names its control with the label and describes it with the description', async () => {
    await render(
      h(
        SettingsRow,
        { description: 'Shows Stream Manager when you go live.', label: 'Open Stream Manager' },
        h(Switch)
      )
    )
    const row = container.querySelector('[data-slot="field"]') as HTMLElement
    expect(row.dataset.orientation).toBe('horizontal')
    const control = container.querySelector('[role="switch"]') as HTMLElement
    const label = container.querySelector('label') as HTMLLabelElement
    // Base UI points the label at the switch's hidden input and names the
    // switch by the label.
    expect(label.htmlFor).toBe(container.querySelector('input[type="checkbox"]')?.id)
    expect(control.getAttribute('aria-labelledby')).toBe(label.id)
    const describedBy = control.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'Shows Stream Manager when you go live.'
    )
  })

  it('describes any Field control, and an explicit aria-describedby wins', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Width'),
        h(Input),
        h(FieldDescription, null, 'Even numbers only.')
      )
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Even numbers only.'
    )

    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Width'),
        h(Input, { 'aria-describedby': 'own-hint' }),
        h(FieldDescription, null, 'Even numbers only.')
      )
    )
    expect(container.querySelector('input')?.getAttribute('aria-describedby')).toBe('own-hint')
  })

  it('leaves a control outside a Field undescribed', async () => {
    await render(h(Input))
    expect(container.querySelector('input')?.hasAttribute('aria-describedby')).toBe(false)
  })
})
