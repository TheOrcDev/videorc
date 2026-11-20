import { describe, expect, it } from 'vitest'

import {
  sceneHudKey,
  sceneHudRequestFor,
  sceneHudSwitchRequest,
  sceneHudWanted,
  type SceneSwitchSource
} from './scene-hud'

const FIGMA = { name: 'Figma', icon: { kind: 'app' as const, bundleId: 'com.figma.Desktop' } }

describe('the key HUD request (plan 231 D20)', () => {
  const base = {
    source: 'key' as SceneSwitchSource,
    enabled: true,
    captureConfirmed: true,
    outcome: { ok: true } as const,
    scene: FIGMA,
    key: 'Control+Alt+1'
  }

  it('asks for a key or a remote switch, never a click, Follow or an agent', () => {
    expect(sceneHudRequestFor(base)).toEqual({ ...FIGMA, key: 'Control+Alt+1' })
    expect(sceneHudRequestFor({ ...base, source: 'remote' })).toEqual({
      ...FIGMA,
      key: 'Control+Alt+1'
    })
    for (const source of ['click', 'follow', 'agent'] as const) {
      expect(sceneHudRequestFor({ ...base, source })).toBeNull()
    }
  })

  it('asks nothing with the setting off', () => {
    expect(sceneHudRequestFor({ ...base, enabled: false })).toBeNull()
  })

  it('fails closed while the capture is not known to leave the HUD out', () => {
    expect(sceneHudRequestFor({ ...base, captureConfirmed: false })).toBeNull()
  })

  it('names a refusal in its words, and says nothing for a switch a newer one took over', () => {
    expect(
      sceneHudRequestFor({ ...base, outcome: { ok: false, message: "Figma isn't open" } })
    ).toEqual({ ...FIGMA, key: 'Control+Alt+1', refusal: "Figma isn't open" })
    expect(sceneHudRequestFor({ ...base, outcome: { ok: false } })).toMatchObject({
      refusal: "That scene couldn't be applied"
    })
    // Two keys in quick succession: the first is superseded, so only the
    // last scene is named.
    expect(sceneHudRequestFor({ ...base, outcome: { ok: false, superseded: true } })).toBeNull()
  })

  it('asks nothing for a scene that is gone, and leaves the key off when there is none', () => {
    expect(sceneHudRequestFor({ ...base, scene: null })).toBeNull()
    expect(sceneHudRequestFor({ ...base, key: undefined })).toEqual(FIGMA)
  })
})

describe('the key on the chip', () => {
  const config = { scenes: { figma: 'F13' } }

  it('is the key pressed when it is the scene’s own', () => {
    expect(
      sceneHudKey({
        pressed: 'scene-slot-2',
        sceneId: 'figma',
        position: 2,
        config,
        platform: 'darwin'
      })
    ).toBe('Control+Alt+2')
    expect(
      sceneHudKey({
        pressed: 'scene:figma',
        sceneId: 'figma',
        position: 2,
        config,
        platform: 'darwin'
      })
    ).toBe('F13')
  })

  it('is the scene’s position key for Next, Previous and remotes, else its custom key', () => {
    expect(
      sceneHudKey({
        pressed: 'layout-next',
        sceneId: 'figma',
        position: 2,
        config,
        platform: 'win32'
      })
    ).toBe('Control+Alt+Shift+2')
    expect(sceneHudKey({ sceneId: 'figma', position: 12, config, platform: 'darwin' })).toBe('F13')
    expect(sceneHudKey({ sceneId: 'chrome', position: 12, config, platform: 'darwin' })).toBe(
      undefined
    )
    // A cleared position key falls through to nothing.
    expect(
      sceneHudKey({
        sceneId: 'chrome',
        position: 3,
        config: { sceneSlots: { 3: '' } },
        platform: 'darwin'
      })
    ).toBeUndefined()
  })
})

describe('the Studio’s whole ask (plan 231 D20)', () => {
  const scenes = [
    {
      id: 'a',
      name: 'Screen only',
      visual: { layout: { layoutPreset: 'screen-only' }, sources: {} }
    },
    { id: 'b', name: 'Camera', visual: { layout: { layoutPreset: 'camera-only' }, sources: {} } }
  ] as unknown as Parameters<typeof sceneHudSwitchRequest>[0]['scenes']
  const input = {
    source: 'key' as const,
    sceneId: 'b',
    outcome: { ok: true } as const,
    pressed: 'scene-slot-2' as const,
    window: { enabled: true, method: 'content-protection' as const, ready: true },
    lastStart: null,
    status: { state: 'live' as const },
    settings: {},
    scenes,
    devices: [],
    platform: 'win32'
  }

  it('names the scene and its position key, from what the Studio knew', () => {
    expect(sceneHudSwitchRequest(input)).toMatchObject({
      name: 'Camera',
      key: 'Control+Alt+Shift+2'
    })
    // Fail closed: macOS with a running capture that never took the id.
    expect(
      sceneHudSwitchRequest({
        ...input,
        window: { enabled: true, method: 'capture-filter', windowId: 9, ready: true },
        lastStart: [[1], { state: 'live' }] as const
      })
    ).toBeNull()
    expect(sceneHudSwitchRequest({ ...input, sceneId: 'gone' })).toBeNull()
    expect(sceneHudSwitchRequest({ ...input, settings: { sceneHud: false } })).toBeNull()
  })

  it('wants main’s window only with the setting on and a key that switches a scene', () => {
    expect(sceneHudWanted({}, scenes, 'darwin')).toBe(true)
    expect(sceneHudWanted({ sceneHud: false }, scenes, 'darwin')).toBe(false)
    expect(sceneHudWanted({}, [], 'darwin')).toBe(false)
  })
})
