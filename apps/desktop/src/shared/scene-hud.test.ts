import { describe, expect, it } from 'vitest'

import { validateElectronEventPayload, validateElectronInvokeArgs } from './electron-ipc-contract'
import { sceneHudLine, sceneHudRequest } from './scene-hud'

describe('the key HUD request main trusts (plan 231 D20)', () => {
  it('keeps a name, a known icon, and the key and refusal only as words', () => {
    expect(
      sceneHudRequest({
        name: '  Figma  ',
        icon: { kind: 'app', bundleId: 'com.figma.Desktop', extra: 1 },
        key: 'Control+Alt+1',
        refusal: '',
        other: 'dropped'
      })
    ).toEqual({
      name: 'Figma',
      icon: { kind: 'app', bundleId: 'com.figma.Desktop' },
      key: 'Control+Alt+1'
    })
    expect(sceneHudRequest({ name: 'Camera only', icon: { kind: 'camera' } })).toEqual({
      name: 'Camera only',
      icon: { kind: 'camera' }
    })
  })

  it('refuses anything without a name or with an unknown icon', () => {
    expect(sceneHudRequest(null)).toBeNull()
    expect(sceneHudRequest({ name: '', icon: { kind: 'display' } })).toBeNull()
    expect(sceneHudRequest({ name: 'Figma', icon: { kind: 'file', path: '/etc' } })).toBeNull()
    expect(sceneHudRequest({ name: 'Figma', icon: { kind: 'app', bundleId: '../x' } })).toBeNull()
    expect(sceneHudRequest({ name: 'x'.repeat(500), icon: { kind: 'window' } })?.name).toHaveLength(
      80
    )
  })

  it('crosses IPC through its contract only in shape', () => {
    expect(
      validateElectronInvokeArgs('scene-hud:show', [{ name: 'Figma', icon: { kind: 'display' } }])
    ).toEqual([{ name: 'Figma', icon: { kind: 'display' } }])
    expect(() =>
      validateElectronInvokeArgs('scene-hud:show', [{ name: 'Figma', icon: { kind: 'nope' } }])
    ).toThrow()
    expect(
      validateElectronEventPayload('scene-hud:present', {
        name: 'Figma',
        icon: { kind: 'display' },
        sequence: 3,
        platform: 'darwin'
      })
    ).toEqual({ name: 'Figma', icon: { kind: 'display' }, sequence: 3, platform: 'darwin' })
    expect(() =>
      validateElectronEventPayload('scene-hud:present', {
        name: 'Figma',
        icon: { kind: 'display' },
        sequence: 3,
        platform: 'darwin',
        iconDataUrl: 'https://example.com/icon.png'
      })
    ).toThrow()
    expect(() =>
      validateElectronEventPayload('scene-hud:state', {
        enabled: true,
        method: 'capture-filter',
        ready: true,
        windowId: 4,
        extra: true
      })
    ).toThrow()
  })
})

describe('the words on the chip', () => {
  it('is the name, or the refusal, which already names the scene or follows it', () => {
    expect(sceneHudLine({ name: 'Figma' })).toBe('Figma')
    expect(sceneHudLine({ name: 'Figma', refusal: "Figma isn't open" })).toBe("Figma isn't open")
    expect(sceneHudLine({ name: 'Side by side', refusal: 'Turn the camera on in Sources' })).toBe(
      'Side by side · Turn the camera on in Sources'
    )
  })
})
