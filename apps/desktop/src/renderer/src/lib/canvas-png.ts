// The PNG encode behind every overlay pushed to the stream: the Buddy bubble,
// the caption bar and the highlight card.
//
// `OffscreenCanvas.convertToBlob` on the page encodes in an idle task, and a
// page that gets no idle time waits for Chromium's timeout instead (about one
// second). That is the usual case while streaming: Videorc sits behind the
// game or on another workspace, its frames are throttled and it never idles
// (ogre, 2026-10-13: 6 frames a second, 1.0 s per encode). Each Buddy bubble
// reached the first output 1.1 s late and the second 2.2 s late, so a 2.5 s
// bubble showed for a quarter second on stream while the pose talked without
// it. A worker has no idle wait: the same encode takes 8 to 40 ms there, a 4K
// caption bar under 100 ms, and the page's thread stays free.

type EncodeReply = { id: number; buffer?: ArrayBuffer; error?: string }

export interface PngEncodeWorker {
  postMessage(message: unknown, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<EncodeReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  terminate(): void
}

// A blob worker: the production renderer loads from file://, where a worker
// script file can't start, and the CSP allows `worker-src blob:`.
const WORKER_SOURCE = `onmessage = async (event) => {
  const { id, bitmap } = event.data
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const buffer = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    postMessage({ id, buffer }, [buffer])
  } catch (error) {
    postMessage({ id, error: String(error) })
  }
}`

function defaultWorkerFactory(): PngEncodeWorker | null {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined') {
    return null
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
  try {
    return new Worker(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

let workerFactory: () => PngEncodeWorker | null = defaultWorkerFactory
let worker: PngEncodeWorker | null | undefined
let nextId = 0
const pending = new Map<
  number,
  { resolve: (buffer: ArrayBuffer) => void; reject: (error: Error) => void }
>()

function failAll(reason: string): void {
  worker?.terminate()
  // Encodes fall back to the page from now on.
  worker = null
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
}

function encodeWorker(): PngEncodeWorker | null {
  if (worker !== undefined) return worker
  try {
    worker = workerFactory()
  } catch {
    worker = null
  }
  if (worker) {
    worker.onmessage = (event) => {
      const entry = pending.get(event.data.id)
      if (!entry) return
      pending.delete(event.data.id)
      if (event.data.buffer) entry.resolve(event.data.buffer)
      else entry.reject(new Error(event.data.error ?? 'PNG encode failed.'))
    }
    worker.onerror = () => failAll('The PNG encode worker stopped.')
  }
  return worker
}

async function encodeInWorker(canvas: OffscreenCanvas): Promise<ArrayBuffer | null> {
  const target = encodeWorker()
  if (!target || typeof createImageBitmap !== 'function') return null
  // A copy (immediate, no idle wait): the canvas stays whole for the fallback.
  const bitmap = await createImageBitmap(canvas)
  const id = ++nextId
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    target.postMessage({ id, bitmap }, [bitmap])
  })
}

function base64(buffer: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/**
 * The canvas as a PNG, base64 without the data: prefix. Encodes in a worker,
 * and on the page (`convertToBlob`) where no worker can run or it failed.
 */
export async function canvasToBase64Png(canvas: OffscreenCanvas): Promise<string> {
  const buffer = await encodeInWorker(canvas).catch(() => null)
  if (buffer) return base64(buffer)
  return base64(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

/** Tests: swap the worker (null = none), and forget the current one. */
export function setPngEncodeWorkerFactoryForTests(
  factory: (() => PngEncodeWorker | null) | null
): void {
  if (worker) worker.terminate()
  worker = undefined
  pending.clear()
  workerFactory = factory ?? defaultWorkerFactory
}
