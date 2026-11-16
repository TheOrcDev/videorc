import fixture from '../../../../protocol-fixtures/room-microphone.json'
import { describe, expect, it } from 'vitest'
import { parseRoomMicrophoneCommand } from './room-microphone'
import { validateElectronInvokeArgs } from './electron-ipc-contract'
import { RendererSecurityRegistry } from './renderer-security-policy'
const command = {
  action: 'open',
  generation: 1,
  role: 'host-microphone',
  sampleRate: 48000,
  channels: 1,
  frames: 480,
  showId: 'show',
  settings: {
    deviceId: 'microphone:coreaudio:42',
    gainDb: 0,
    muted: true,
    noise: 'rnnoise',
    offsetMs: 0
  }
}
describe('capture-only microphone contract', () => {
  it('matches the native mirror fixture and rejects values beyond its bounds', () => {
    expect(
      parseRoomMicrophoneCommand({
        ...command,
        role: fixture.role,
        sampleRate: fixture.sampleRate,
        channels: fixture.channels,
        frames: fixture.frames
      })
    ).toEqual(command)
    expect(fixture.queueFrames).toBe(1920)
    for (const deviceId of fixture.rejectedDeviceIds)
      expect(() =>
        parseRoomMicrophoneCommand({ ...command, settings: { ...command.settings, deviceId } })
      ).toThrow()

    for (const gainDb of [fixture.gainDb.min, fixture.gainDb.max])
      for (const offsetMs of [fixture.offsetMs.min, fixture.offsetMs.max])
        expect(
          parseRoomMicrophoneCommand({
            ...command,
            settings: { ...command.settings, gainDb, offsetMs }
          })
        ).toBeTruthy()
    expect(fixture.nativeProductionQualified).toBe(false)
    expect(fixture.nativeSpeakerAec).toBe(false)
    expect(fixture.clockQualification).toBe('unavailable')
  })
  it('admits only bounded settings and the exact owned role before IPC', () => {
    expect(parseRoomMicrophoneCommand(command)).toEqual(command)
    for (const patch of [
      { generation: 0 },
      { role: 'guest' },
      { frames: 481 },
      { sampleRate: 44100 },
      { showId: '' },
      { extra: 1 }
    ])
      expect(() =>
        validateElectronInvokeArgs('room-microphone:pcm', [{ ...command, ...patch }])
      ).toThrow()
    for (const patch of [
      { deviceId: '' },
      { gainDb: Infinity },
      { gainDb: 25 },
      { muted: 0 },
      { noise: 'browser' },
      { offsetMs: -1 },
      { offsetMs: 1001 },
      { extra: 1 }
    ])
      expect(() =>
        parseRoomMicrophoneCommand({ ...command, settings: { ...command.settings, ...patch } })
      ).toThrow()
    expect(() => parseRoomMicrophoneCommand({ ...command, action: 'pull' })).toThrow()
  })
  it('rejects foreign origins, subframes and auxiliary renderer roles', () => {
    const registry = new RendererSecurityRegistry()
    registry.register(1, 'main')
    registry.register(2, 'comments')
    const frameUrl = 'http://localhost:5173/index.html'
    registry.trustDocument(1, frameUrl)
    registry.trustDocument(2, frameUrl)
    expect(
      registry.invokeAllowed('room-microphone:pcm', { senderId: 1, frameUrl, isMainFrame: true })
    ).toBe(true)
    for (const sender of [
      { senderId: 2, frameUrl, isMainFrame: true },
      { senderId: 1, frameUrl, isMainFrame: false },
      { senderId: 1, frameUrl: 'https://invalid.example', isMainFrame: true }
    ])
      expect(registry.invokeAllowed('room-microphone:pcm', sender)).toBe(false)
  })
})
