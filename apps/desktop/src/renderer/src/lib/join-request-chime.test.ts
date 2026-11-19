import { describe, expect, it, vi } from 'vitest'

import {
  JOIN_CHIME_MIN_GAP_MS,
  JOIN_CHIME_NOTES,
  JOIN_CHIME_PEAK_GAIN,
  createJoinRequestChime,
  playJoinChime,
  scheduleJoinChime,
  type ChimeAudioContext
} from './join-request-chime'

// The chime runs on a fake AudioContext, so the tests hear nothing.

type FakeParam = { calls: [string, number, number][] } & Record<
  'setValueAtTime' | 'exponentialRampToValueAtTime',
  (value: number, at: number) => void
>
const fakeParam = (): FakeParam => {
  const calls: [string, number, number][] = []
  return {
    calls,
    setValueAtTime: (value, at) => void calls.push(['set', value, at]),
    exponentialRampToValueAtTime: (value, at) => void calls.push(['ramp', value, at])
  }
}

function fakeContext() {
  const destination = { name: 'destination' }
  const oscillators: {
    type: string
    frequency: FakeParam
    connectedTo: unknown[]
    started: number[]
    stopped: number[]
    disconnected: boolean
    onended: (() => void) | null
  }[] = []
  const gains: { gain: FakeParam; connectedTo: unknown[]; disconnected: boolean }[] = []
  const context = {
    currentTime: 5,
    destination,
    createOscillator() {
      const oscillator = {
        type: '',
        frequency: fakeParam(),
        connectedTo: [] as unknown[],
        started: [] as number[],
        stopped: [] as number[],
        disconnected: false,
        onended: null as (() => void) | null,
        connect(node: unknown) {
          oscillator.connectedTo.push(node)
        },
        disconnect() {
          oscillator.disconnected = true
        },
        start(at: number) {
          oscillator.started.push(at)
        },
        stop(at: number) {
          oscillator.stopped.push(at)
        }
      }
      oscillators.push(oscillator)
      return oscillator
    },
    createGain() {
      const gain = {
        gain: fakeParam(),
        connectedTo: [] as unknown[],
        disconnected: false,
        connect(node: unknown) {
          gain.connectedTo.push(node)
        },
        disconnect() {
          gain.disconnected = true
        }
      }
      gains.push(gain)
      return gain
    },
    close: vi.fn(async () => {})
  }
  const endAll = () => oscillators.forEach((oscillator) => oscillator.onended?.())
  return {
    context: context as unknown as ChimeAudioContext & AudioContext,
    destination,
    oscillators,
    gains,
    endAll
  }
}

describe('join request chime', () => {
  it('rings once for requests that land together, and again after the gap', () => {
    let now = 1_000
    const play = vi.fn()
    const chime = createJoinRequestChime({ now: () => now, play })

    expect(chime.ring()).toBe(true)
    now += 10
    expect(chime.ring()).toBe(false)
    now += JOIN_CHIME_MIN_GAP_MS - 20
    expect(chime.ring()).toBe(false)
    expect(play).toHaveBeenCalledTimes(1)

    now += 10
    expect(chime.ring()).toBe(true)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('plays each note through its own gain straight to the output, no louder than the peak', () => {
    const fake = fakeContext()
    void scheduleJoinChime(fake.context)

    expect(fake.oscillators).toHaveLength(JOIN_CHIME_NOTES.length)
    fake.oscillators.forEach((oscillator, index) => {
      const note = JOIN_CHIME_NOTES[index]
      const gain = fake.gains[index]
      expect(oscillator.type).toBe('sine')
      expect(oscillator.frequency.calls[0]?.[1]).toBe(note.hz)
      expect(oscillator.connectedTo).toEqual([gain])
      expect(gain.connectedTo).toEqual([fake.destination])
      // Scheduled ahead of the context clock, and stopped after the fade.
      expect(oscillator.started[0]).toBeGreaterThan(fake.context.currentTime)
      expect(oscillator.stopped[0]).toBeGreaterThan(oscillator.started[0] + note.lengthS)
      const levels = gain.gain.calls.map(([, value]) => value)
      expect(Math.max(...levels)).toBe(JOIN_CHIME_PEAK_GAIN)
      // It fades back to silence instead of cutting off with a click.
      expect(levels.at(-1)).toBeLessThan(0.001)
    })
  })

  it('lets go of every node once the notes end', async () => {
    const fake = fakeContext()
    const done = scheduleJoinChime(fake.context)
    fake.endAll()
    await done

    expect(fake.oscillators.every((oscillator) => oscillator.disconnected)).toBe(true)
    expect(fake.gains.every((gain) => gain.disconnected)).toBe(true)
  })

  it('closes its context after the chime, so no output stays open between requests', async () => {
    const fake = fakeContext()
    playJoinChime(() => fake.context)
    expect(fake.context.close).not.toHaveBeenCalled()

    fake.endAll()
    await vi.waitFor(() => expect(fake.context.close).toHaveBeenCalledTimes(1))
  })

  it('warns instead of throwing when no audio output can be made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      playJoinChime(() => {
        throw new Error('no audio device')
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[talk-show] the join chime could not play',
      'no audio device'
    )
    warn.mockRestore()
  })
})
