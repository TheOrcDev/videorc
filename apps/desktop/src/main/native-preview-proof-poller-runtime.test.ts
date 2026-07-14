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
      proofPollersHaveCompleteFrameHistory
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
