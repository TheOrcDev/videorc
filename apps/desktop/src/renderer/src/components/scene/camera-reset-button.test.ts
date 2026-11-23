// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CAMERA_SETTINGS_DEFAULTS, CameraResetButton } from './camera-reset-button'

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
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('CameraResetButton (plan 174 S0.3, C-18)', () => {
  it('asks before resetting, keeps the values on Cancel, and resets on confirm', async () => {
    const onReset = vi.fn()
    await act(async () => root.render(createElement(CameraResetButton, { onReset })))
    const trigger = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Reset camera settings'
    )!
    await act(async () => trigger.click())
    const dialog = byTestId('camera-reset-dialog')
    expect(dialog?.textContent).toContain('Reset camera settings?')
    expect(dialog?.textContent).toContain('Placement, frame and lens')
    // Plan 258 S5: the background (with the key) is the camera's and stays.
    expect(dialog?.textContent).toContain('the background stay')
    await act(async () => byTestId('camera-reset-cancel')!.click())
    expect(onReset).not.toHaveBeenCalled()
    await act(async () => trigger.click())
    await act(async () => byTestId('camera-reset-confirm')!.click())
    expect(onReset).toHaveBeenCalledExactlyOnceWith(CAMERA_SETTINGS_DEFAULTS)
    expect(byTestId('camera-reset-dialog')).toBeNull()
  })

  it('keeps the thirteen shipped defaults, and never the key or the background (plan 258 S5)', () => {
    expect(Object.keys(CAMERA_SETTINGS_DEFAULTS)).toHaveLength(13)
    expect(CAMERA_SETTINGS_DEFAULTS).toMatchObject({
      cameraTransformMode: 'preset',
      cameraCorner: 'bottom-right'
    })
    expect(
      Object.keys(CAMERA_SETTINGS_DEFAULTS).some((key) => key.startsWith('cameraChromaKey'))
    ).toBe(false)
    expect(CAMERA_SETTINGS_DEFAULTS).not.toHaveProperty('cameraBackground')
  })
})
