import { roleCanInvokeChannel, RendererSecurityRegistry } from './renderer-security-policy'
import { describe, it, expect } from 'vitest'
import fixture from '../../../../protocol-fixtures/room-system-audio.json'
import {
  parseRoomSystemAudioCommand,
  parseRoomSystemAudioFrame,
  ROOM_SYSTEM_AUDIO,
  systemNativeCaptureUs
} from './room-system-audio'
import { RoomSystemAudioBuffer } from '../renderer/src/lib/room-system-audio-buffer'
import { programAudioGains, parseAudioRouting } from './program-audio-routing'
const frame = (sequence = 0, firstSample = sequence * 480) => ({
  generation: 1,
  sequence,
  firstSample,
  firstSampleUs: Math.floor((firstSample * 1000000) / 48000),
  observedAtUs: 100000,
  droppedFrames: 0,
  sampleRate: 48000,
  channels: 2,
  frames: 480,
  originUs: 2_000_000 as number | null,
  incarnation: 7 as number | null,
  samples: Array.from({ length: 960 }, (_, i) => (i % 2 ? -0.5 : 0.5))
})
describe('Room system PCM and deliberate routing', () => {
  it('Restricts system capture and inspection to the authenticated main renderer', () => {
    for (const channel of ['room-system:pcm', 'room-system:inspect'] as const) {
      expect(roleCanInvokeChannel('main', channel)).toBe(true)
      for (const role of ['notes', 'comments', 'captions'] as const)
        expect(roleCanInvokeChannel(role, channel)).toBe(false)
    }
  })
  it('Rejects untrusted frames and foreign origins before capture IPC', () => {
    const registry = new RendererSecurityRegistry()
    registry.register(1, 'main')
    registry.trustDocument(1, 'http://localhost:5173/index.html')
    const source = { senderId: 1, frameUrl: 'http://localhost:5173/index.html', isMainFrame: true }
    expect(registry.invokeAllowed('room-system:pcm', source)).toBe(true)
    expect(registry.invokeAllowed('room-system:pcm', { ...source, isMainFrame: false })).toBe(false)
    expect(
      registry.invokeAllowed('room-system:pcm', { ...source, frameUrl: 'https://attacker.invalid' })
    ).toBe(false)
  })
  it('Pins native mirror and rejects role, length, rate and epoch before samples', () => {
    expect(parseRoomSystemAudioCommand(fixture.open)).toEqual(fixture.open)
    for (const patch of [
      { role: 'host-microphone' },
      { channels: 1 },
      { frames: 481 },
      { sampleRate: 44100 },
      { generation: 0 },
      { captureSpeakers: true }
    ])
      expect(() => parseRoomSystemAudioCommand({ ...fixture.open, ...patch })).toThrow()
    const input = frame()
    Object.defineProperty(input, 'samples', {
      get() {
        throw Error('sample storage visited')
      }
    })
    expect(() => parseRoomSystemAudioFrame(input, 2)).toThrow('Invalid system audio frame.')
    expect(() => parseRoomSystemAudioFrame({ ...frame(), samples: [0] })).toThrow()
  })
  it('Carries the S13a shared clock: nullable origin, its incarnation, safe sums', () => {
    expect(ROOM_SYSTEM_AUDIO.clock).toEqual(fixture.clock)
    expect(fixture.clockQualification).toBe('unavailable')
    const parsed = parseRoomSystemAudioFrame(frame(3))
    expect(systemNativeCaptureUs(parsed)).toBe(2_000_000 + parsed.firstSampleUs)
    const absent = parseRoomSystemAudioFrame({ ...frame(3), originUs: null, incarnation: null })
    expect(systemNativeCaptureUs(absent)).toBeNull()
    for (const patch of [
      { originUs: 5, incarnation: null },
      { incarnation: 0 },
      { originUs: -1 },
      { originUs: Number.MAX_SAFE_INTEGER - 50_000 },
      { originUs: undefined },
      { incarnation: undefined }
    ])
      expect(() => parseRoomSystemAudioFrame({ ...frame(), ...patch })).toThrow()
  })
  it('Keeps stereo separation and renders silence after consumption, never old chunks', () => {
    const b = new RoomSystemAudioBuffer(1)
    expect(b.push(frame())).toBe(true)
    const output = [new Float32Array(480), new Float32Array(480)]
    b.render(output)
    expect(output[0][0]).toBe(0.5)
    expect(output[1][0]).toBe(-0.5)
    b.render(output)
    expect(output.every((c) => c.every((v) => v === 0))).toBe(true)
    expect(b.counters.underrunFrames).toBe(480)
    expect(b.push(frame())).toBe(false)
  })
  it('Bounds stalled storage and counts overruns and gaps', () => {
    const b = new RoomSystemAudioBuffer(1)
    for (let i = 0; i < 8; i++) b.push(frame(i))
    expect(b.queuedFrames).toBe(1920)
    expect(b.counters.overrunFrames).toBe(1920)
    expect(b.samples.length).toBe(3840)
    b.push(frame(9, 48000))
    expect(b.queuedFrames).toBeLessThanOrEqual(1920)
    expect(b.counters.gapFrames).toBeGreaterThan(0)
    b.close()
    expect(b.push(frame(10))).toBe(false)
  })
  it('Leaves operator mute intact on clear and preserves deliberate auxiliary', () => {
    const settings = {
      speechGain: 1,
      auxiliaryGain: 0.5,
      speechMuted: false,
      auxiliaryMuted: false
    }
    expect(programAudioGains(settings, true)).toMatchObject({ speech: 0, auxiliary: 0.5 })
    expect(programAudioGains({ ...settings, speechMuted: true }, false).speech).toBe(0)
    expect(programAudioGains(null, true)).toMatchObject({ speech: 0, auxiliary: 0 })
    expect(programAudioGains(settings, false, true).reason).toBe('routing-unavailable')
  })
  it('Fences routing leases by owner and freshness', () => {
    const packet = {
      v: 1,
      show: 'show',
      publisherSid: 'PA_owner',
      sequence: 1,
      sentAt: 1000,
      speechGain: 1,
      auxiliaryGain: 1,
      speechMuted: false,
      auxiliaryMuted: false
    }
    expect(parseAudioRouting(packet, 'show', 'PA_owner', 1001)).toEqual(packet)
    expect(parseAudioRouting(packet, 'show', 'PA_successor', 1001)).toBeNull()
    expect(parseAudioRouting(packet, 'show', 'PA_owner', 4000)).toBeNull()
  })
})
