import { useEffect, useRef, useState, type ReactElement } from 'react'

import { stageSourceShape } from '@/components/scene/stage-transform'
import { Badge } from '@/components/ui/badge'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import type { CameraShape, Scene, SceneSource } from '@/lib/backend'
import {
  backdropStartStillReason,
  startBackdropPlayer,
  type BackdropPlayerHandle
} from '@/lib/live-background-player'
import { liveBackgroundThumbnail } from '@/lib/live-backgrounds'
import { cn } from '@/lib/utils'
import type { LiveBackgroundId } from '../../../../shared/live-background-ids'

/** The SVG's width in user units; its height follows the canvas aspect. */
const PICTURE_W = 1000

export interface LookPictureBackground {
  id: LiveBackgroundId
  look: string
  motion: string
  /** 0 to 80, as the scene's Dim. */
  dimPercent: number
}

/**
 * The chosen live background moving behind the picture, through the same
 * player and still rules as setup's backdrop (plan 203 S4): its thumbnail at
 * once, the canvas fading in on its first frame, the thumbnail kept whenever
 * it can't move cheaply. Paused while the window is hidden; released on
 * unmount or a new background.
 */
function LiveBackgroundLayer({
  background,
  hardwareAccelerationDisabled,
  onStateChange
}: {
  background: LookPictureBackground
  hardwareAccelerationDisabled: boolean
  onStateChange: (state: 'moving' | 'still' | 'starting') => void
}): ReactElement {
  const reducedMotion = useReducedMotion()
  const visible = useDocumentVisible()
  const startStill = backdropStartStillReason({ reducedMotion, hardwareAccelerationDisabled })
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<BackdropPlayerHandle | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [still, setStill] = useState(false)
  const dim = Math.min(80, Math.max(0, background.dimPercent)) / 100
  const dimRef = useRef(dim)
  dimRef.current = dim
  const { id, look, motion } = background

  useEffect(() => {
    const host = hostRef.current
    setDrawn(false)
    setStill(false)
    if (startStill || !host) return
    const player = startBackdropPlayer({
      host,
      look,
      background: { id, motion },
      dim: dimRef.current,
      onFirstFrame: () => setDrawn(true),
      onStill: (reason, detail) => {
        console.info(
          `[first-run] Your look's ${id} shows its poster: ${reason}${detail ? ` (${detail})` : ''}`
        )
        setStill(true)
      }
    })
    playerRef.current = player
    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [id, look, motion, startStill])

  useEffect(() => {
    playerRef.current?.setDim(dim)
  }, [dim])

  useEffect(() => {
    playerRef.current?.setRunning(visible)
  }, [visible])

  const state = startStill || still ? 'still' : drawn ? 'moving' : 'starting'
  useEffect(() => {
    onStateChange(state)
  }, [onStateChange, state])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <img
        alt=""
        className="absolute inset-0 size-full object-cover"
        draggable={false}
        src={liveBackgroundThumbnail(id, look)}
        style={{ filter: dim > 0 ? `brightness(${1 - dim})` : undefined }}
      />
      {state === 'still' ? null : (
        <div
          ref={hostRef}
          className="absolute inset-0 opacity-0 transition-opacity duration-150 ease-out data-[drawn=true]:opacity-100 motion-reduce:transition-none"
          data-drawn={drawn}
        />
      )}
    </div>
  )
}

const PICTURE_KINDS = new Set<SceneSource['kind']>(['camera', 'screen', 'window'])

/**
 * Your look's picture (plan 207 D5): the committed scene's own boxes, the
 * camera in its shape, and the chosen live background moving behind them.
 * The boxes name their devices; the real picture opens with the Studio.
 */
export function LookPicture({
  scene,
  aspect,
  cameraShape,
  cameraCornerRadiusPct,
  background,
  names,
  hardwareAccelerationDisabled = false
}: {
  scene: Scene | null
  /** Width over height of the canvas. */
  aspect: number
  /** The shape the scene draws for this layout (rectangle where it doesn't apply). */
  cameraShape: CameraShape
  cameraCornerRadiusPct: number
  background: LookPictureBackground | null
  /** Each kind's device name, shown in its box. */
  names: { camera?: string; screen?: string }
  hardwareAccelerationDisabled?: boolean
}): ReactElement {
  const [backgroundState, setBackgroundState] = useState<'moving' | 'still' | 'starting'>(
    'starting'
  )
  const height = PICTURE_W / aspect
  const sources = (scene?.sources ?? []).filter(
    (source) => source.visible && PICTURE_KINDS.has(source.kind)
  )
  const vertical = aspect < 1
  return (
    <div
      className={cn(
        'relative mx-auto overflow-hidden rounded-row border border-border bg-inset',
        vertical ? 'h-56' : 'w-full'
      )}
      data-first-run-look-picture={background ? backgroundState : 'none'}
      style={{ aspectRatio: `${aspect}` }}
    >
      {background ? (
        <LiveBackgroundLayer
          key={`${background.id}:${background.look}`}
          background={background}
          hardwareAccelerationDisabled={hardwareAccelerationDisabled}
          onStateChange={setBackgroundState}
        />
      ) : null}
      {sources.length === 0 ? (
        // Nothing to place yet: no camera or screen Videorc may use.
        <p className="absolute inset-x-3 bottom-2 text-center text-meta text-muted-foreground">
          Your camera and screen show here once Videorc can use them.
        </p>
      ) : null}
      <svg
        aria-label="Your scene"
        className="absolute inset-0 size-full"
        role="img"
        viewBox={`0 0 ${PICTURE_W} ${height}`}
      >
        {sources.map((source) => {
          const shape = stageSourceShape(
            source.transform,
            PICTURE_W,
            height,
            source.kind === 'camera' ? cameraShape : 'rectangle',
            cameraCornerRadiusPct
          )
          // A light tint, so the background stays readable through the boxes.
          const paint = {
            className: cn(
              'stroke-foreground/40',
              source.kind === 'camera' ? 'fill-foreground/15' : 'fill-foreground/5'
            ),
            strokeWidth: 1,
            vectorEffect: 'non-scaling-stroke' as const
          }
          return (
            <g key={source.id} data-first-run-look-source={source.kind}>
              {shape.kind === 'circle' ? (
                <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint} />
              ) : (
                <rect
                  height={shape.height}
                  rx={shape.rx}
                  width={shape.width}
                  x={shape.x}
                  y={shape.y}
                  {...paint}
                />
              )}
            </g>
          )
        })}
      </svg>
      {/* The names sit over their boxes as chips, at the text scale whatever
          the picture's size. */}
      {sources.map((source) => {
        const name =
          (source.kind === 'camera' ? names.camera : names.screen) ??
          (source.deviceId ? source.name : source.kind === 'camera' ? 'No camera' : 'No screen')
        const { x, y, width, height: boxHeight } = source.transform
        return (
          <div
            key={source.id}
            className="pointer-events-none absolute flex items-center justify-center overflow-hidden p-1"
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${width * 100}%`,
              height: `${boxHeight * 100}%`
            }}
          >
            {/* The text truncates, not the chip: a flex chip centers an
                overflowing name and clips both ends (and its dot). */}
            <Badge className="max-w-full" variant="neutral">
              <span className="truncate">{name}</span>
            </Badge>
          </div>
        )
      })}
    </div>
  )
}
