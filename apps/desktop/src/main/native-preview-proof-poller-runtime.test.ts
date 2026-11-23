import { describe, expect, it, vi } from 'vitest'

import { NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT } from './native-preview-proof-poller-runtime'

type RuntimePoller = {
  image: {
    src: string
    dataset: { live: string }
    removeAttribute: ReturnType<typeof vi.fn>
  }
  cancelled: boolean
  abortController: { abort: ReturnType<typeof vi.fn> }
  objectUrl: string | null
  startedAt: number
  lastFrameAdvanceAt: number | null
  lastTransportSuccessAt: number | null
}

type ProofPollerRuntime = {
  stopLayerPoller: (
    id: string,
    options?: { preserveFrame?: boolean }
  ) => Partial<RuntimePoller> | null
  markProofPollerTransportSuccess: (poller: RuntimePoller, now: number) => void
  presentProofPollerFrame: (poller: RuntimePoller, objectUrl: string) => void
  proofImageIsBlank: (image: { naturalWidth: number; naturalHeight: number }) => boolean
  proofPollerFrameAgeMs: (poller: RuntimePoller, now: number) => number
  proofPollerTransportAgeMs: (poller: RuntimePoller, now: number) => number
  proofPollerFrameIsFresh: (
    poller: RuntimePoller,
    now: number,
    freshnessBudgetMs: number
  ) => boolean
  proofPollerTransportIsFresh: (
    poller: RuntimePoller,
    now: number,
    freshnessBudgetMs: number
  ) => boolean
  proofPollersHaveCompleteFrameHistory: (pollers: Map<string, RuntimePoller>) => boolean
  markProofPollerRequestStarted: (poller: RuntimePoller) => void
  markProofPollerNotModified: (poller: RuntimePoller) => void
  markProofPollerFrameDecoded: (
    poller: RuntimePoller,
    byteLength: number,
    width: number,
    height: number,
    now: number
  ) => void
  proofPollerTransportTotals: (pollers: Map<string, RuntimePoller>) => {
    requestCount: number
    notModifiedCount: number
    bytesReceived: number
    decodedFrames: number
    sourceDimensions: Record<string, { width: number; height: number }>
  }
}

function loadRuntime(
  pollers: Map<string, RuntimePoller>,
  revokeObjectURL: (url: string) => void,
  alphaValues: number[] = [255]
): ProofPollerRuntime {
  const createRuntime = new Function(
    'pollers',
    'URL',
    'document',
    `${NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT}\nreturn {
      stopLayerPoller,
      markProofPollerTransportSuccess,
      presentProofPollerFrame,
      proofImageIsBlank,
      proofPollerFrameAgeMs,
      proofPollerTransportAgeMs,
      proofPollerFrameIsFresh,
      proofPollerTransportIsFresh,
      proofPollersHaveCompleteFrameHistory,
      markProofPollerRequestStarted,
      markProofPollerNotModified,
      markProofPollerFrameDecoded,
      proofPollerTransportTotals
    };`
  )
  const pixels = new Uint8ClampedArray(8 * 8 * 4)
  for (let index = 0; index < 8 * 8; index += 1) {
    pixels[index * 4 + 3] = alphaValues[index % alphaValues.length] ?? 0
  }
  const document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: () => ({ data: pixels })
      })
    })
  }
  return createRuntime(pollers, { revokeObjectURL }, document) as ProofPollerRuntime
}

function poller(): RuntimePoller {
  return {
    image: {
      src: 'blob:frame-1',
      dataset: { live: '1' },
      removeAttribute: vi.fn()
    },
    cancelled: false,
    abortController: { abort: vi.fn() },
    objectUrl: 'blob:frame-1',
    startedAt: 100,
    lastFrameAdvanceAt: 500,
    lastTransportSuccessAt: 500
  }
}

