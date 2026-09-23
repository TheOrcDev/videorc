import { describe, expect, it, vi } from 'vitest'

import {
  loadWindowAppearanceBinding,
  pinWindowAppearance,
  windowAppearanceBindingFromModule,
  type WindowAppearanceLoad
} from './window-appearance'

const handle = Buffer.alloc(8)
const available = { path: '/addon.node', source: 'development' } as const

describe('windowAppearanceBindingFromModule', () => {
  it('accepts the addon export, directly or as a default export', () => {
    const setWindowAppearance = vi.fn(() => true)
    for (const moduleValue of [{ setWindowAppearance }, { default: { setWindowAppearance } }]) {
      const binding = windowAppearanceBindingFromModule(moduleValue)
      expect(binding?.setWindowAppearance(handle, 'dark')).toBe(true)
    }
    expect(setWindowAppearance).toHaveBeenCalledWith(handle, 'dark')
  })

  it('rejects an addon built before the export existed', () => {
    expect(windowAppearanceBindingFromModule({ attachNativePreview: () => undefined })).toBeNull()
    expect(windowAppearanceBindingFromModule(null)).toBeNull()
  })

  it('only reports a pin for a literal true', () => {
    const binding = windowAppearanceBindingFromModule({ setWindowAppearance: () => 'yes' })
    expect(binding?.setWindowAppearance(handle, 'dark')).toBe(false)
  })
})

describe('loadWindowAppearanceBinding', () => {
  it('is unavailable off macOS without touching the addon', () => {
    const loadModule = vi.fn()
    expect(
      loadWindowAppearanceBinding({ platform: 'win32', resolution: available, loadModule })
    ).toEqual({ binding: null, unavailableReason: 'Window appearance pins exist only on macOS.' })
    expect(loadModule).not.toHaveBeenCalled()
  })

  it('carries the resolver reason when the addon is missing', () => {
    const load = loadWindowAppearanceBinding({
      platform: 'darwin',
      resolution: { path: undefined, source: 'unavailable', reason: 'not built' },
      loadModule: vi.fn()
    })
    expect(load).toEqual({ binding: null, unavailableReason: 'not built' })
  })

  it('names the rebuild when the export is missing and the error when loading throws', () => {
    const stale = loadWindowAppearanceBinding({
      platform: 'darwin',
      resolution: available,
      loadModule: () => ({})
    })
    expect(stale.unavailableReason).toMatch(/pnpm build:native-preview-addon/)
    const broken = loadWindowAppearanceBinding({
      platform: 'darwin',
      resolution: available,
      loadModule: () => {
        throw new Error('dlopen failed')
      }
    })
    expect(broken.unavailableReason).toMatch(/dlopen failed/)
  })
})

describe('pinWindowAppearance', () => {
  const loadWith = (result: boolean | Error): WindowAppearanceLoad => ({
    binding: {
      setWindowAppearance: () => {
        if (result instanceof Error) throw result
        return result
      }
    },
    unavailableReason: null
  })

  it('pins through the binding', () => {
    expect(pinWindowAppearance(loadWith(true), () => handle, 'dark')).toEqual({ pinned: true })
  })

  it('explains every way the pin can fail', () => {
    expect(
      pinWindowAppearance({ binding: null, unavailableReason: 'no addon' }, () => handle, 'dark')
    ).toEqual({ pinned: false, reason: 'no addon' })
    expect(pinWindowAppearance(loadWith(false), () => handle, 'dark')).toEqual({
      pinned: false,
      reason: 'The window has no AppKit window to pin yet.'
    })
    const thrown = pinWindowAppearance(loadWith(new Error('bad handle')), () => handle, 'dark')
    expect(thrown.pinned).toBe(false)
    expect(!thrown.pinned && thrown.reason).toMatch(/bad handle/)
  })
})
