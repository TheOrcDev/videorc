import fixture from '../../../../protocol-fixtures/room-microphone.json'
import { describe, expect, it } from 'vitest'
import { parseRoomMicrophoneCommand, ROOM_MICROPHONE_TIMELINE } from './room-microphone'
import { parseRoomPcmFrame, parseRoomPcmOpened, pcmNativeCaptureUs } from './room-pcm'
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
    expect(fixture.clock).toEqual({
      timeline: ROOM_MICROPHONE_TIMELINE,
      fields: ['originUs', 'incarnation'],
      absent: null
    })
  })
  it('carries the processed-timeline native origin on open replies and frames', () => {
    const frame = {
      generation: 4,
      sequence: 3,
      firstSample: 1440,
      firstSampleUs: 30000,
      observedAtUs: 70000,
      sampleRate: 48000,
      channels: 1,
      frames: 480,
      droppedFrames: 0,
      originUs: 2_000_000,
      incarnation: 11,
      samples: Array(480).fill(0)
    }
    expect(parseRoomPcmOpened({ generation: 4, originUs: null, incarnation: null }, 4)).toEqual({
      generation: 4,
      originUs: null,
      incarnation: null
    })
    // Processed position (offset/RNNoise delayed), never raw capture time.
    expect(pcmNativeCaptureUs(parseRoomPcmFrame(frame, 4))).toBe(2_030_000)
    expect(pcmNativeCaptureUs(parseRoomPcmFrame({ ...frame, originUs: null }, 4))).toBeNull()
    for (const clock of [
      { incarnation: null },
      { incarnation: 0 },
      { originUs: Number.MAX_SAFE_INTEGER - 69_999 }
    ])
      expect(() => parseRoomPcmFrame({ ...frame, ...clock }, 4)).toThrow('Invalid PCM frame')
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
