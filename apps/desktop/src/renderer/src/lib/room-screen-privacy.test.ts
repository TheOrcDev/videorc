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
  // Plan 210 D8 in a room: the host's own frosted look is made from the frame
  // it already published, handed on once, before the frost covers it.
  function lastFrameFixture(readyState: number) {
    const calls: string[] = []
    const video = { readyState, play: async () => {}, pause: vi.fn(), srcObject: null }
    const canvas = {
      getContext: () => ({
        drawImage: () => calls.push('draw'),
        fillRect: () => calls.push('frost')
      }),
      captureStream: () => ({ getVideoTracks: () => [{ stop: vi.fn() }] })
    }
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(public tracks: unknown[]) {}
      }
    )
    vi.stubGlobal('document', {
      createElement: (tag: string) => (tag === 'video' ? video : canvas)
    })
    vi.stubGlobal('window', globalThis)
    const raw = { getSettings: () => ({ width: 640, height: 360 }) } as MediaStreamTrack
    return { calls, canvas, raw }
  }
  it('hands the last published frame on once, before the frost, and frosts if the hook throws', async () => {
    vi.useFakeTimers()
    const { calls, canvas, raw } = lastFrameFixture(2)
    const gate = new ScreenPrivacyDecision()
    gate.apply({ hidden: false, generation: 0 })
    const lastFrame = vi.fn((last: HTMLCanvasElement) => {
      calls.push(last === (canvas as unknown) ? 'last' : 'other')
      throw new Error('no copy')
    })
    const adapter = createPrivateScreen(raw, gate, vi.fn(), lastFrame)
    await vi.advanceTimersByTimeAsync(40)
    calls.length = 0
    gate.hide()
    expect(lastFrame).toHaveBeenCalledOnce()
    expect(calls).toEqual(['last', 'frost'])
    adapter.block()
    expect(lastFrame).toHaveBeenCalledOnce()
    adapter.close()
  })
  it('hands nothing on before a frame was drawn, or when it starts hidden', async () => {
    vi.useFakeTimers()
    const { raw } = lastFrameFixture(0)
    const gate = new ScreenPrivacyDecision()
    gate.apply({ hidden: false, generation: 0 })
    const early = vi.fn()
    const first = createPrivateScreen(raw, gate, vi.fn(), early)
    await vi.advanceTimersByTimeAsync(100)
    gate.hide()
    const late = vi.fn()
    const second = createPrivateScreen(raw, gate, vi.fn(), late)
    await vi.advanceTimersByTimeAsync(100)
    second.block()
    expect(early).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    first.close()
    second.close()
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
