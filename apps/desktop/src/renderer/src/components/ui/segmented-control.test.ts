// @vitest-environment happy-dom
import { act, createElement as h, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Field, FieldLabel } from './field'
import {
  SegmentedControl,
  segmentedTabStop,
  segmentedTargetIndex,
  type SegmentedControlOption,
  type SegmentedControlProps
} from './segmented-control'

// Plan 174 S1.7 (J1-7, D13): one segmented control, a radio group with roving
// focus, named by its Field, and never disabled without saying why.

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

const THEMES: SegmentedControlOption<'light' | 'dark' | 'system'>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
]

type Theme = 'light' | 'dark' | 'system'

/** A controlled control that records every change it is asked to make. */
function Controlled({
  initial,
  changes,
  ...props
}: Omit<SegmentedControlProps<Theme>, 'value' | 'onValueChange'> & {
  initial: Theme | null
  changes: Theme[]
}): ReactElement {
  const [value, setValue] = useState<Theme | null>(initial)
  return h(SegmentedControl<Theme>, {
    ...props,
    value,
    onValueChange: (next: Theme) => {
      changes.push(next)
      setValue(next)
    }
  })
}

function group(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[role="radiogroup"]')
  expect(element).toBeTruthy()
  return element!
}

function radios(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
}

function radio(label: string): HTMLButtonElement {
  const found = radios().find((candidate) => candidate.textContent === label)
  expect(found, label).toBeTruthy()
  return found!
}

function checkedLabels(): string[] {
  return radios()
    .filter((candidate) => candidate.getAttribute('aria-checked') === 'true')
    .map((candidate) => candidate.textContent ?? '')
}

function tabStops(): string[] {
  return radios()
    .filter((candidate) => candidate.tabIndex === 0)
    .map((candidate) => candidate.textContent ?? '')
}

