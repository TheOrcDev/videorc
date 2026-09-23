import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GLASS_MATERIAL,
  glassModeForRole,
  resolveGlassMode,
  solidWindowBase,
  trafficLightPosition,
  windowGlassOptions,
  type GlassWindowRole
} from './window-glass'
import { DARK_WINDOW_PALETTE, LIGHT_WINDOW_PALETTE } from './window-palette'

const ROLES: GlassWindowRole[] = ['main', 'chat', 'captions', 'notes', 'preview']
const mac = { platform: 'darwin' as const }

describe('resolveGlassMode', () => {
  it('uses the real material on macOS by default', () => {
    expect(resolveGlassMode(mac)).toEqual({ kind: 'material', material: DEFAULT_GLASS_MATERIAL })
    expect(DEFAULT_GLASS_MATERIAL).toBe('under-window')
  })

  it('paints the solid palette off macOS', () => {
    expect(resolveGlassMode({ platform: 'win32' })).toEqual({ kind: 'solid', reason: 'platform' })
    expect(resolveGlassMode({ platform: 'linux', glass: 'hud' })).toEqual({
      kind: 'solid',
      reason: 'platform'
    })
  })

  it('VIDEORC_GLASS=0 and the legacy VIDEORC_GLASS_VIBRANCY=0 alias both opt out', () => {
    expect(resolveGlassMode({ ...mac, glass: '0' })).toEqual({ kind: 'solid', reason: 'disabled' })
    expect(resolveGlassMode({ ...mac, legacyVibrancy: '0' })).toEqual({
      kind: 'solid',
      reason: 'disabled'
    })
  })

  it('a material name overrides the material and anything else keeps the default', () => {
    expect(resolveGlassMode({ ...mac, glass: 'hud' })).toEqual({
      kind: 'material',
      material: 'hud'
    })
    expect(resolveGlassMode({ ...mac, legacyVibrancy: 'sidebar' })).toEqual({
      kind: 'material',
      material: 'sidebar'
    })
    for (const value of ['1', 'glass', '', ' ']) {
      expect(resolveGlassMode({ ...mac, glass: value })).toEqual({
        kind: 'material',
        material: DEFAULT_GLASS_MATERIAL
      })
    }
  })
})

describe('windowGlassOptions', () => {
  it('gives every macOS role the live material and no transparent backing', () => {
    const mode = resolveGlassMode(mac)
    for (const role of ROLES) {
      const options = windowGlassOptions(role, { ...mac, mode, dark: true })
      expect(options.vibrancy).toBe('under-window')
      expect(options.visualEffectState).toBe('active')
      expect(options.titleBarStyle).toBe('hiddenInset')
      expect(options.transparent).toBeUndefined()
      expect(options.backgroundColor).toBeUndefined()
    }
  })

  it('centres the traffic lights on each window header', () => {
    expect(trafficLightPosition('main')).toEqual({ x: 14, y: 13 })
    expect(trafficLightPosition('chat')).toEqual({ x: 14, y: 13 })
    expect(trafficLightPosition('notes')).toEqual({ x: 14, y: 13 })
    expect(trafficLightPosition('preview')).toEqual({ x: 14, y: 7 })
  })

  it('solid mode paints the palette base and keeps dark-always roles dark in light theme', () => {
    const solid = resolveGlassMode({ ...mac, glass: '0' })
    expect(windowGlassOptions('main', { ...mac, mode: solid, dark: false }).backgroundColor).toBe(
      LIGHT_WINDOW_PALETTE.base
    )
    expect(windowGlassOptions('main', { ...mac, mode: solid, dark: true }).backgroundColor).toBe(
      DARK_WINDOW_PALETTE.base
    )
    for (const role of ['chat', 'captions', 'notes', 'preview'] as const) {
      expect(solidWindowBase(role, false)).toBe(DARK_WINDOW_PALETTE.base)
    }
  })

  it('carries no macOS chrome off macOS', () => {
    const options = windowGlassOptions('main', {
      platform: 'win32',
      mode: resolveGlassMode({ platform: 'win32' }),
      dark: true
    })
    expect(options).toEqual({ backgroundColor: DARK_WINDOW_PALETTE.base })
  })
})

describe('glassModeForRole', () => {
  const material = resolveGlassMode(mac)

  it('keeps the material for every role when the appearance pin is available', () => {
    for (const role of ROLES) {
      expect(glassModeForRole(role, material, true)).toEqual(material)
    }
  })

  it('paints dark-always roles solid without a pin, and leaves main on the material', () => {
    expect(glassModeForRole('main', material, false)).toEqual(material)
    for (const role of ['chat', 'captions', 'notes', 'preview'] as const) {
      expect(glassModeForRole(role, material, false)).toEqual({
        kind: 'solid',
        reason: 'appearance-unpinned'
      })
    }
  })

  it('never turns a solid mode back into a material', () => {
    const solid = resolveGlassMode({ ...mac, glass: '0' })
    expect(glassModeForRole('chat', solid, true)).toEqual(solid)
  })
})
