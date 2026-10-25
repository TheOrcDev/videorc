// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@/lib/backend'
import { DevicePicker, type DevicePickerProps } from './device-picker'

type Props = Omit<DevicePickerProps, 'onChange'>

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const devices: Device[] = [
  { id: 'screen', name: 'Display', kind: 'screen', status: 'available' },
  { id: 'window-a', name: 'Café 東京', detail: 'Safari', kind: 'window', status: 'available' },
  { id: 'window-b', name: 'Café 東京', detail: 'Editor', kind: 'window', status: 'available' },
  {
    id: 'locked',
    name: 'Private',
    detail: 'ScreenCaptureKit window discovery failed: denied',
    kind: 'window',
    status: 'permission-required'
  }
]
const cameras: Device[] = [
  { id: 'cam-1', name: 'FaceTime HD Camera', kind: 'camera', status: 'available' },
  { id: 'cam-2', name: 'Desk Camera', kind: 'camera', status: 'available' },
  { id: 'cam-3', name: 'Cam Link 4K', kind: 'camera', status: 'unavailable' }
]
async function render(list = devices, value: string | undefined = 'screen'): Promise<void> {
  await renderPicker({
    kind: 'capture',
    label: 'Screen / window',
    devices: list,
    value,
    searchable: true,
    groupByKind: true,
    noneLabel: 'None'
  })
}
async function renderPicker(props: Props): Promise<void> {
  await act(async () => root.render(createElement(DevicePicker, { ...props, onChange })))
}
function markup(props: Props): string {
  return renderToStaticMarkup(createElement(DevicePicker, { ...props, onChange }))
}
async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => (element as HTMLElement).click())
}
async function key(element: Element, name: string): Promise<void> {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  )
}
async function search(value: string): Promise<void> {
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const option = (value: string): Element | null =>
  document.querySelector(`[cmdk-item][data-value="${value}"]`)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onChange.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('searchable device picker', () => {
  it('selects the correct duplicate-name ID and keeps None available through filtering', async () => {
    await render()
    await click(container.querySelector('button'))
    const trigger = container.querySelector('button')!
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('input'))
    await search('editor 東京')
    expect(option('window-a')).toBeNull()
    expect(option('__none__')).not.toBeNull()
    expect(container.textContent).toContain('Display')
    await click(option('window-b'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('window-b')
  })
  it('dismisses with Escape without changing selection, returns focus and clears the query', async () => {
    await render()
    const trigger = container.querySelector('button')!
    await click(trigger)
    await search('nothing matches')
    expect(document.body.textContent).toContain('No matching screens or windows')
    await key(document.querySelector('input')!, 'Escape')
    expect(onChange).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    await click(trigger)
    expect(document.querySelector('input')!.value).toBe('')
  })
  it('disables unavailable entries and handles disappearance while searching', async () => {
    await render()
    await click(container.querySelector('button'))
    expect(option('locked')?.getAttribute('aria-disabled')).toBe('true')
    await search('café')
    await render([devices[0]], 'window-a')
    expect(container.textContent).toContain('Saved screen or window')
    expect(container.textContent).toContain('Not found')
    expect(document.body.textContent).toContain('No matching screens or windows')
    expect(onChange).not.toHaveBeenCalled()
    await click(option('__none__'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })
  it('uses the command keyboard navigation to select a filtered source', async () => {
    await render()
    await click(container.querySelector('button'))
    await search('editor')
    const input = document.querySelector('input')!
    await key(input, 'ArrowDown')
    await key(input, 'Enter')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('window-b')
  })
  it('names a status in words after the device, never the raw status or detail', async () => {
    await render()
    await click(container.querySelector('button'))
    expect(option('locked')?.textContent).toBe('PrivateNeeds permission')
    expect(document.body.textContent).not.toContain('permission-required')
    expect(document.body.textContent).not.toContain('ScreenCaptureKit')
    expect(document.body.textContent).not.toContain('Safari')
    // Screens and windows keep their own headings.
    expect(document.body.textContent).toContain('Screens')
    expect(document.body.textContent).toContain('Windows')
  })
  it('shows one status line while discovery runs, not two', async () => {
    await renderPicker({
      kind: 'capture',
      label: 'Screen / window',
      devices: [],
      value: undefined,
      searchable: true,
      noneLabel: 'None',
      discoveryPending: true
    })
    const trigger = container.querySelector('button')!
    expect(trigger.textContent).toBe('Finding screens and windows…')
    await click(trigger)
    const lines = [...document.querySelectorAll('[role="status"]')].map((line) => line.textContent)
    expect(lines).toEqual(['Finding screens and windows…'])
  })
})

describe('device picker without search', () => {
  const camera = (value: string | undefined, extra: Partial<Props> = {}): Props => ({
    kind: 'camera',
    label: 'Camera',
    devices: cameras,
    value,
    noneLabel: 'Off',
    ...extra
  })

  it('opens a list at the menu row height and focuses it for the keys', async () => {
    await renderPicker(camera('cam-1'))
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    await click(trigger)
    expect(document.querySelector('input')).toBeNull()
    const list = document.querySelector('[cmdk-list]')!
    expect(document.activeElement).toBe(list)
    expect(list.getAttribute('aria-label')).toBe('Camera')
    expect(option('cam-1')?.className).toContain('min-h-7')
    // The highlight starts on the current choice.
    expect(option('cam-1')?.getAttribute('aria-selected')).toBe('true')
    await key(list, 'ArrowDown')
    await key(list, 'Enter')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('cam-2')
  })

  it('turns the camera Off through its none item', async () => {
    await renderPicker(camera('cam-1'))
    await click(container.querySelector('button'))
    expect(option('__none__')?.textContent).toBe('Off')
    expect(option('cam-3')?.textContent).toBe('Cam Link 4KUnavailable')
    expect(option('cam-3')?.getAttribute('aria-disabled')).toBe('true')
    await click(option('__none__'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('says Finding or none found instead of Off, and Off once cameras are listed', () => {
    expect(markup(camera(undefined, { discoveryPending: true }))).toContain('Finding cameras…')
    expect(markup(camera(undefined, { devices: [] }))).toContain('No cameras found')
    expect(markup(camera(undefined))).toContain('>Off</span>')
  })

  it('keeps a saved camera by name and calls it Not found once discovery reported', () => {
    const missing = camera('cam-gone', { selectedName: 'Old Webcam' })
    expect(markup(missing)).toContain('>Old Webcam</span>')
    expect(markup(missing)).toContain('Not found')
    expect(markup({ ...missing, discoveryPending: true })).not.toContain('Not found')
  })

  it('a field trigger keeps its label for screen readers, an inline one is the row value', () => {
    const field = markup(camera('cam-1', { labelHidden: true }))
    const label = /<label[^>]*>Camera</.exec(field)?.[0] ?? ''
    expect(label).toContain('sr-only')
    const target = /for="([^"]+)"/.exec(label)?.[1]
    expect(target).toBeTruthy()
    expect(field).toMatch(new RegExp(`<button[^>]*id="${target}"`))
    const inline = markup(camera('cam-1', { trigger: 'inline' }))
    expect(inline).not.toContain('<label')
    expect(inline).toContain('title="FaceTime HD Camera"')
    expect(inline).toContain('justify-end')
  })

  it('an LCD trigger is a row on the screen: its label, the lit value and a pixel chevron (plan 197)', () => {
    const lcd = markup(camera('cam-1', { trigger: 'lcd', rowLabel: 'Cam' }))
    // The row's own label names the dropdown for a click; the name stays Camera.
    expect(lcd).toContain('data-slot="lcd-display-row"')
    const target = /<label[^>]*for="([^"]+)"[^>]*>Cam<\/label>/.exec(lcd)?.[1]
    expect(target).toBeTruthy()
    const trigger = new RegExp(`<button[^>]*id="${target}"[^>]*>`).exec(lcd)?.[0] ?? ''
    expect(trigger).toContain('aria-label="Camera"')
    expect(trigger).toContain('role="combobox"')
    expect(trigger).toContain('text-(--lcd-display-lit)')
    expect(lcd).toContain('title="FaceTime HD Camera"')
    expect(lcd).toContain('viewBox="0 0 5 3"')
    // A device that cannot run says so in the dim ink after its name.
    const missing = markup(camera('cam-gone', { trigger: 'lcd', selectedName: 'Old Webcam' }))
    expect(missing).toMatch(/class="shrink-0 text-\(--lcd-display-ink-dim\)">Not found</)
  })

  it('opens the LCD list as a small screen in the opaque popup (plan 197)', async () => {
    await renderPicker(camera('cam-1', { trigger: 'lcd' }))
    await click(container.querySelector('button[role=combobox]'))
    const popup = document.querySelector('[data-slot="popover-content"]')!
    // The popup is the app's opaque float; the screen inside keeps its own
    // opaque glass, never the see-through one of the inspector's screens.
    expect(popup.className).toContain('glass-float')
    const screen = popup.querySelector('[data-slot="lcd-display"]')!
    expect(screen.className).not.toContain('--glass-solid')
    expect(screen.querySelector('[cmdk-list]')).not.toBeNull()
    expect(option('cam-1')?.className).toContain('data-[checked=true]:text-(--lcd-display-lit)')
    expect(option('cam-1')?.getAttribute('data-checked')).toBe('true')
    await click(option('cam-2'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('cam-2')
  })
})
