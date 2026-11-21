import fixture from '../../../../../../protocol-fixtures/cloud-parity-privacy.json'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPrivateScreen } from './room-private-screen'
import {
  ScreenPrivacyDecision,
  privacyTrackName,
  privacyObservationMatches
} from './room-screen-privacy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('browser publication privacy authority', () => {
  it('starts closed and never lets an old backend or stale Show reopen Hide', () => {
    const gate = new ScreenPrivacyDecision()
    expect(gate.hidden).toBe(true)
    gate.apply({ hidden: false })
    expect(gate.hidden).toBe(true)
    gate.apply({ hidden: false, generation: 0 })
    const hide = gate.hide()
    gate.apply({ hidden: false, generation: 0 })
    expect(gate.hidden).toBe(true)
    gate.apply({ hidden: true, generation: 1 }, hide)
    gate.apply({ hidden: false, generation: 0 })
    expect(gate.hidden).toBe(true)
    const show = gate.showIntent()
    gate.hide()
    gate.apply({ hidden: false, generation: 2 }, show, true)
    expect(gate.hidden).toBe(true)
  })
  it('recovers a failed Hide only with an explicit current Show, including backend restart', () => {
    const gate = new ScreenPrivacyDecision()
    gate.apply({ hidden: true, generation: 9 })
    gate.hide()
    gate.apply({ hidden: false, generation: 0 })
    expect(gate.hidden).toBe(true)
    gate.apply({ hidden: false, generation: 0 }, gate.showIntent(), true)
    expect(gate.hidden).toBe(false)
  })
  it('blocks synchronously and never reopens an old canvas on Show', async () => {
    vi.useFakeTimers()
    const raw = { getSettings: () => ({ width: 640, height: 360 }) } as MediaStreamTrack
    const output = { stop: vi.fn() }
    const drawImage = vi.fn(),
      fillRect = vi.fn()
    const video = { readyState: 2, play: async () => {}, pause: vi.fn(), srcObject: null }
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(public tracks: unknown[]) {}
      }
    )
    vi.stubGlobal('document', {
      createElement: (tag: string) =>
        tag === 'video'
          ? video
          : {
              getContext: () => ({ drawImage, fillRect }),
              captureStream: () => ({ getVideoTracks: () => [output] })
            }
    })
    vi.stubGlobal('window', globalThis)
    const gate = new ScreenPrivacyDecision()
    gate.apply({ hidden: false, generation: 0 })
    const adapter = createPrivateScreen(raw, gate, vi.fn())
    await vi.advanceTimersByTimeAsync(40)
    expect(drawImage).toHaveBeenCalledOnce()
    const hide = gate.hide()
    expect(fillRect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(drawImage).toHaveBeenCalledOnce()
    gate.apply({ hidden: true, generation: 1 }, hide)
    gate.apply({ hidden: false, generation: 2 }, gate.showIntent(), true)
    await vi.advanceTimersByTimeAsync(100)
    expect(drawImage).toHaveBeenCalledOnce()
    adapter.close()
    expect(output.stop).toHaveBeenCalled()
  })
  // PH-13 (perf hunt 11-20): each captured frame is drawn once (no frame
  // sent twice, none skipped at 30 fps), at most 30 draws a second; after
  // about 100 ms of a still screen the 30 Hz repaint is back. Every draw
  // still passes the gate.
  it('draws each captured frame once and repaints a still screen at 30 Hz', async () => {
    vi.useFakeTimers()
    const raw = { getSettings: () => ({ width: 640, height: 360 }) } as MediaStreamTrack
    const output = { stop: vi.fn() }
    let frames = 0
    const drawn: number[] = []
    const drawImage = vi.fn(() => drawn.push(frames)),
      fillRect = vi.fn()
    const video = {
      readyState: 2,
      play: async () => {},
      pause: vi.fn(),
      srcObject: null,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: frames })
    }
    // The capture's own clock: a frame every `gaps[i]` ms, off the timer's grid.
    const capture = async (gaps: number[]): Promise<void> => {
      for (const gap of gaps) {
        await vi.advanceTimersByTimeAsync(gap)
        frames += 1
      }
    }
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(public tracks: unknown[]) {}
      }
    )
    vi.stubGlobal('document', {
      createElement: (tag: string) =>
        tag === 'video'
          ? video
          : {
              getContext: () => ({ drawImage, fillRect }),
              captureStream: () => ({ getVideoTracks: () => [output] })
            }
    })
    vi.stubGlobal('window', globalThis)
    const gate = new ScreenPrivacyDecision()
    gate.apply({ hidden: false, generation: 0 })
    const adapter = createPrivateScreen(raw, gate, vi.fn())
    const duplicates = (): number => drawn.length - new Set(drawn).size

    // One second of a 30 fps capture, a little jittery: every frame, once.
    await capture(Array.from({ length: 30 }, (_, index) => (index % 2 ? 37 : 29.6)))
    await vi.advanceTimersByTimeAsync(20)
    expect(duplicates()).toBe(0)
    expect(drawn.slice(1)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))

    // A 60 fps capture: never more than 30 draws a second, none twice.
    drawn.length = 0
    await capture(Array.from({ length: 60 }, () => 1000 / 60))
    expect(drawn.length).toBeLessThanOrEqual(31)
    expect(drawn.length).toBeGreaterThanOrEqual(29)
    expect(duplicates()).toBe(0)

    // The screen goes still: the newest frame once (it came during the
    // cap), then nothing for about 100 ms, then 30 Hz again.
    await vi.advanceTimersByTimeAsync(20)
    expect(drawn.at(-1)).toBe(frames)
    drawn.length = 0
    await vi.advanceTimersByTimeAsync(70)
    expect(drawn).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawn.length).toBeGreaterThanOrEqual(28)
    expect(drawn.length).toBeLessThanOrEqual(31)

    // Hidden: every tick frosts, nothing of the capture is drawn.
    drawn.length = 0
    const frosted = fillRect.mock.calls.length
    gate.hide()
    await capture(Array.from({ length: 10 }, () => 1000 / 30))
    expect(drawn).toEqual([])
    expect(fillRect.mock.calls.length).toBeGreaterThan(frosted + 5)

    adapter.close()
    expect(output.stop).toHaveBeenCalled()
  })
  it('binds observations to the exact capture epoch and generation', () => {
    const expected = { epoch: 'a'.repeat(32), generation: 3, hidden: true }
    expect(privacyTrackName(expected)).toBe(`vrc-privacy:${expected.epoch}:3:1`)
    expect(
      privacyObservationMatches({ ...expected, receiver: 'program:wide', appliedAt: 20 }, expected)
    ).toBe(true)
    expect(
      privacyObservationMatches(
        { ...expected, generation: 2, receiver: 'program:wide', appliedAt: 20 },
        expected
      )
    ).toBe(false)
    expect(
      privacyObservationMatches(
        { ...expected, epoch: 'b'.repeat(32), receiver: 'g_1', appliedAt: 20 },
        expected
      )
    ).toBe(false)
  })
})

it('matches the paired web privacy wire fixture without merging source and receiver acknowledgement', () => {
  expect(privacyTrackName(fixture.publication)).toBe(fixture.trackName)
  expect(privacyObservationMatches(fixture.sourceBlocked, fixture.publication)).toBe(false)
  expect(privacyObservationMatches(fixture.programObservation, fixture.publication)).toBe(true)
  expect(privacyObservationMatches(fixture.guestObservation, fixture.publication)).toBe(true)
})