async function press(key: string): Promise<void> {
  const target = document.activeElement
  expect(target?.getAttribute('role')).toBe('radio')
  await act(async () => {
    target!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function focused(): string {
  return document.activeElement?.textContent ?? ''
}

describe('SegmentedControl', () => {
  it('is a radio group with one checked radio and one tab stop', async () => {
    await render(
      h(Controlled, { 'aria-label': 'Theme', changes: [], initial: 'dark', options: THEMES })
    )
    expect(group().getAttribute('data-slot')).toBe('segmented-control')
    expect(radios()).toHaveLength(3)
    expect(checkedLabels()).toEqual(['Dark'])
    expect(radio('Dark').getAttribute('data-state')).toBe('on')
    expect(radio('Light').getAttribute('data-state')).toBe('off')
    expect(tabStops()).toEqual(['Dark'])
    for (const candidate of radios()) expect(candidate.type).toBe('button')
  })

  it('wears the Tabs track, with the checked segment as the chrome plate', async () => {
    await render(
      h(Controlled, { 'aria-label': 'Theme', changes: [], initial: 'dark', options: THEMES })
    )
    expect(group().className).toContain('ring-border')
    expect(group().className).toContain('rounded-row')
    expect(radio('Dark').className).toContain('aria-checked:chrome-plate')
  })

  it('lets Tab reach the first enabled option when nothing is checked', async () => {
    await render(
      h(Controlled, {
        'aria-label': 'Corner',
        changes: [],
        initial: null,
        options: [{ value: 'light', label: 'Light', disabled: true }, ...THEMES.slice(1)]
      })
    )
    expect(checkedLabels()).toEqual([])
    expect(tabStops()).toEqual(['Dark'])
  })

  it('moves and checks with the arrows, Home and End, wrapping and skipping disabled options', async () => {
    const changes: Theme[] = []
    await render(
      h(Controlled, {
        'aria-label': 'Theme',
        changes,
        initial: 'light',
        options: [THEMES[0], { ...THEMES[1], disabled: true }, THEMES[2]]
      })
    )
    radio('Light').focus()
    await press('ArrowRight')
    expect(focused()).toBe('System')
    expect(checkedLabels()).toEqual(['System'])
    await press('ArrowRight')
    expect(focused()).toBe('Light')
    await press('ArrowLeft')
    expect(focused()).toBe('System')
    await press('Home')
    expect(focused()).toBe('Light')
    await press('End')
    expect(focused()).toBe('System')
    await press('ArrowUp')
    expect(focused()).toBe('Light')
    await press('ArrowDown')
    expect(focused()).toBe('System')
    expect(changes).toEqual(['system', 'light', 'system', 'light', 'system', 'light', 'system'])
    expect(tabStops()).toEqual(['System'])
  })

  it('in manual activation, only moves focus until Space or a click checks', async () => {
    const changes: Theme[] = []
    await render(
      h(Controlled, {
        activationMode: 'manual',
        'aria-label': 'Theme',
        changes,
        initial: 'light',
        options: THEMES
      })
    )
    radio('Light').focus()
    await press('ArrowRight')
    expect(focused()).toBe('Dark')
    expect(changes).toEqual([])
    expect(checkedLabels()).toEqual(['Light'])
    await act(async () => radio('Dark').click())
    expect(changes).toEqual(['dark'])
    expect(checkedLabels()).toEqual(['Dark'])
  })

  it('never reports the value that is already checked', async () => {
    const changes: Theme[] = []
    await render(
      h(Controlled, { 'aria-label': 'Theme', changes, initial: 'dark', options: THEMES })
    )
    await act(async () => radio('Dark').click())
    expect(changes).toEqual([])
    await act(async () => radio('Light').click())
    expect(changes).toEqual(['light'])
  })

  it('leaves other keys and modified arrows alone', async () => {
    const changes: Theme[] = []
    await render(
      h(Controlled, { 'aria-label': 'Theme', changes, initial: 'dark', options: THEMES })
    )
    radio('Dark').focus()
    await press('a')
    await act(async () => {
      radio('Dark').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true })
      )
    })
    expect(focused()).toBe('Dark')
    expect(changes).toEqual([])
  })

  it('is named by its Field label, unless it names itself', async () => {
    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Theme'),
        h(Controlled, { changes: [], initial: 'dark', options: THEMES })
      )
    )
    const label = container.querySelector<HTMLLabelElement>('[data-slot="field-label"]')!
    expect(label.id).not.toBe('')
    expect(group().getAttribute('aria-labelledby')).toBe(label.id)
    expect(label.hasAttribute('for')).toBe(false)

    await render(
      h(
        Field,
        null,
        h(FieldLabel, null, 'Snap'),
        h(Controlled, {
          'aria-label': 'Theme choice',
          changes: [],
          initial: 'dark',
          options: THEMES
        })
      )
    )
    expect(group().hasAttribute('aria-labelledby')).toBe(false)
    expect(group().getAttribute('aria-label')).toBe('Theme choice')
  })

  it('names an icon option by its aria-label and passes its data attributes', async () => {
    await render(
      h(SegmentedControl<'h' | 'v'>, {
        'aria-label': 'Orientation',
        options: [
          {
            value: 'h',
            label: h('svg'),
            'aria-label': 'Horizontal',
            'data-orientation-option': 'h'
          },
          { value: 'v', label: h('svg'), 'aria-label': 'Vertical', 'data-orientation-option': 'v' }
        ],
        value: 'v',
        onValueChange: () => undefined
      })
    )
    const vertical = container.querySelector('[data-orientation-option="v"]')!
    expect(vertical.getAttribute('aria-label')).toBe('Vertical')
    expect(vertical.getAttribute('aria-checked')).toBe('true')
  })

  it('names an icon option on hover and focus with a tooltip, never a title (S1.10)', async () => {
    await render(
      h(SegmentedControl<'h' | 'v'>, {
        'aria-label': 'Orientation',
        options: [
          { value: 'h', label: h('svg'), 'aria-label': 'Horizontal', tooltip: 'Horizontal · 16:9' },
          { value: 'v', label: h('svg'), 'aria-label': 'Vertical', tooltip: 'Vertical · 9:16' }
        ],
        value: 'v',
        onValueChange: () => undefined
      })
    )
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios).toHaveLength(2)
    // The segment keeps its own on/off state under the tooltip trigger.
    expect(radios.map((radio) => radio.dataset.state)).toEqual(['off', 'on'])
    expect(radios.some((radio) => radio.hasAttribute('title'))).toBe(false)
    expect(radios[0].hasAttribute('tooltip')).toBe(false)
    await act(async () => radios[1].focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'Vertical · 9:16'
    )
  })

  it('says why it is disabled, and describes the group with the reason', async () => {
    const reason = 'The canvas is fixed while you record or stream.'
    const changes: Theme[] = []
    await render(
      h(Controlled, {
        'aria-label': 'Theme',
        changes,
        disabled: true,
        disabledReason: reason,
        initial: 'dark',
        options: THEMES
      })
    )
    for (const candidate of radios()) expect(candidate.disabled).toBe(true)
    expect(group().getAttribute('aria-disabled')).toBe('true')
    const describedBy = group().getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe(reason)
    expect(container.textContent).toContain(reason)
    await act(async () => radio('Light').click())
    expect(changes).toEqual([])
    expect(checkedLabels()).toEqual(['Dark'])
  })

  it('shows no reason while enabled', async () => {
    await render(
      h(Controlled, {
        'aria-label': 'Theme',
        changes: [],
        disabledReason: 'Locked while live.',
        initial: 'dark',
        options: THEMES
      })
    )
    expect(container.textContent).not.toContain('Locked while live.')
    expect(group().hasAttribute('aria-describedby')).toBe(false)
    expect(group().hasAttribute('aria-disabled')).toBe(false)
  })
})

describe('segmented keyboard targets', () => {
  it('wraps, skips disabled options and ignores other keys', () => {
    const enabled = [true, false, true, true]
    expect(segmentedTargetIndex(enabled, 0, 'ArrowRight')).toBe(2)
    expect(segmentedTargetIndex(enabled, 3, 'ArrowRight')).toBe(0)
    expect(segmentedTargetIndex(enabled, 0, 'ArrowLeft')).toBe(3)
    expect(segmentedTargetIndex(enabled, 2, 'ArrowUp')).toBe(0)
    expect(segmentedTargetIndex(enabled, 2, 'Home')).toBe(0)
    expect(segmentedTargetIndex(enabled, 0, 'End')).toBe(3)
    expect(segmentedTargetIndex(enabled, 0, 'Enter')).toBeNull()
    expect(segmentedTargetIndex([false, false], 0, 'ArrowRight')).toBeNull()
  })

  it('puts the tab stop on the checked option, else the first enabled one', () => {
    expect(segmentedTabStop([true, true, true], 1)).toBe(1)
    expect(segmentedTabStop([true, true, true], -1)).toBe(0)
    expect(segmentedTabStop([false, true, true], 0)).toBe(1)
    expect(segmentedTabStop([false, false], -1)).toBe(-1)
  })
})
