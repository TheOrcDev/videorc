import { describe, expect, it, vi } from 'vitest'

import {
  SCENE_HUD_IDLE_AFTER_MS,
  SCENE_HUD_WINDOW_SIZE,
  SceneHudController,
  sceneHudBounds,
  sceneHudShowDecision,
  sceneHudSupported,
  sceneHudWindowIdFromMediaSourceId,
  sceneHudWindowOptions,
  sceneHudWindowReady,
  windowsExcludesFromCapture,
  type SceneHudHost,
  type SceneHudWindowHandle
} from './scene-hud'
import type { SceneHudPresentation, SceneHudRequest } from '../shared/scene-hud'

const FIGMA: SceneHudRequest = {
  name: 'Figma',
  icon: { kind: 'app', bundleId: 'com.figma.Desktop' },
  key: 'Control+Alt+1'
}

describe('the key HUD decision in main (plan 231 D20)', () => {
  it('shows only on macOS and Windows, with the setting on, nothing of Videorc in front and the window ready', () => {
    const base = { enabled: true, ready: true, videorcWindowFocused: false }
    expect(sceneHudShowDecision({ ...base, platform: 'darwin' })).toEqual({ shown: true })
    expect(sceneHudShowDecision({ ...base, platform: 'win32' })).toEqual({ shown: true })
    expect(sceneHudShowDecision({ ...base, platform: 'linux' })).toEqual({
      shown: false,
      reason: 'unsupported'
    })
    expect(sceneHudShowDecision({ ...base, platform: 'darwin', enabled: false })).toEqual({
      shown: false,
      reason: 'disabled'
    })
    // A Videorc window in front: the stage is in view, so the HUD stays away.
    expect(
      sceneHudShowDecision({ ...base, platform: 'darwin', videorcWindowFocused: true })
    ).toEqual({ shown: false, reason: 'videorc-in-front' })
    // Fail closed: an exclusion that can't be confirmed never draws.
    expect(sceneHudShowDecision({ ...base, platform: 'win32', ready: false })).toEqual({
      shown: false,
      reason: 'not-ready'
    })
    expect(sceneHudSupported('darwin')).toBe(true)
    expect(sceneHudSupported('win32')).toBe(true)
    expect(sceneHudSupported('linux')).toBe(false)
  })

  it('is ready only when the exclusion can hold (fail closed)', () => {
    const live = {
      alive: true,
      loaded: true,
      onScreen: true,
      windowId: 42,
      contentProtected: true
    }
    // macOS: protected (a cloud room's Chromium share), and on screen with an
    // id the capture filter can find.
    expect(sceneHudWindowReady({ ...live, platform: 'darwin' })).toBe(true)
    expect(sceneHudWindowReady({ ...live, platform: 'darwin', contentProtected: false })).toBe(
      false
    )
    expect(sceneHudWindowReady({ ...live, platform: 'darwin', onScreen: false })).toBe(false)
    expect(sceneHudWindowReady({ ...live, platform: 'darwin', windowId: undefined })).toBe(false)
    expect(sceneHudWindowReady({ ...live, platform: 'darwin', loaded: false })).toBe(false)
    // Windows: content protection confirmed.
    expect(sceneHudWindowReady({ ...live, platform: 'win32', contentProtected: false })).toBe(false)
    expect(sceneHudWindowReady({ ...live, platform: 'win32', contentProtected: true })).toBe(true)
    expect(
      sceneHudWindowReady({ ...live, platform: 'win32', contentProtected: true, alive: false })
    ).toBe(false)
    expect(sceneHudWindowReady({ ...live, platform: 'linux', contentProtected: true })).toBe(false)
  })

  it('needs Windows 10 2004 or later, where a window is left out instead of painted black', () => {
    expect(windowsExcludesFromCapture('10.0.22631')).toBe(true)
    expect(windowsExcludesFromCapture('10.0.19041')).toBe(true)
    expect(windowsExcludesFromCapture('10.0.18363')).toBe(false)
    expect(windowsExcludesFromCapture('6.3.9600')).toBe(false)
    expect(windowsExcludesFromCapture('')).toBe(false)
  })

  it('sits at the top centre of the display under the pointer', () => {
    expect(sceneHudBounds({ x: 0, y: 25, width: 1512, height: 957 })).toEqual({
      x: 496,
      y: 33,
      width: SCENE_HUD_WINDOW_SIZE.width,
      height: SCENE_HUD_WINDOW_SIZE.height
    })
    // A second display to the left, and one narrower than the window.
    expect(sceneHudBounds({ x: -1920, y: 0, width: 1920, height: 1080 }).x).toBe(-1220)
    expect(sceneHudBounds({ x: 0, y: 0, width: 400, height: 300 })).toMatchObject({
      x: 0,
      width: 400
    })
  })

  it('reads the ScreenCaptureKit window id from the media source id', () => {
    expect(sceneHudWindowIdFromMediaSourceId('window:12345:0')).toBe(12345)
    expect(sceneHudWindowIdFromMediaSourceId('screen:1:0')).toBeUndefined()
    expect(sceneHudWindowIdFromMediaSourceId('window:0:0')).toBeUndefined()
  })

  it('is a click-through panel that never takes focus or a taskbar slot', () => {
    const mac = sceneHudWindowOptions('darwin')
    expect(mac).toMatchObject({
      type: 'panel',
      hiddenInMissionControl: true,
      focusable: false,
      skipTaskbar: true,
      transparent: true,
      frame: false,
      show: false,
      alwaysOnTop: true
    })
    const windows = sceneHudWindowOptions('win32')
    expect(windows).toMatchObject({ focusable: false, skipTaskbar: true, transparent: true })
    expect(windows).not.toHaveProperty('type')
  })
})

