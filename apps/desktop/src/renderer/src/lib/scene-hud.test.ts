import { describe, expect, it } from 'vitest'

import { sceneHudKey, sceneHudRequestFor, type SceneSwitchSource } from './scene-hud'

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
