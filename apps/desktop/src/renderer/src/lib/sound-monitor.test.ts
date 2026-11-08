import { describe, expect, it, vi } from 'vitest'

import type { Sound, SoundboardState, SoundVoice } from './backend'
import {
  MONITOR_IDLE_SUSPEND_MS,
  MONITOR_LATE_JOIN_MS,
  createSoundMonitor,
  decodedSoundBytes,
  MONITOR_CACHE_BYTES,
  dbToGain,
  monitorHears,
  monitorPlan,
  monitorStartOffsetSeconds,
  voiceGainDb,
  type SoundMonitorDeps
} from './sound-monitor'
import type { SoundboardSnapshot } from './soundboard-store'

// Plan 189 "Hearing it yourself": the decisions are pure; the lifecycle runs
// on a fake AudioContext so the tests hear nothing.

const voice = (
  voiceId: string,
  soundId: string,
  overrides: Partial<SoundVoice> = {}
): SoundVoice => ({
  voiceId,
  soundId,
  startedAtMs: 10_000,
  durationMs: 1610,
  loop: false,
  onAir: false,
  ...overrides
})

describe('the monitor decisions', () => {
  it('plays the bus gain: auto level plus the sound trim plus the board level, in dB', () => {
    expect(voiceGainDb({ levelDb: -2.7, volumeDb: -3 }, 6)).toBeCloseTo(0.3)
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
    expect(dbToGain(20)).toBeCloseTo(10)
  })

  it('always hears a sound off air, and an on-air one only with the monitor on', () => {
    expect(monitorHears({ onAir: false }, false)).toBe(true)
    expect(monitorHears({ onAir: true }, true)).toBe(true)
    expect(monitorHears({ onAir: true }, false)).toBe(false)
  })

  it('starts the new voices it hears and stops the ones that left or it no longer hears', () => {
    const has = (id: string): boolean => id !== 'gone'
    const plan = monitorPlan(
      new Set(['v-old', 'v-keep', 'v-air']),
      [
        voice('v-keep', 'a'),
        voice('v-new', 'b'),
        voice('v-air', 'c', { onAir: true }),
        voice('v-gone', 'gone')
      ],
      false,
      has
    )
    expect(plan.start.map((entry) => entry.voiceId)).toEqual(['v-new'])
    expect(plan.stop.sort()).toEqual(['v-air', 'v-old'])
    expect(
      monitorPlan(new Set(), [voice('v-air', 'c', { onAir: true })], true, has).start
    ).toHaveLength(1)
  })

  it('plays a fresh press from the top and joins a late one where the bus is', () => {
    const fresh = voice('v', 'a')
    expect(monitorStartOffsetSeconds(fresh, 10_000 + MONITOR_LATE_JOIN_MS, 1.61)).toBe(0)
    expect(monitorStartOffsetSeconds(fresh, 11_000, 1.61)).toBeCloseTo(1)
    expect(monitorStartOffsetSeconds(fresh, 20_000, 1.61)).toBe(1.61)
    expect(monitorStartOffsetSeconds({ ...fresh, loop: true }, 13_000, 2)).toBeCloseTo(1)
    expect(monitorStartOffsetSeconds(fresh, 11_000, 0)).toBe(0)
  })
})

type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }

function fakeAudio() {
  const sources: Array<
    FakeNode & {
      buffer: unknown
      loop: boolean
      start: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      onended: (() => void) | null
    }
  > = []
  const gains: Array<
    FakeNode & {
      gain: {
        value: number
        cancelScheduledValues: ReturnType<typeof vi.fn>
        setValueAtTime: ReturnType<typeof vi.fn>
        linearRampToValueAtTime: ReturnType<typeof vi.fn>
      }
      context: { currentTime: number }
    }
  > = []
  const context = {
    state: 'running' as AudioContextState,
    currentTime: 5,
    destination: {},
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({ duration: bytes.byteLength / 1000 })),
    createBufferSource: () => {
      const source = {
        buffer: null as unknown,
        loop: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null
      }
      sources.push(source)
      return source
    },
    createGain: () => {
      const node = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        context: { currentTime: 5 },
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn()
        }
      }
      gains.push(node)
      return node
    }
  }
  return { context, sources, gains }
}

