import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useStudioCore } from '@/hooks/use-studio'
import { WHAT_VIEWERS_SEE_LABEL } from '@/lib/camera-background-view'
import { cn } from '@/lib/utils'

/** How often the picture asks for a newer frame while it is open. */
const POLL_MS = 150
/** The picture's width in pixels: twice the popover's, for a sharp picture on Retina. */
const MAX_WIDTH = 640

/**
 * The camera store's newest frame as a small BMP, with the renderer's token.
 * The store holds only processed frames while an effect is on (plan 258
 * D2), so this is what every output carries, never the raw camera. `after`
 * makes an unchanged poll a 204 with no copy.
 */
export function cameraFrameUrl(
  connection: { host: string; port: number; token: string },
  after: { generation: string; sequence: number } | null,
  maxWidth = MAX_WIDTH
): string {
  const params = new URLSearchParams({ token: connection.token, maxWidth: String(maxWidth) })
  if (after) {
    params.set('afterGeneration', after.generation)
    params.set('afterSequence', String(after.sequence))
  }
  return `http://${connection.host}:${connection.port}/preview/camera/latest.bmp?${params}`
}

/**
 * The popover's "What viewers see" (plan 258 UX): the processed camera from
 * the store, so it reads true with the Preview closed. It polls only while
 * mounted (the popover is open) and draws each new frame on a canvas;
 * mirrored like the outputs when the camera is. Until a frame arrives it
 * shows the tile's own picture (`fallback`).
 */
export function CameraBackgroundViewer({
  mirror,
  fallback,
  className
}: {
  mirror: boolean
  fallback: ReactElement
  className?: string
}): ReactElement {
  const { connection, wsStatus } = useStudioCore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drawn, setDrawn] = useState(false)
  const online = wsStatus === 'connected' ? connection : null
  useEffect(() => {
    if (!online) return
    let stopped = false
    let timer: number | undefined
    let after: { generation: string; sequence: number } | null = null
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(cameraFrameUrl(online, after), { cache: 'no-store' })
        const generation = response.headers.get('x-videorc-frame-generation')
        const sequence = Number(response.headers.get('x-videorc-frame-sequence'))
        if (response.status === 200) {
          const bitmap = await createImageBitmap(await response.blob())
          const canvas = canvasRef.current
          if (!stopped && canvas) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
            setDrawn(true)
          }
          bitmap.close()
        } else if (response.status === 404) {
          // No camera frame (camera off or starting): back to the picture.
          setDrawn(false)
        }
        if (generation && Number.isFinite(sequence)) after = { generation, sequence }
      } catch {
        // A dropped poll is retried on the next tick; the last frame stays.
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS)
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [online])
  return (
    <div
      className={cn(
        'relative aspect-video overflow-hidden rounded-row border border-border bg-video-ground',
        className
      )}
      data-videorc-camera-background-viewer={drawn ? 'live' : 'picture'}
    >
      {drawn ? null : fallback}
      <canvas
        aria-hidden
        className={cn(
          'absolute inset-0 size-full object-cover',
          !drawn && 'invisible',
          mirror && '-scale-x-100'
        )}
        ref={canvasRef}
      />
      <span className="absolute top-1.5 left-1.5 rounded-full bg-video-ground/75 px-1.5 py-0.5 text-label text-video-ground-foreground">
        {WHAT_VIEWERS_SEE_LABEL}
      </span>
    </div>
  )
}