describe('Windows proof poller runtime', () => {
  it('transfers the last decoded frame when a poller is superseded', () => {
    const current = poller()
    const pollers = new Map([['screen', current]])
    const revokeObjectURL = vi.fn()
    const runtime = loadRuntime(pollers, revokeObjectURL)

    const preserved = runtime.stopLayerPoller('screen', { preserveFrame: true })

    expect(current.abortController.abort).toHaveBeenCalledOnce()
    expect(current.image.removeAttribute).not.toHaveBeenCalled()
    expect(current.image.dataset.live).toBe('1')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(preserved).toMatchObject({
      objectUrl: 'blob:frame-1',
      startedAt: 100,
      lastFrameAdvanceAt: 500,
      lastTransportSuccessAt: 500
    })
    expect(pollers.has('screen')).toBe(false)

    const replacement = { ...current, ...preserved, cancelled: false }
    runtime.presentProofPollerFrame(replacement, 'blob:frame-2')
    expect(replacement.image.src).toBe('blob:frame-2')
    expect(replacement.image.dataset.live).toBe('1')
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
  })

  it('still releases the frame during real teardown', () => {
    const current = poller()
    const pollers = new Map([['screen', current]])
    const revokeObjectURL = vi.fn()
    const runtime = loadRuntime(pollers, revokeObjectURL)

    expect(runtime.stopLayerPoller('screen')).toBeNull()
    expect(current.image.removeAttribute).toHaveBeenCalledWith('src')
    expect(current.image.dataset.live).toBe('0')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1')
  })

  it('keeps 204 transport health separate from frame advancement', () => {
    const current = poller()
    const runtime = loadRuntime(new Map(), vi.fn())

    runtime.markProofPollerTransportSuccess(current, 2_000)

    expect(runtime.proofPollerTransportAgeMs(current, 2_000)).toBe(0)
    expect(runtime.proofPollerFrameAgeMs(current, 2_000)).toBe(1_500)
    expect(runtime.proofPollerTransportIsFresh(current, 2_000, 1_000)).toBe(true)
    expect(runtime.proofPollerFrameIsFresh(current, 2_000, 1_000)).toBe(false)
  })

  it('tracks first-frame history only for the active poller generation', () => {
    const established = poller()
    const replacement = { ...poller(), lastFrameAdvanceAt: established.lastFrameAdvanceAt }
    const newGeneration = { ...poller(), lastFrameAdvanceAt: null }
    const runtime = loadRuntime(new Map(), vi.fn())

    expect(runtime.proofPollersHaveCompleteFrameHistory(new Map([['screen', established]]))).toBe(
      true
    )
    expect(
      runtime.proofPollersHaveCompleteFrameHistory(
        new Map([
          ['screen', established],
          ['camera', newGeneration]
        ])
      )
    ).toBe(false)
    expect(runtime.proofPollersHaveCompleteFrameHistory(new Map([['screen', replacement]]))).toBe(
      true
    )
    expect(runtime.proofPollersHaveCompleteFrameHistory(new Map([['screen', newGeneration]]))).toBe(
      false
    )
    expect(runtime.proofPollersHaveCompleteFrameHistory(new Map())).toBe(false)
  })

  it('counts only decoded images with no visible pixels as blank', () => {
    const visible = loadRuntime(new Map(), vi.fn(), [0, 0, 255])
    const transparent = loadRuntime(new Map(), vi.fn(), [0])

    expect(visible.proofImageIsBlank({ naturalWidth: 640, naturalHeight: 360 })).toBe(false)
    expect(transparent.proofImageIsBlank({ naturalWidth: 640, naturalHeight: 360 })).toBe(true)
    expect(visible.proofImageIsBlank({ naturalWidth: 0, naturalHeight: 0 })).toBe(true)
  })
})

describe('proof poller transport accounting', () => {
  function poller(): RuntimePoller {
    return {
      image: { src: '', dataset: { live: '0' }, removeAttribute: vi.fn() },
      cancelled: false,
      abortController: { abort: vi.fn() },
      objectUrl: null,
      startedAt: 0,
      lastFrameAdvanceAt: null,
      lastTransportSuccessAt: null
    }
  }

  it('aggregates request, not-modified, byte, and decode totals per surface', () => {
    const pollers = new Map<string, RuntimePoller>()
    const runtime = loadRuntime(pollers, () => {})
    const screen = poller()
    const camera = poller()
    pollers.set('screen', screen)
    pollers.set('camera', camera)

    runtime.markProofPollerRequestStarted(screen)
    runtime.markProofPollerRequestStarted(screen)
    runtime.markProofPollerRequestStarted(camera)
    runtime.markProofPollerNotModified(screen)
    runtime.markProofPollerFrameDecoded(screen, 8_294_454, 1920, 1080, 1000)
    runtime.markProofPollerFrameDecoded(camera, 3_686_454, 1280, 720, 1001)

    expect(runtime.proofPollerTransportTotals(pollers)).toEqual({
      requestCount: 3,
      notModifiedCount: 1,
      bytesReceived: 8_294_454 + 3_686_454,
      decodedFrames: 2,
      sourceDimensions: {
        screen: { width: 1920, height: 1080 },
        camera: { width: 1280, height: 720 }
      }
    })
  })

  it('ignores invalid byte lengths and dimensions without losing the decode count', () => {
    const pollers = new Map<string, RuntimePoller>()
    const runtime = loadRuntime(pollers, () => {})
    const layer = poller()
    pollers.set('layer', layer)

    runtime.markProofPollerFrameDecoded(layer, Number.NaN, 0, -1, 5)

    expect(runtime.proofPollerTransportTotals(pollers)).toEqual({
      requestCount: 0,
      notModifiedCount: 0,
      bytesReceived: 0,
      decodedFrames: 1,
      sourceDimensions: {}
    })
  })
})