const sound = (id: string, overrides: Partial<Sound> = {}): Sound => ({
  id,
  name: id,
  file: `${id}.wav`,
  durationMs: 1610,
  loudnessLufs: -15.3,
  levelDb: -2.7,
  volumeDb: 0,
  mode: 'oneShot',
  sortOrder: 0,
  createdAt: '2026-10-23T09:00:00Z',
  updatedAt: '2026-10-23T09:00:00Z',
  ...overrides
})

const snapshot = (
  voices: SoundVoice[],
  board: Partial<SoundboardState> = {}
): SoundboardSnapshot => ({
  board: {
    sounds: [sound('a'), sound('b')],
    volumeDb: 0,
    monitor: true,
    startersSeeded: true,
    ...board
  },
  voices,
  hidden: new Set(),
  online: true,
  sessionWithoutSounds: false
})

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function monitorWithFakes() {
  const audio = fakeAudio()
  const timers: Array<{ callback: () => void; delayMs: number }> = []
  const deps: SoundMonitorDeps = {
    createContext: vi.fn(() => audio.context as unknown as AudioContext),
    fetchBytes: vi.fn(async () => new ArrayBuffer(1610)),
    now: () => 10_000,
    setTimer: (callback, delayMs) => timers.push({ callback, delayMs }),
    clearTimer: () => undefined
  }
  return { audio, deps, timers, monitor: createSoundMonitor(deps) }
}

