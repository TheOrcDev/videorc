import { describe, expect, it } from 'vitest'

import {
  CLEAR_GLASS_BLUR_RADIUS,
  DEFAULT_GLASS_MATERIAL,
  DEFAULT_GLASS_STYLE,
  glassModeForRole,
  resolveGlassMode,
  resolveGlassStyle,
  solidWindowBase,
  trafficLightPosition,
  WINDOWS_MICA_MIN_BUILD,
  windowGlassOptions,
  windowGroundForMode,
  windowsBuildFromRelease,
  type GlassMode,
  type GlassWindowRole
} from './window-glass'
import { DARK_WINDOW_PALETTE, LIGHT_WINDOW_PALETTE } from './window-palette'

const ROLES: GlassWindowRole[] = ['main', 'chat', 'captions', 'notes', 'preview']
const THEME_ROLES = ['main', 'chat', 'captions', 'notes'] as const
const mac = { platform: 'darwin' as const }
const win = (windowsBuild?: number, glass?: string) => ({
  platform: 'win32' as const,
  windowsBuild,
  glass
})
const GROUND: GlassMode = { kind: 'ground' }

describe('resolveGlassMode (plan 208, D1)', () => {
  it('gives every platform the chrome ground by default', () => {
    expect(resolveGlassMode(mac)).toEqual(GROUND)
    expect(resolveGlassMode(win(26100))).toEqual(GROUND)
    expect(resolveGlassMode(win(19045))).toEqual(GROUND)
    expect(resolveGlassMode(win(undefined))).toEqual(GROUND)
    expect(resolveGlassMode({ platform: 'linux' })).toEqual(GROUND)
  })

  it('keeps the ground under software rendering and after a blank Mica launch: it needs neither', () => {
    expect(resolveGlassMode({ ...win(22631), softwareRendering: true })).toEqual(GROUND)
    expect(resolveGlassMode({ ...win(22631), micaFoundBlank: true })).toEqual(GROUND)
    expect(resolveGlassMode({ ...mac, softwareRendering: true, micaFoundBlank: true })).toEqual(
      GROUND
    )
  })

  it('VIDEORC_GLASS=0 and the legacy VIDEORC_GLASS_VIBRANCY=0 alias paint the solid palette everywhere', () => {
    expect(resolveGlassMode({ ...mac, glass: '0' })).toEqual({ kind: 'solid', reason: 'disabled' })
    expect(resolveGlassMode({ ...mac, legacyVibrancy: '0' })).toEqual({
      kind: 'solid',
      reason: 'disabled'
    })
    expect(resolveGlassMode(win(22631, '0'))).toEqual({ kind: 'solid', reason: 'disabled' })
    expect(resolveGlassMode({ platform: 'linux', glass: '0' })).toEqual({
      kind: 'solid',
      reason: 'disabled'
    })
  })

  it('anything that is not an escape hatch keeps the ground', () => {
    for (const value of ['1', 'glass', 'ground', 'chrome', '', ' ']) {
      expect(resolveGlassMode({ ...mac, glass: value })).toEqual(GROUND)
      expect(resolveGlassMode({ ...mac, legacyVibrancy: value })).toEqual(GROUND)
    }
  })
})

describe('VIDEORC_GLASS=clear: the plan 091 glass for one release (plan 208, D9)', () => {
  it('restores the real material on macOS, trimmed and case-insensitive', () => {
    expect(resolveGlassMode({ ...mac, glass: 'clear' })).toEqual({
      kind: 'material',
      material: DEFAULT_GLASS_MATERIAL
    })
    expect(resolveGlassMode({ ...mac, glass: ' Clear ' })).toEqual({
      kind: 'material',
      material: DEFAULT_GLASS_MATERIAL
    })
    expect(DEFAULT_GLASS_MATERIAL).toBe('under-window')
  })

  it('a material name asks for that material on macOS', () => {
    expect(resolveGlassMode({ ...mac, glass: 'hud' })).toEqual({
      kind: 'material',
      material: 'hud'
    })
    expect(resolveGlassMode({ ...mac, legacyVibrancy: 'sidebar' })).toEqual({
      kind: 'material',
      material: 'sidebar'
    })
  })

  it('paints the solid palette on Linux: it never had a material', () => {
    expect(resolveGlassMode({ platform: 'linux', glass: 'clear' })).toEqual({
      kind: 'solid',
      reason: 'platform'
    })
    expect(resolveGlassMode({ platform: 'linux', glass: 'hud' })).toEqual({
      kind: 'solid',
      reason: 'platform'
    })
  })

  it('keeps VIDEORC_GLASS=0 ahead of a clear request', () => {
    expect(resolveGlassMode({ ...mac, glass: 'clear', legacyVibrancy: '0' })).toEqual({
      kind: 'solid',
      reason: 'disabled'
    })
  })
})

