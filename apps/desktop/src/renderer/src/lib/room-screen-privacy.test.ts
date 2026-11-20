import fixture from '../../../../../../protocol-fixtures/cloud-parity-privacy.json'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ScreenPrivacyDecision,
  createPrivateScreen,
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
  // PH-13 (perf hunt 11-20): with frame callbacks, one draw per captured
  // frame and no timer draw between them; the 30 Hz timer takes over only
  // when callbacks stop. Every draw still passes the gate.
  it('draws once per captured frame and falls back to the timer when frames stop', async () => {
    vi.useFakeTimers()
    const raw = { getSettings: () => ({ width: 640, height: 360 }) } as MediaStreamTrack
    const output = { stop: vi.fn() }
    const drawImage = vi.fn(),
      fillRect = vi.fn()
    let pending: ((now: number) => void) | null = null
    let handles = 0
    const video = {
      readyState: 2,
      play: async () => {},
      pause: vi.fn(),
      srcObject: null,
      requestVideoFrameCallback: (callback: (now: number) => void) => {
        pending = callback
        return ++handles
      },
      cancelVideoFrameCallback: vi.fn()
    }
    let clock = 0
    const frame = async (gapMs: number): Promise<void> => {
      clock += gapMs
      await vi.advanceTimersByTimeAsync(gapMs)
      const callback = pending
      pending = null
      callback?.(clock)
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

    // A 30 fps capture for one second, a little jittery: 30 frames, 30 draws.
    for (let index = 0; index < 30; index += 1) await frame(index % 2 ? 41 : 25)
    expect(drawImage).toHaveBeenCalledTimes(30)

    // A 60 fps capture: every other frame.
    drawImage.mockClear()
    for (let index = 0; index < 30; index += 1) await frame(1000 / 60)
    expect(drawImage).toHaveBeenCalledTimes(15)

    // The screen goes still: no draw for about 100 ms, then the timer's 30 Hz.
    drawImage.mockClear()
    await vi.advanceTimersByTimeAsync(90)
    expect(drawImage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(28)

    // Hidden: frames frost, never draw the capture.
    drawImage.mockClear()
    const frosted = fillRect.mock.calls.length
    gate.hide()
    for (let index = 0; index < 5; index += 1) await frame(1000 / 30)
    expect(drawImage).not.toHaveBeenCalled()
    expect(fillRect.mock.calls.length).toBeGreaterThan(frosted + 5)

    adapter.close()
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(handles)
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
