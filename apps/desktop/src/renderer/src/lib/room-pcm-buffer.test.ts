import { describe, expect, it } from 'vitest'
import { RoomPcmBuffer } from './room-pcm-buffer'
import {
  ROOM_PCM,
  parseRoomPcmCommand,
  parseRoomPcmFrame,
  roomPcmCommand,
  type RoomPcmFrame
} from '../../../shared/room-pcm'
import fixture from '../../../../../../protocol-fixtures/room-pcm.json'
const frame = (sequence = 0, generation = 1): RoomPcmFrame => ({
  generation,
  sequence,
  firstSample: sequence * 480,
  firstSampleUs: sequence * 10000,
  observedAtUs: (sequence + 1) * 10000,
  sampleRate: 48000,
  channels: 1,
  frames: 480,
  droppedFrames: 0,
  samples: Array(480).fill(0.25)
})
describe('bounded PCM contract', () => {
  it('matches the portable fixture and refuses malformed metadata before reading samples', () => {
    expect(ROOM_PCM).toEqual(fixture)
    expect(parseRoomPcmCommand(roomPcmCommand('open', 1)).action).toBe('open')
    for (const patch of [
      { role: 'guest' },
      { frames: 100000000 },
      { sampleRate: 44100 },
      { generation: -1 },
      { extra: 1 }
    ])
      expect(() => parseRoomPcmCommand({ ...roomPcmCommand('open', 1), ...patch })).toThrow()
    const stale = {
      ...frame(),
      generation: 2,
      get samples(): number[] {
        throw new Error('Samples accessed')
      }
    }
    expect(() => parseRoomPcmFrame(stale, 1)).toThrow('Invalid PCM frame')
    for (const patch of [
      { firstSampleUs: 1 },
      { samples: [0] },
      { samples: Array(480).fill(NaN) },
      { samples: Array(480).fill(2) }
    ])
      expect(() => parseRoomPcmFrame({ ...frame(), ...patch }, 1)).toThrow()
  })
  it('keeps continuity across quantum boundaries and fills underruns with silence', () => {
    const ring = new RoomPcmBuffer(1)
    ring.push(frame())
    const out = new Float32Array(128)
    for (let i = 0; i < 3; i++) {
      ring.render(out)
      expect([...out]).toEqual(Array(128).fill(0.25))
    }
    ring.render(out)
    expect([...out.slice(0, 96)]).toEqual(Array(96).fill(0.25))
    expect([...out.slice(96)]).toEqual(Array(32).fill(0))
    expect(ring.counters.underrunFrames).toBe(32)
    ring.push(frame(1))
    expect(ring.queuedFrames).toBe(448) // Late samples are never replayed.
    ring.close()
    ring.render(out)
    expect([...out]).toEqual(Array(128).fill(0))
    expect(ring.push(frame(2))).toBe(false)
  })
  it('bounds large jumps, drops oldest with explicit counters, and rejects replay/epoch changes', () => {
    const ring = new RoomPcmBuffer(1)
    ring.push(frame())
    ring.push(frame(100000))
    expect(ring.queuedFrames).toBe(1920)
    expect(ring.counters.overrunFrames).toBeGreaterThan(0)
    expect(ring.counters.gapFrames).toBeGreaterThan(0)
    expect(ring.push(frame(100000))).toBe(false)
    expect(ring.push(frame(100001, 2))).toBe(false)
    const out = new Float32Array(1920)
    ring.render(out)
    expect([...out.slice(0, 1440)]).toEqual(Array(1440).fill(0))
    expect([...out.slice(1440)]).toEqual(Array(480).fill(0.25))
  })
})
