// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldGroup } from '@/components/ui/field'

import { ShortcutRecorderField } from './shortcut-recorder'

// Plan 174 S3.17 (I-7, I-17): the recorder is one SettingsRow, its name
// carries the binding it holds, and a refusal is announced.

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onChange.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(value: string | undefined, registrationFailed = false): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        FieldGroup,
        { variant: 'grouped' },
        createElement(ShortcutRecorderField, {
          id: 'global-shortcut-clip-mark',
          label: 'Mark a clip',
          value,
          platform: 'darwin',
          validate: () => null,
          onChange,
          registrationFailed
        })
      )
    )
  )
}

const recorder = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('#global-shortcut-clip-mark')!

describe('ShortcutRecorderField', () => {
  it('is a settings row whose label points at the recorder', async () => {
    await render('Cmd+Shift+M')
    expect(container.querySelector('[data-settings-row]')).not.toBeNull()
    expect(container.querySelector('label')?.getAttribute('for')).toBe('global-shortcut-clip-mark')
  })

  it('names the binding it holds', async () => {
    await render('Cmd+Shift+M')
    expect(recorder().getAttribute('aria-label')).toBe('Mark a clip: ⇧⌘M')
    await render(undefined)
    expect(recorder().getAttribute('aria-label')).toBe('Mark a clip: Unassigned')
  })

  it("announces a refusal, and never binds Videorc's own key", async () => {
    await render(undefined)
    await act(async () => recorder().click())
    expect(recorder().getAttribute('aria-label')).toBe('Mark a clip: press the new shortcut')
    await act(async () =>
      recorder().dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, code: 'KeyK', key: 'k', metaKey: true })
      )
    )
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe("⌘K is Videorc's shortcut for “Search”. Pick another.")
    expect(onChange).not.toHaveBeenCalled()
  })

  it('says when another app owns the binding', async () => {
    await render('Cmd+Shift+M', true)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Another app already uses this shortcut. Pick another.'
    )
    expect(recorder().getAttribute('aria-invalid')).toBe('true')
  })
})
