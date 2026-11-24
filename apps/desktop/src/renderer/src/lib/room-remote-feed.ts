/**
 * Plan 260 S1.8d d2: a person's picture from the backend's room as a
 * MediaStreamTrack, so the stage, the guest cards and the Program monitor
 * draw it exactly as they drew the room client's tracks. The backend keeps
 * each remote video's latest frame (`/room/remote/latest.bmp`, the HTML
 * overlay route's dialect); this polls it at up to 30 fps, one request in
 * flight, draws each new frame onto a canvas and captures the canvas.
 *
 * Its own module, loaded with the backend room only: nothing here runs while
 * the renderer's room client holds the room.
 */

export type RemoteFeedSource = 'camera' | 'screen' | 'monitor'

export type RemoteFeed = { track: MediaStreamTrack; close(): void }

const FRAME_MS = 33

/** The latest picture of one person's camera or screen, or the monitor. */
export function remoteFrameUrl(
  connection: { host: string; port: number; token: string },
  identity: string,
  source: RemoteFeedSource,
  after: { generation: string; sequence: number } | null
): string {
  const params = new URLSearchParams({ token: connection.token, identity, source })
  if (after) {
    params.set('afterGeneration', after.generation)
    params.set('afterSequence', String(after.sequence))
  }
  return `http://${connection.host}:${connection.port}/room/remote/latest.bmp?${params}`
}

export type RemoteFeedDeps = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  decode?: (blob: Blob) => Promise<ImageBitmap>
}

export function createRemoteFeed(
  url: (after: { generation: string; sequence: number } | null) => string,
  deps: RemoteFeedDeps = {}
): RemoteFeed {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The room picture canvas is unavailable.')
  const stream = canvas.captureStream(30)
  const track = stream.getVideoTracks()[0]
  if (!track) throw new Error('The room picture could not be captured.')
  let after: { generation: string; sequence: number } | null = null
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (closed) return
    try {
      const response = await (deps.fetch ?? fetch)(url(after), { cache: 'no-store' })
      if (response.status === 200) {
        const generation = response.headers.get('x-videorc-frame-generation')
        const sequence = Number(response.headers.get('x-videorc-frame-sequence'))
        const blob = await response.blob()
        if (generation && Number.isSafeInteger(sequence) && !closed) {
          const bitmap = await (
            deps.decode ?? ((b: Blob) => createImageBitmap(b, { premultiplyAlpha: 'none' }))
          )(blob)
          if (!closed) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width
              canvas.height = bitmap.height
            }
            context.drawImage(bitmap, 0, 0)
            after = { generation, sequence }
          }
          bitmap.close()
        }
      } else if (response.status === 204 && response.headers.get('x-videorc-layer-empty')) {
        after = null
      }
    } catch {
      /* The next tick asks again. */
    }
    if (!closed) timer = setTimeout(() => void tick(), FRAME_MS)
  }
  void tick()
  return {
    track,
    close() {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      stream.getTracks().forEach((t) => t.stop())
      canvas.width = canvas.height = 1
    }
  }
}