describe('resolveGlassStyle (plan 091)', () => {
  it('strips to clear glass unless VIDEORC_GLASS_STYLE=material asks for the A/B control', () => {
    expect(DEFAULT_GLASS_STYLE).toBe('clear')
    expect(resolveGlassStyle(undefined)).toBe('clear')
    expect(resolveGlassStyle('material')).toBe('material')
    expect(resolveGlassStyle(' Material ')).toBe('material')
    expect(resolveGlassStyle('clear')).toBe('clear')
    for (const value of ['', '1', 'ghostex', 'frost', '0']) {
      expect(resolveGlassStyle(value)).toBe(DEFAULT_GLASS_STYLE)
    }
  })

  it("uses Ghostex's blur radius", () => {
    expect(CLEAR_GLASS_BLUR_RADIUS).toBe(60)
  })
})

describe('windowGlassOptions', () => {
  it('gives every ground window an opaque backing on the theme solid base: no vibrancy, no material', () => {
    for (const role of THEME_ROLES) {
      const dark = windowGlassOptions(role, { ...mac, mode: GROUND, dark: true })
      expect(dark.backgroundColor).toBe(DARK_WINDOW_PALETTE.base)
      expect(dark.vibrancy).toBeUndefined()
      expect(dark.visualEffectState).toBeUndefined()
      expect(dark.backgroundMaterial).toBeUndefined()
      expect(dark.transparent).toBeUndefined()
      expect(windowGlassOptions(role, { ...mac, mode: GROUND, dark: false }).backgroundColor).toBe(
        LIGHT_WINDOW_PALETTE.base
      )
    }
  })

  it('keeps the macOS title bar recipe under the ground', () => {
    const options = windowGlassOptions('main', { ...mac, mode: GROUND, dark: true })
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.trafficLightPosition).toEqual(trafficLightPosition('main'))
  })

  it('carries no macOS chrome off macOS: the native frame owns the title bar', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(windowGlassOptions('main', { platform, mode: GROUND, dark: true })).toEqual({
        backgroundColor: DARK_WINDOW_PALETTE.base
      })
      expect(windowGlassOptions('chat', { platform, mode: GROUND, dark: false })).toEqual({
        backgroundColor: LIGHT_WINDOW_PALETTE.base
      })
    }
  })

  it('gives every macOS role the live material and no transparent backing under VIDEORC_GLASS=clear', () => {
    const mode = resolveGlassMode({ ...mac, glass: 'clear' })
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

  it('solid mode paints the palette base and keeps only the preview dark in light theme', () => {
    const solid = resolveGlassMode({ ...mac, glass: '0' })
    expect(windowGlassOptions('main', { ...mac, mode: solid, dark: false }).backgroundColor).toBe(
      LIGHT_WINDOW_PALETTE.base
    )
    expect(windowGlassOptions('main', { ...mac, mode: solid, dark: true }).backgroundColor).toBe(
      DARK_WINDOW_PALETTE.base
    )
    for (const role of ['chat', 'captions', 'notes'] as const) {
      expect(solidWindowBase(role, false)).toBe(LIGHT_WINDOW_PALETTE.base)
      expect(solidWindowBase(role, true)).toBe(DARK_WINDOW_PALETTE.base)
    }
    expect(solidWindowBase('preview', false)).toBe(DARK_WINDOW_PALETTE.base)
  })
})

describe('glassModeForRole', () => {
  it('keeps the ground for every theme-following role, with or without the appearance pin', () => {
    for (const role of THEME_ROLES) {
      expect(glassModeForRole(role, GROUND, true)).toEqual(GROUND)
      expect(glassModeForRole(role, GROUND, false)).toEqual(GROUND)
    }
  })

  it('keeps the Preview solid dark under the ground: it frames video (plan 208, D7)', () => {
    expect(glassModeForRole('preview', GROUND, true)).toEqual({
      kind: 'solid',
      reason: 'dark-always'
    })
    expect(glassModeForRole('preview', GROUND, false)).toEqual({
      kind: 'solid',
      reason: 'dark-always'
    })
  })

  it('under the clear glass, keeps the material for every role when the appearance pin is available', () => {
    const material = resolveGlassMode({ ...mac, glass: 'clear' })
    for (const role of ROLES) {
      expect(glassModeForRole(role, material, true)).toEqual(material)
    }
  })

  it('under the clear glass, paints the dark-always preview solid without a pin; theme-following roles keep the material', () => {
    const material = resolveGlassMode({ ...mac, glass: 'clear' })
    for (const role of THEME_ROLES) {
      expect(glassModeForRole(role, material, false)).toEqual(material)
    }
    expect(glassModeForRole('preview', material, false)).toEqual({
      kind: 'solid',
      reason: 'appearance-unpinned'
    })
  })

  it('never turns a solid mode back into a material or a ground', () => {
    const solid = resolveGlassMode({ ...mac, glass: '0' })
    expect(glassModeForRole('chat', solid, true)).toEqual(solid)
    expect(glassModeForRole('preview', solid, true)).toEqual(solid)
  })
})

