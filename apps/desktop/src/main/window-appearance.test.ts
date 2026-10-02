import { describe, expect, it, vi } from 'vitest'

import {
  applyClearGlass,
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

  it('wires the clear-glass export when the addon has it (plan 091)', () => {
    const setWindowGlassStyle = vi.fn(() => ({ restyled: true, reason: null }))
    const binding = windowAppearanceBindingFromModule({
      setWindowAppearance: () => true,
      setWindowGlassStyle
    })
    expect(binding?.setWindowGlassStyle?.(handle, { blurRadius: 60 })).toEqual({
      restyled: true,
      reason: null
    })
    expect(setWindowGlassStyle).toHaveBeenCalledWith(handle, { blurRadius: 60 })
    const stale = windowAppearanceBindingFromModule({ setWindowAppearance: () => true })
    expect(stale?.setWindowGlassStyle).toBeUndefined()
  })

  it('reads the addon result strictly: a literal true restyles, a string is the reason', () => {
    const binding = windowAppearanceBindingFromModule({
      setWindowAppearance: () => true,
      setWindowGlassStyle: () => ({ restyled: 'yes', reason: 'unsupported-class:NSKVONotifying' })
    })
    expect(binding?.setWindowGlassStyle?.(handle, { blurRadius: 60 })).toEqual({
      restyled: false,
      reason: 'unsupported-class:NSKVONotifying'
    })
  })
})

describe('applyClearGlass (plan 091)', () => {
  const loadWith = (
    result: { restyled: boolean; reason: string | null } | Error | undefined
  ): WindowAppearanceLoad => ({
    binding: {
      setWindowAppearance: () => true,
      ...(result === undefined
        ? {}
        : {
            setWindowGlassStyle: () => {
              if (result instanceof Error) throw result
              return result
            }
          })
    },
    unavailableReason: null
  })

  it('applies through the binding with the requested radius', () => {
    const setWindowGlassStyle = vi.fn(() => ({ restyled: true, reason: null }))
    const load: WindowAppearanceLoad = {
      binding: { setWindowAppearance: () => true, setWindowGlassStyle },
      unavailableReason: null
    }
    expect(applyClearGlass(load, () => handle, 60)).toEqual({ applied: true })
    expect(setWindowGlassStyle).toHaveBeenCalledWith(handle, { blurRadius: 60 })
  })

  it('explains every way the strip can stay off, so main keeps the material', () => {
    expect(
      applyClearGlass({ binding: null, unavailableReason: 'no addon' }, () => handle, 60)
    ).toEqual({ applied: false, reason: 'no addon' })
    const stale = applyClearGlass(loadWith(undefined), () => handle, 60)
    expect(!stale.applied && stale.reason).toMatch(/pnpm build:native-preview-addon/)
    expect(
      applyClearGlass(
        loadWith({
          restyled: false,
          reason: 'unsupported-class:NSKVONotifying_NSVisualEffectView'
        }),
        () => handle,
        60
      )
    ).toEqual({ applied: false, reason: 'unsupported-class:NSKVONotifying_NSVisualEffectView' })
    expect(applyClearGlass(loadWith({ restyled: false, reason: null }), () => handle, 60)).toEqual({
      applied: false,
      reason: 'The addon re-classed no effect view.'
    })
    const thrown = applyClearGlass(loadWith(new Error('bad handle')), () => handle, 60)
    expect(!thrown.applied && thrown.reason).toMatch(/bad handle/)
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