describe('the monitor (plan 189)', () => {
  it('opens no AudioContext until a voice plays, then plays it at the bus gain', async () => {
    const { audio, deps, monitor } = monitorWithFakes()
    monitor.update(snapshot([]))
    expect(deps.createContext).not.toHaveBeenCalled()
    monitor.update(snapshot([voice('v-1', 'a')], { volumeDb: 3 }))
    await flush()
    expect(deps.fetchBytes).toHaveBeenCalledWith('videorc-asset://sound/a.wav')
    expect(audio.sources).toHaveLength(1)
    expect(audio.sources[0].start).toHaveBeenCalledWith(0, 0)
    expect(audio.gains[0].gain.value).toBeCloseTo(dbToGain(-2.7 + 0 + 3))
  })

  it('decodes a sound once per edit, and stops a voice that leaves with a 5 ms fade', async () => {
    const { audio, deps, monitor } = monitorWithFakes()
    monitor.update(snapshot([voice('v-1', 'a')]))
    await flush()
    monitor.update(snapshot([]))
    expect(audio.sources[0].stop).toHaveBeenCalledWith(5.005)
    expect(audio.gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 5.005)
    // D7: a restart is a new voice; the buffer is reused.
    monitor.update(snapshot([voice('v-2', 'a')]))
    await flush()
    expect(deps.fetchBytes).toHaveBeenCalledTimes(1)
    // A re-import (a new updatedAt) decodes again.
    monitor.update(
      snapshot([voice('v-3', 'a')], {
        sounds: [sound('a', { updatedAt: '2026-10-23T10:00:00Z' }), sound('b')]
      })
    )
    await flush()
    expect(deps.fetchBytes).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 64 MB of decoded audio, least recently played out first', async () => {
    const { deps, monitor } = monitorWithFakes()
    // Six 30 s sounds are about 69 MB decoded: the first one played leaves.
    const sounds = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => sound(id, { durationMs: 30_000 }))
    expect(decodedSoundBytes(sounds[0]) * 6).toBeGreaterThan(MONITOR_CACHE_BYTES)
    for (const [index, entry] of sounds.entries()) {
      monitor.update(snapshot([voice(`v-${index}`, entry.id)], { sounds }))
      await flush()
    }
    expect(deps.fetchBytes).toHaveBeenCalledTimes(6)
    monitor.update(snapshot([voice('v-f2', 'f')], { sounds }))
    await flush()
    expect(deps.fetchBytes).toHaveBeenCalledTimes(6)
    monitor.update(snapshot([voice('v-a2', 'a')], { sounds }))
    await flush()
    expect(deps.fetchBytes).toHaveBeenCalledTimes(7)
    expect(deps.fetchBytes).toHaveBeenLastCalledWith('videorc-asset://sound/a.wav')
  })

  it('stays quiet for an on-air voice with the monitor off, and glides a level change', async () => {
    const { audio, monitor } = monitorWithFakes()
    monitor.update(snapshot([voice('v-air', 'a', { onAir: true })], { monitor: false }))
    await flush()
    expect(audio.sources).toHaveLength(0)
    monitor.update(snapshot([voice('v-air', 'a', { onAir: true })], { monitor: true }))
    await flush()
    expect(audio.sources).toHaveLength(1)
    monitor.update(snapshot([voice('v-air', 'a', { onAir: true })], { volumeDb: -6 }))
    expect(audio.gains[0].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(
      dbToGain(-2.7 - 6),
      5.01
    )
    // Off again mid-sound: it fades out.
    monitor.update(snapshot([voice('v-air', 'a', { onAir: true })], { monitor: false }))
    expect(audio.sources[0].stop).toHaveBeenCalled()
  })

  it('never starts a voice that stopped while it decoded, and suspends once idle', async () => {
    const { audio, monitor, timers } = monitorWithFakes()
    monitor.update(snapshot([voice('v-1', 'a')]))
    monitor.update(snapshot([]))
    await flush()
    expect(audio.sources).toHaveLength(0)
    const idle = timers.find((timer) => timer.delayMs === MONITOR_IDLE_SUSPEND_MS)
    idle?.callback()
    expect(audio.context.suspend).toHaveBeenCalled()
    monitor.dispose()
    expect(audio.context.close).toHaveBeenCalled()
  })

  it('says once per sound when it cannot play one, instead of only logging (release test 147)', async () => {
    const { deps } = monitorWithFakes()
    const unplayable = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const monitor = createSoundMonitor({
      ...deps,
      fetchBytes: vi.fn(async () => {
        throw new Error('The sound file answered 404.')
      }),
      onUnplayable: unplayable
    })
    monitor.update(snapshot([voice('v-1', 'a')]))
    await flush()
    monitor.update(snapshot([]))
    monitor.update(snapshot([voice('v-2', 'a')]))
    await flush()
    expect(unplayable).toHaveBeenCalledTimes(1)
    expect(unplayable.mock.calls[0][0]).toMatchObject({ id: 'a', name: 'a' })
    warn.mockRestore()
  })

  it('says nothing for a load it stopped waiting for', async () => {
    const { deps } = monitorWithFakes()
    const unplayable = vi.fn()
    let fail!: (error: Error) => void
    const monitor = createSoundMonitor({
      ...deps,
      fetchBytes: vi.fn(() => new Promise<ArrayBuffer>((_resolve, reject) => (fail = reject))),
      onUnplayable: unplayable
    })
    monitor.update(snapshot([voice('v-1', 'a')]))
    await flush()
    // The voice ends before its file fails to load.
    monitor.update(snapshot([]))
    fail(new Error('The sound file answered 404.'))
    await flush()
    expect(unplayable).not.toHaveBeenCalled()
    // After dispose, a failing load says nothing either.
    monitor.update(snapshot([voice('v-2', 'b')]))
    await flush()
    monitor.dispose()
    fail(new Error('The sound file answered 404.'))
    await flush()
    expect(unplayable).not.toHaveBeenCalled()
  })
})