// Plan 257 S3: the Linux transport's helpers, from the same injected script.
describe('Linux I420 transport helpers', () => {
  type Cursor = { generation: string; sequence: number }
  type Helpers = {
    proofPollerCursorIsNewer: (poller: Record<string, unknown>, cursor: Cursor | null) => boolean
    markProofPollerPresentedCursor: (poller: Record<string, unknown>, cursor: Cursor | null) => void
    proofI420IsBlankSampled: (poller: Record<string, unknown>, buffer: ArrayBuffer) => boolean
    proofSourceFps: (pollers: Map<string, Record<string, unknown>>, now: number) => number | null
    markProofPollerFrameDecoded: (
      poller: Record<string, unknown>,
      byteLength: number,
      width: number,
      height: number,
      now: number
    ) => void
  }
  const helpers = new Function(
    `${NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT}\nreturn { proofPollerCursorIsNewer, markProofPollerPresentedCursor, proofI420IsBlankSampled, proofSourceFps, markProofPollerFrameDecoded };`
  )() as Helpers

  it('never lets a late frame of the same run replace a newer one', () => {
    const layer: Record<string, unknown> = {}
    expect(helpers.proofPollerCursorIsNewer(layer, { generation: 'a', sequence: 5 })).toBe(true)
    helpers.markProofPollerPresentedCursor(layer, { generation: 'a', sequence: 5 })
    expect(helpers.proofPollerCursorIsNewer(layer, { generation: 'a', sequence: 4 })).toBe(false)
    expect(helpers.proofPollerCursorIsNewer(layer, { generation: 'a', sequence: 5 })).toBe(false)
    expect(helpers.proofPollerCursorIsNewer(layer, { generation: 'a', sequence: 6 })).toBe(true)
    // A new source run always replaces the picture, whatever its sequence.
    expect(helpers.proofPollerCursorIsNewer(layer, { generation: 'b', sequence: 1 })).toBe(true)
  })

  it('calls an all-zero luma row blank, on the first frame and then one in thirty', () => {
    const blank = new ArrayBuffer(64 * 64 * 3)
    const picture = new Uint8Array(64 * 64 * 3).fill(16).buffer
    const layer: Record<string, unknown> = {}
    expect(helpers.proofI420IsBlankSampled(layer, blank)).toBe(true)
    for (let frame = 1; frame < 30; frame += 1) {
      expect(helpers.proofI420IsBlankSampled(layer, blank)).toBe(false)
    }
    expect(helpers.proofI420IsBlankSampled(layer, blank)).toBe(true)
    expect(helpers.proofI420IsBlankSampled({}, picture)).toBe(false)
  })

  it('reports the slowest layer over the last two seconds', () => {
    const camera: Record<string, unknown> = {}
    const screen: Record<string, unknown> = {}
    for (let frame = 0; frame < 60; frame += 1) {
      helpers.markProofPollerFrameDecoded(camera, 1, 2, 2, 1000 + frame * 33.3)
    }
    for (let frame = 0; frame < 20; frame += 1) {
      helpers.markProofPollerFrameDecoded(screen, 1, 2, 2, 1000 + frame * 100)
    }
    const now = 1000 + 59 * 33.3
    // 60 frames over the camera's own 1.97 s of life.
    expect(helpers.proofSourceFps(new Map([['camera', camera]]), now)).toBeCloseTo(30.5, 0)
    expect(
      helpers.proofSourceFps(
        new Map([
          ['camera', camera],
          ['screen', screen]
        ]),
        now
      )
    ).toBeCloseTo(10, 0)
    expect(helpers.proofSourceFps(new Map(), now)).toBeNull()
  })

  it('judges a young layer over its own life, and not at all before half a second', () => {
    const layer: Record<string, unknown> = {}
    helpers.markProofPollerFrameDecoded(layer, 1, 2, 2, 0)
    expect(helpers.proofSourceFps(new Map([['camera', layer]]), 300)).toBeNull()
    for (let frame = 1; frame <= 30; frame += 1) {
      helpers.markProofPollerFrameDecoded(layer, 1, 2, 2, frame * 33.3)
    }
    // One second old with 31 frames: about 30 fps, not 15.
    expect(helpers.proofSourceFps(new Map([['camera', layer]]), 1000)).toBeCloseTo(31, 0)
    // Hidden for five seconds, then shown again: measured from the resume on.
    for (let frame = 0; frame <= 30; frame += 1) {
      helpers.markProofPollerFrameDecoded(layer, 1, 2, 2, 6000 + frame * 33.3)
    }
    expect(helpers.proofSourceFps(new Map([['camera', layer]]), 7000)).toBeCloseTo(31, 0)
  })
})
