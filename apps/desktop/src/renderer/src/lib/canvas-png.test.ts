import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canvasToBase64Png,
  setPngEncodeWorkerFactoryForTests,
  type PngEncodeWorker
} from './canvas-png'

const PAGE_PNG = new Uint8Array([1, 2, 3])
const WORKER_PNG = new Uint8Array([9, 8, 7, 6])

function canvas(): OffscreenCanvas & { convertToBlob: ReturnType<typeof vi.fn> } {
  return {
    width: 4,
    height: 2,
    convertToBlob: vi.fn(async () => new Blob([PAGE_PNG]))
  } as unknown as OffscreenCanvas & { convertToBlob: ReturnType<typeof vi.fn> }
}

/** A worker that answers each encode with `reply` (or never, or by failing). */
function fakeWorker(reply: 'png' | 'error' | 'crash'): PngEncodeWorker & { posted: unknown[] } {
  const worker: PngEncodeWorker & { posted: unknown[] } = {
    posted: [],
    onmessage: null,
    onerror: null,
    terminate: vi.fn(),
    postMessage(message: unknown) {
      worker.posted.push(message)
      const { id } = message as { id: number }
      queueMicrotask(() => {
        if (reply === 'crash') worker.onerror?.(new Event('error') as ErrorEvent)
        else if (reply === 'error')
          worker.onmessage?.({ data: { id, error: 'no encoder' } } as MessageEvent)
        else
          worker.onmessage?.({
            data: { id, buffer: WORKER_PNG.slice().buffer }
          } as MessageEvent)
      })
    }
  }
  return worker
}

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

beforeEach(() => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4, height: 2, close: vi.fn() }))
  )
})

afterEach(() => {
  setPngEncodeWorkerFactoryForTests(null)
  vi.unstubAllGlobals()
})

describe('canvasToBase64Png', () => {
  it("encodes in the worker, never with the page's idle-scheduled convertToBlob", async () => {
    const worker = fakeWorker('png')
    setPngEncodeWorkerFactoryForTests(() => worker)
    const source = canvas()
    expect(await canvasToBase64Png(source)).toBe(base64(WORKER_PNG))
    expect(source.convertToBlob).not.toHaveBeenCalled()
    expect(worker.posted).toHaveLength(1)
    // One worker for every encode.
    expect(await canvasToBase64Png(canvas())).toBe(base64(WORKER_PNG))
    expect(worker.posted).toHaveLength(2)
  })

  it('falls back to the page when there is no worker', async () => {
    setPngEncodeWorkerFactoryForTests(() => null)
    const source = canvas()
    expect(await canvasToBase64Png(source)).toBe(base64(PAGE_PNG))
    expect(source.convertToBlob).toHaveBeenCalledWith({ type: 'image/png' })
  })

  it('falls back to the page when the worker refuses an encode, with the canvas whole', async () => {
    setPngEncodeWorkerFactoryForTests(() => fakeWorker('error'))
    const source = canvas()
    expect(await canvasToBase64Png(source)).toBe(base64(PAGE_PNG))
    expect(source.convertToBlob).toHaveBeenCalledTimes(1)
  })

  it('stops using a worker that crashed', async () => {
    const crashed = fakeWorker('crash')
    const factory = vi.fn(() => crashed)
    setPngEncodeWorkerFactoryForTests(factory)
    expect(await canvasToBase64Png(canvas())).toBe(base64(PAGE_PNG))
    expect(crashed.terminate).toHaveBeenCalled()
    const next = canvas()
    expect(await canvasToBase64Png(next)).toBe(base64(PAGE_PNG))
    expect(crashed.posted).toHaveLength(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