class FakeWindow implements SceneHudWindowHandle {
  destroyed = false
  visible = false
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  moveTop = vi.fn()
  constructor(private readonly id = 77) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }
  showInactive(): void {
    this.visible = true
  }
  hide(): void {
    this.visible = false
  }
  isVisible(): boolean {
    return this.visible
  }
  getMediaSourceId(): string {
    return `window:${this.id}:0`
  }
}

function fakeHost(
  platform: NodeJS.Platform,
  overrides: Partial<SceneHudHost<FakeWindow>> = {}
): {
  host: SceneHudHost<FakeWindow>
  windows: FakeWindow[]
  presented: SceneHudPresentation[]
  timers: Array<{ callback: () => void; ms: number }>
} {
  const windows: FakeWindow[] = []
  const presented: SceneHudPresentation[] = []
  const timers: Array<{ callback: () => void; ms: number }> = []
  const host: SceneHudHost<FakeWindow> = {
    platform,
    createWindow: async () => {
      const window = new FakeWindow()
      windows.push(window)
      return window
    },
    protect: () => true,
    cursorWorkArea: () => ({ x: 0, y: 25, width: 1512, height: 957 }),
    videorcWindowFocused: () => false,
    appIcon: async () => 'data:image/png;base64,AAAA',
    present: (_window, presentation) => presented.push(presentation),
    emitState: () => undefined,
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms })
      return timers.length
    },
    clearTimeout: () => undefined,
    warn: () => undefined,
    ...overrides
  }
  return { host, windows, presented, timers }
}

