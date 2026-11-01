// @vitest-environment happy-dom
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Checkbox } from './checkbox'
import { Field, FieldLabel } from './field'
import { Input } from './input'
import { Select, SelectTrigger, SelectValue } from './select'
import { Switch } from './switch'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import { Textarea } from './textarea'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

// Plan 174 S0.5 (J1-1): fifteen Fields drew a label no screen reader tied to
// its control. A Field now names what it holds.

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

function find(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  expect(element, selector).toBeTruthy()
  return element!
}

function fieldLabel(): HTMLLabelElement {
  return find('[data-slot="field-label"]') as HTMLLabelElement
}

/** The name a screen reader reads for `element`, from whatever names it. */
function nameOf(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    return labelledBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
  }
  const label = element.getAttribute('aria-label')
  if (label) return label
  return [...container.querySelectorAll('label')]
    .filter((candidate) => candidate.htmlFor !== '' && candidate.htmlFor === element.id)
    .map((candidate) => candidate.textContent ?? '')
    .join(' ')
}

describe('Field names its control (plan 174 S0.5)', () => {
  it.each([
    ['Input', () => h(Input), 'input'],
    ['Textarea', () => h(Textarea), 'textarea'],
    [
      'SelectTrigger',
      () => h(Select, null, h(SelectTrigger, null, h(SelectValue))),
      '[data-slot="select-trigger"]'
    ]
  ])('points its FieldLabel at a %s', async (_name, control, selector) => {
    await render(h(Field, null, h(FieldLabel, null, 'Default privacy'), control()))
    const element = find(selector)
    expect(element.id).not.toBe('')
    expect(fieldLabel().htmlFor).toBe(element.id)
    expect(nameOf(element)).toBe('Default privacy')
  })

  it.each([
    ['Switch', () => h(Switch), '[role="switch"]'],
    ['Checkbox', () => h(Checkbox), '[role="checkbox"]']
  ])("names a %s through Base UI's hidden input", async (_name, control, selector) => {
    await render(h(Field, null, h(FieldLabel, null, 'Made for kids'), control()))
    const input = find('input[type="checkbox"]')
    // The label points at the hidden input, so a click on it toggles…
    expect(input.id).not.toBe('')
    expect(fieldLabel().htmlFor).toBe(input.id)
    // …and Base UI names the visible control by that label.
    expect(nameOf(find(selector))).toBe('Made for kids')
  })

  it('keeps an explicit id and htmlFor, and follows an explicit id', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, { htmlFor: 'stream-title' }, 'Title'),
        h(Input, { id: 'stream-title' })
      )
    )
    expect(find('input').id).toBe('stream-title')
    expect(fieldLabel().htmlFor).toBe('stream-title')

    await render(h(Field, null, h(FieldLabel, null, 'Width'), h(Input, { id: 'output-width' })))
    expect(fieldLabel().htmlFor).toBe('output-width')
  })

  it('gives two controls two ids and names the first', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Category'),
        h(Input),
        h(Select, null, h(SelectTrigger, { 'aria-label': 'Matching categories' }, h(SelectValue)))
      )
    )
    const input = find('input')
    const trigger = find('[data-slot="select-trigger"]')
    expect(input.id).not.toBe(trigger.id)
    expect(fieldLabel().htmlFor).toBe(input.id)
    expect(nameOf(trigger)).toBe('Matching categories')
  })

  it('names a ToggleGroup and a TabsList through aria-labelledby, with no dangling htmlFor', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Theme'),
        h(
          ToggleGroup,
          { value: ['dark'] },
          h(ToggleGroupItem, { value: 'light' }, 'Light'),
          h(ToggleGroupItem, { value: 'dark' }, 'Dark')
        )
      )
    )
    const group = find('[data-slot="toggle-group"]')
    expect(group.getAttribute('aria-labelledby')).toBe(fieldLabel().id)
    expect(nameOf(group)).toBe('Theme')
    expect(fieldLabel().hasAttribute('for')).toBe(false)

    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Connect with'),
        h(
          Tabs,
          { value: 'oauth' },
          h(TabsList, null, h(TabsTrigger, { value: 'oauth' }, 'Sign in'))
        )
      )
    )
    expect(nameOf(find('[data-slot="tabs-list"]'))).toBe('Connect with')
  })

  it('lets a group that names itself keep its own name', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Snap (landscape)'),
        h(
          ToggleGroup,
          { 'aria-label': 'Snap overlay' },
          h(ToggleGroupItem, { value: 'top-left' }, 'Top left')
        )
      )
    )
    const group = find('[data-slot="toggle-group"]')
    expect(group.hasAttribute('aria-labelledby')).toBe(false)
    expect(nameOf(group)).toBe('Snap overlay')
  })

  it('drops htmlFor when the control leaves, and touches nothing outside a Field', async () => {
    const field = (withInput: boolean): ReactElement =>
      h(Field, null, h(FieldLabel, null, 'Width'), withInput ? h(Input) : null)
    await render(field(true))
    expect(fieldLabel().htmlFor).toBe(find('input').id)
    await render(field(false))
    expect(fieldLabel().hasAttribute('for')).toBe(false)

    await render(h('div', null, h(FieldLabel, null, 'Loose'), h(Input), h(Switch)))
    expect(fieldLabel().hasAttribute('for')).toBe(false)
    expect(fieldLabel().hasAttribute('id')).toBe(false)
    // Base UI's Input and Switch carry ids of their own; the Field wiring adds none.
    expect(find('input').id).toMatch(/^base-ui-/)
    expect(find('[role="switch"]').id).toMatch(/^base-ui-/)
  })
})