describe('windowGroundForMode: what the renderer paints under its coats (plan 208, S2)', () => {
  it('maps the ground to chrome, the OS materials to glass, and the solid palette to solid', () => {
    expect(windowGroundForMode(GROUND)).toBe('chrome')
    expect(windowGroundForMode({ kind: 'material', material: 'under-window' })).toBe('glass')
    expect(windowGroundForMode({ kind: 'mica' })).toBe('glass')
    expect(windowGroundForMode({ kind: 'solid', reason: 'disabled' })).toBe('solid')
    expect(windowGroundForMode({ kind: 'solid', reason: 'dark-always' })).toBe('solid')
    expect(windowGroundForMode({ kind: 'solid', reason: 'platform' })).toBe('solid')
  })
})

describe('Windows Mica under VIDEORC_GLASS=clear (plan 050, D7; plan 208, D9)', () => {
  const clear = (windowsBuild?: number) => win(windowsBuild, 'clear')

  it('reads the build from os.release()', () => {
    expect(windowsBuildFromRelease('10.0.22631')).toBe(22631)
    expect(windowsBuildFromRelease('10.0.19045')).toBe(19045)
    expect(windowsBuildFromRelease('not-a-release')).toBeUndefined()
  })

  it('uses Mica from Windows 11 22H2 and the solid palette before it', () => {
    expect(WINDOWS_MICA_MIN_BUILD).toBe(22621)
    expect(resolveGlassMode(clear(22621))).toEqual({ kind: 'mica' })
    expect(resolveGlassMode(clear(26100))).toEqual({ kind: 'mica' })
    expect(resolveGlassMode(clear(22000))).toEqual({ kind: 'solid', reason: 'platform' })
    expect(resolveGlassMode(clear(19045))).toEqual({ kind: 'solid', reason: 'platform' })
    expect(resolveGlassMode(clear(undefined))).toEqual({ kind: 'solid', reason: 'platform' })
  })

  it('paints the solid palette under software rendering (plan 082)', () => {
    expect(resolveGlassMode({ ...clear(22631), softwareRendering: true })).toEqual({
      kind: 'solid',
      reason: 'software-rendering'
    })
  })

  it('stays solid after an earlier launch found the Mica window blank (plan 082)', () => {
    expect(resolveGlassMode({ ...clear(22631), micaFoundBlank: true })).toEqual({
      kind: 'solid',
      reason: 'paint-check-blank'
    })
  })

  it('keeps the older reasons ahead of the new ones', () => {
    const both = { softwareRendering: true, micaFoundBlank: true }
    expect(resolveGlassMode({ ...win(22631, '0'), ...both })).toEqual({
      kind: 'solid',
      reason: 'disabled'
    })
    expect(resolveGlassMode({ ...clear(19045), ...both })).toEqual({
      kind: 'solid',
      reason: 'platform'
    })
  })

  it('never lets the Windows-only inputs change macOS', () => {
    expect(
      resolveGlassMode({
        platform: 'darwin',
        glass: 'clear',
        softwareRendering: true,
        micaFoundBlank: true
      })
    ).toEqual({ kind: 'material', material: DEFAULT_GLASS_MATERIAL })
  })

  it('gives main Mica over transparent web contents, and keeps the native frame', () => {
    const options = windowGlassOptions('main', {
      platform: 'win32',
      mode: { kind: 'mica' },
      dark: true
    })
    expect(options).toEqual({ backgroundMaterial: 'mica', backgroundColor: '#00000000' })
    expect(options.titleBarStyle).toBeUndefined()
    expect(options.vibrancy).toBeUndefined()
  })

  it('keeps the dark-always preview solid: Windows cannot pin its appearance', () => {
    const mica = resolveGlassMode(clear(22631))
    expect(glassModeForRole('preview', mica, false)).toEqual({
      kind: 'solid',
      reason: 'appearance-unpinned'
    })
    for (const role of THEME_ROLES) {
      expect(glassModeForRole(role, mica, false)).toEqual({ kind: 'mica' })
    }
  })

  it('drops the OS title bar only on the preview, so its strip and video drag it', () => {
    const solid = glassModeForRole('preview', resolveGlassMode(win(22631)), false)
    expect(windowGlassOptions('preview', { platform: 'win32', mode: solid, dark: false })).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: DARK_WINDOW_PALETTE.base,
        symbolColor: DARK_WINDOW_PALETTE.textSecondary,
        height: 28
      },
      backgroundColor: DARK_WINDOW_PALETTE.base
    })
    for (const role of ['main', 'chat', 'captions', 'notes'] as const) {
      const options = windowGlassOptions(role, {
        platform: 'win32',
        mode: { kind: 'mica' },
        dark: true
      })
      expect(options.titleBarStyle).toBeUndefined()
      expect(options.titleBarOverlay).toBeUndefined()
    }
    expect(
      windowGlassOptions('preview', {
        platform: 'linux',
        mode: { kind: 'solid', reason: 'platform' },
        dark: true
      }).titleBarStyle
    ).toBeUndefined()
  })
})
