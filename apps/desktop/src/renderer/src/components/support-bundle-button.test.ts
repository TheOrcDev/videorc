// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const studio = vi.hoisted(() => ({
  exportSupportBundle: vi.fn(async () => {}),
  supportBundleExportPending: false
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => studio }))

import { SUPPORT_BUNDLE_LABEL, SupportBundleButton } from './support-bundle-button'

// Plan 174 S1.6b (I-1, V-X11): one look and one name in Health and About.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  studio.supportBundleExportPending = false
  studio.exportSupportBundle.mockClear()
  vi.unstubAllGlobals()
})

function button(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid=support-bundle-button]')
}

describe('SupportBundleButton', () => {
  it('reads "Export support bundle" and exports on a click', () => {
    act(() => root.render(createElement(SupportBundleButton)))
    expect(SUPPORT_BUNDLE_LABEL).toBe('Export support bundle')
    expect(button()?.textContent).toBe('Export support bundle')
    expect(button()?.getAttribute('data-variant')).toBe('outline')
    act(() => button()?.click())
    expect(studio.exportSupportBundle).toHaveBeenCalledTimes(1)
  })

  it('says it is working and takes no second click while the bundle is written', () => {
    studio.supportBundleExportPending = true
    act(() => root.render(createElement(SupportBundleButton)))
    expect(button()?.textContent).toBe('Exporting…')
    expect(button()?.disabled).toBe(true)
  })
})
