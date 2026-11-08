// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@/lib/backend'
import { LcdDevicePicker, type LcdDevicePickerProps } from './lcd-device-picker'

// Plan 197: the Retro LCD Studio's device dropdown, a row on the screen whose
// list is a small screen in the opaque popup.

type Props = Omit<LcdDevicePickerProps, 'onChange'>

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const cameras: Device[] = [
  { id: 'cam-1', name: 'FaceTime HD Camera', kind: 'camera', status: 'available' },
  { id: 'cam-2', name: 'Desk Camera', kind: 'camera', status: 'available' },
  { id: 'cam-3', name: 'Cam Link 4K', kind: 'camera', status: 'unavailable' }
]
const camera = (value: string | undefined, extra: Partial<Props> = {}): Props => ({
  kind: 'camera',
  label: 'Camera',
  devices: cameras,
  value,
  noneLabel: 'Off',
  ...extra
})
function markup(props: Props): string {
  return renderToStaticMarkup(createElement(LcdDevicePicker, { ...props, onChange }))
}
async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => (element as HTMLElement).click())
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

describe('LCD device picker', () => {
  it('is a row on the screen: its label, the lit value and a pixel chevron', () => {
    const lcd = markup(camera('cam-1', { rowLabel: 'Cam' }))
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
    const missing = markup(camera('cam-gone', { selectedName: 'Old Webcam' }))
    expect(missing).toMatch(/class="shrink-0 text-\(--lcd-display-ink-dim\)">Not found</)
  })

  it('says Finding or none found instead of Off, and Off once cameras are listed', () => {
    expect(markup(camera(undefined, { discoveryPending: true }))).toContain('Finding cameras…')
    expect(markup(camera(undefined, { devices: [] }))).toContain('No cameras found')
    expect(markup(camera(undefined))).toContain('>Off</span>')
  })

  it('opens the list as a small screen in the opaque popup', async () => {
    await act(async () =>
      root.render(createElement(LcdDevicePicker, { ...camera('cam-1'), onChange }))
    )
    await click(container.querySelector('button[role=combobox]'))
    const popup = document.querySelector('[data-slot="popover-content"]')!
    // The popup is the app's opaque float; the screen inside keeps its own
    // opaque glass, never the see-through one of the inspector's screens.
    expect(popup.className).toContain('glass-float')
    const screen = popup.querySelector('[data-slot="lcd-display"]')!
    expect(screen.className).not.toContain('--glass-solid')
    const list = screen.querySelector('[cmdk-list]')!
    expect(document.activeElement).toBe(list)
    expect(option('cam-1')?.className).toContain('data-[checked=true]:text-(--lcd-display-lit)')
    expect(option('cam-1')?.getAttribute('data-checked')).toBe('true')
    expect(option('cam-3')?.getAttribute('aria-disabled')).toBe('true')
    await click(option('cam-2'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('cam-2')
  })

  it('turns the camera Off through its none item', async () => {
    await act(async () =>
      root.render(createElement(LcdDevicePicker, { ...camera('cam-1'), onChange }))
    )
    await click(container.querySelector('button[role=combobox]'))
    await click(option('__none__'))
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })
})