describe('SceneHudController', () => {
  it('keeps the macOS window on screen and transparent, so the capture filter can find it', async () => {
    const { host, windows, presented } = fakeHost('darwin')
    const hud = new SceneHudController(host)
    expect(await hud.setEnabled(true)).toEqual({
      enabled: true,
      method: 'capture-filter',
      windowId: 77,
      ready: true
    })
    expect(windows[0].visible).toBe(true)
    expect(await hud.show(FIGMA)).toEqual({ shown: true })
    expect(presented[0]).toEqual({
      ...FIGMA,
      sequence: 1,
      platform: 'darwin',
      iconDataUrl: 'data:image/png;base64,AAAA'
    })
    expect(windows[0].bounds).toMatchObject({ x: 496, y: 33 })
    // A second switch inside the hold replaces the chip (the window restarts it).
    await hud.show({ name: 'T3 Code', icon: { kind: 'display' }, key: 'Control+Alt+2' })
    expect(presented.map((entry) => [entry.name, entry.sequence])).toEqual([
      ['Figma', 1],
      ['T3 Code', 2]
    ])
    expect(presented[1]).not.toHaveProperty('iconDataUrl')
  })

  it('never draws while a Videorc window is in front', async () => {
    const { host, presented } = fakeHost('darwin', { videorcWindowFocused: () => true })
    const hud = new SceneHudController(host)
    await hud.setEnabled(true)
    expect(await hud.show(FIGMA)).toEqual({ shown: false, reason: 'videorc-in-front' })
    expect(presented).toEqual([])
    expect(hud.lastResult).toEqual({ shown: false, reason: 'videorc-in-front' })
  })

  it('fails closed on Windows when content protection is not confirmed', async () => {
    const warn = vi.fn()
    const { host, presented } = fakeHost('win32', { protect: () => false, warn })
    const hud = new SceneHudController(host)
    expect(await hud.setEnabled(true)).toMatchObject({
      method: 'content-protection',
      ready: false
    })
    expect(await hud.show(FIGMA)).toEqual({ shown: false, reason: 'not-ready' })
    expect(presented).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('fails closed on macOS too: the filter alone misses a cloud room share', async () => {
    const warn = vi.fn()
    const { host, presented } = fakeHost('darwin', { protect: () => false, warn })
    const hud = new SceneHudController(host)
    expect(await hud.setEnabled(true)).toMatchObject({
      method: 'capture-filter',
      windowId: 77,
      ready: false
    })
    expect(await hud.show(FIGMA)).toEqual({ shown: false, reason: 'not-ready' })
    expect(presented).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('shows on Windows only while it presents, then hides', async () => {
    const { host, windows, presented, timers } = fakeHost('win32')
    const hud = new SceneHudController(host)
    expect(await hud.setEnabled(true)).toEqual({
      enabled: true,
      method: 'content-protection',
      ready: true
    })
    expect(windows[0].visible).toBe(false)
    expect(await hud.show(FIGMA)).toEqual({ shown: true })
    expect(windows[0].visible).toBe(true)
    expect(presented).toHaveLength(1)
    expect(timers.at(-1)?.ms).toBe(SCENE_HUD_IDLE_AFTER_MS)
    timers.at(-1)?.callback()
    expect(windows[0].visible).toBe(false)
  })

  it('drops the window when the setting goes off, and has none on Linux', async () => {
    const { host, windows } = fakeHost('darwin')
    const hud = new SceneHudController(host)
    await hud.setEnabled(true)
    expect(await hud.setEnabled(false)).toMatchObject({ enabled: false, ready: false })
    expect(windows[0].destroyed).toBe(true)
    expect(await hud.show(FIGMA)).toEqual({ shown: false, reason: 'disabled' })

    const linux = fakeHost('linux')
    const none = new SceneHudController(linux.host)
    expect(await none.setEnabled(true)).toEqual({
      enabled: false,
      method: 'unsupported',
      ready: false
    })
    expect(linux.windows).toEqual([])
    expect(await none.show(FIGMA)).toEqual({ shown: false, reason: 'unsupported' })
  })

  it('holds the next chip longer for screenshots only when asked', async () => {
    const { host, presented } = fakeHost('darwin')
    const hud = new SceneHudController(host)
    await hud.setEnabled(true)
    hud.holdNext(20_000)
    await hud.show(FIGMA)
    await hud.show(FIGMA)
    expect(presented.map((entry) => entry.holdMs)).toEqual([20_000, undefined])
  })
})
