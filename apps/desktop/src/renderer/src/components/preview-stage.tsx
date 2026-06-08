import { ArrowsClockwise, FolderOpen, GearSix, Image, PencilSimpleLine, VideoCamera } from '@phosphor-icons/react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  LayoutSettings,
  PreviewCameraStatus,
  PreviewLiveStatus,
  PreviewScreenStatus,
  PreviewSurfaceBounds,
  PreviewSurfaceStatus,
  RuntimeInfo,
  Scene,
  StreamScreen
} from '@/lib/backend'
import { cn } from '@/lib/utils'

// Widths mirror the backend camera_box_size() (260/360/480 over the 1280px
// reference) so the schematic placeholder matches the recorded camera geometry.
const SIZE_FRACTION: Record<LayoutSettings['cameraSize'], string> = {
  small: '20.3125%',
  medium: '28.125%',
  large: '37.5%'
}

type SceneSource = Scene['sources'][number]

type CameraDrag = {
  pointerId: number
  sourceId: string
  startClientX: number
  startClientY: number
  originX: number
  originY: number
  maxX: number
  maxY: number
  posX: number
  posY: number
}

function cameraBoxStyle(layout: LayoutSettings): CSSProperties {
  if (layout.cameraTransformMode === 'custom' && layout.cameraTransform) {
    const transform = layout.cameraTransform
    return {
      position: 'absolute',
      left: `${transform.x * 100}%`,
      top: `${transform.y * 100}%`,
      width: `${transform.width * 100}%`,
      height: `${transform.height * 100}%`
    }
  }

  const margin = `${layout.cameraMargin / 16}rem`
  const style: CSSProperties = {
    width: SIZE_FRACTION[layout.cameraSize],
    // A circle records as a square masked frame, so the schematic box must be
    // 1:1 (not 16:9) or it would suggest an ellipse the output cannot produce.
    aspectRatio: cameraCircleShapeApplies(layout) ? '1 / 1' : '16 / 9',
    position: 'absolute'
  }

  if (layout.cameraCorner.includes('top')) {
    style.top = margin
  } else {
    style.bottom = margin
  }
  if (layout.cameraCorner.includes('left')) {
    style.left = margin
  } else {
    style.right = margin
  }

  return style
}

function cameraCircleShapeApplies(layout: LayoutSettings): boolean {
  return layout.layoutPreset === 'screen-camera' && layout.cameraShape === 'circle'
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function nativePreviewSuspendedForSmoke(runtimeInfo?: RuntimeInfo | null): boolean {
  if (typeof window !== 'undefined') {
    const smokeWindow = window as typeof window & { __videorcSmokeNativePreviewSuspended?: boolean }
    if (typeof smokeWindow.__videorcSmokeNativePreviewSuspended === 'boolean') {
      return smokeWindow.__videorcSmokeNativePreviewSuspended
    }
  }
  return Boolean(runtimeInfo?.nativePreviewSurfaceStageSuspended)
}

export function previewImageFallbackEnabled({
  nativePreviewSurfaceEnabled,
  runtimeInfo
}: {
  nativePreviewSurfaceEnabled: boolean
  runtimeInfo?: RuntimeInfo | null
}): boolean {
  return runtimeInfo?.isPackaged === false && !nativePreviewSurfaceEnabled
}

export function PreviewStage({
  previewUrl,
  previewLoading,
  previewLiveStatus,
  previewCameraStatus,
  previewScreenStatus,
  previewSurfaceStatus,
  nativePreviewSurfaceEnabled = false,
  activeScreen,
  layout,
  onRetry,
  onOpenPermissions,
  onRevealPermissionTarget,
  runtimeInfo,
  scene,
  sceneEditMode = false,
  selectedSceneSourceId,
  onSelectSceneSource,
  onCameraDragCommit,
  onPreviewSurfaceResize,
  onNativePreviewSurfaceBounds,
  dragDisabled = false,
  className
}: {
  previewUrl: string | null
  previewLoading: boolean
  previewLiveStatus: PreviewLiveStatus
  previewCameraStatus?: PreviewCameraStatus
  previewScreenStatus?: PreviewScreenStatus
  previewSurfaceStatus?: PreviewSurfaceStatus
  nativePreviewSurfaceEnabled?: boolean
  activeScreen?: StreamScreen | null
  layout: LayoutSettings
  onRetry?: () => void
  onOpenPermissions?: () => void
  onRevealPermissionTarget?: () => void
  runtimeInfo?: RuntimeInfo | null
  scene?: Scene | null
  sceneEditMode?: boolean
  selectedSceneSourceId?: string | null
  onSelectSceneSource?: (sourceId: string) => void
  onCameraDragCommit?: (sourceId: string, x: number, y: number) => void
  onPreviewSurfaceResize?: () => void
  onNativePreviewSurfaceBounds?: (bounds: PreviewSurfaceBounds) => void
  dragDisabled?: boolean
  className?: string
}): ReactElement {
  const [imageFailed, setImageFailed] = useState(false)
  const [screenImageFailed, setScreenImageFailed] = useState(false)
  const [displayPreviewUrl, setDisplayPreviewUrl] = useState<string | null>(null)
  const allowImageFallback = previewImageFallbackEnabled({ nativePreviewSurfaceEnabled, runtimeInfo })
  const usingNativeSurface = nativePreviewSurfaceEnabled && isPreviewSurfaceTransport(previewSurfaceStatus?.transport)
  const nativeSurfaceLive = usingNativeSurface && previewSurfaceStatus?.state === 'live'
  const isLive = usingNativeSurface ? previewSurfaceStatus?.state === 'live' : previewLiveStatus.state === 'live'
  const latestFrameUrl = useMemo(
    () =>
      allowImageFallback && previewLiveStatus.transport === 'latest-jpeg-polling'
        ? latestPreviewFrameUrl(previewUrl)
        : null,
    [allowImageFallback, previewLiveStatus.transport, previewUrl]
  )
  const previewPollMs = useMemo(() => previewPollingIntervalMs(previewLiveStatus), [previewLiveStatus])
  const activeTransport = usingNativeSurface ? previewSurfaceStatus?.transport : previewLiveStatus.transport
  const transportLabel = previewTransportLabel(activeTransport ?? 'unavailable', previewSurfaceStatus?.backing)
  const syntheticNativeSurface = usingNativeSurface && previewSurfaceStatus?.source === 'synthetic'
  const expectsCamera =
    !syntheticNativeSurface && (scene?.sources.some((source) => source.visible && source.kind === 'camera') ?? false)
  const expectsScreen =
    !syntheticNativeSurface &&
    (scene?.sources.some((source) => source.visible && (source.kind === 'screen' || source.kind === 'window')) ?? false)
  const showActiveScreen =
    allowImageFallback && Boolean(activeScreen && activeScreen.status === 'ready' && !screenImageFailed)
  const showUnavailable =
    !usingNativeSurface && !showActiveScreen && (previewLiveStatus.state === 'unavailable' || imageFailed)
  const previewBadge = previewBadgeState({
    expectsCamera,
    expectsScreen,
    imageFailed,
    previewCameraStatus,
    previewLiveStatus,
    previewLoading,
    previewScreenStatus,
    previewSurfaceStatus,
    usingNativeSurface
  })

  useEffect(() => {
    setImageFailed(false)
  }, [previewUrl])

  useEffect(() => {
    setScreenImageFailed(false)
  }, [activeScreen?.id, activeScreen?.imagePath])

  useEffect(() => {
    if (!allowImageFallback || !previewUrl) {
      setDisplayPreviewUrl(null)
      return
    }

    if (!isLive || !latestFrameUrl) {
      setDisplayPreviewUrl(previewUrl)
      return
    }

    const updateFrame = (): void => {
      setDisplayPreviewUrl(withCacheBust(latestFrameUrl))
    }

    updateFrame()
    const timer = window.setInterval(updateFrame, previewPollMs)
    return () => window.clearInterval(timer)
  }, [allowImageFallback, isLive, latestFrameUrl, previewPollMs, previewUrl])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const previewSurfaceRef = useRef<HTMLDivElement | null>(null)
  const lastNativeBoundsRef = useRef<PreviewSurfaceBounds | null>(null)
  const [cameraDrag, setCameraDrag] = useState<CameraDrag | null>(null)

  useEffect(() => {
    if (!onPreviewSurfaceResize || !previewSurfaceRef.current) {
      return
    }

    let didReportInitialSize = false
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) {
        return
      }
      if (didReportInitialSize) {
        onPreviewSurfaceResize()
      } else {
        didReportInitialSize = true
      }
    })
    observer.observe(previewSurfaceRef.current)
    return () => observer.disconnect()
  }, [onPreviewSurfaceResize])

  useEffect(() => {
    if (!nativePreviewSurfaceEnabled || !onNativePreviewSurfaceBounds || !previewSurfaceRef.current) {
      return
    }

    let animationFrame: number | null = null
    const reportBounds = (): void => {
      if (animationFrame !== null) {
        return
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        const element = previewSurfaceRef.current
        if (!element) {
          return
        }
        if (nativePreviewSuspendedForSmoke(runtimeInfo)) {
          return
        }
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          return
        }
        if (!previewSurfaceRectUsable(rect)) {
          lastNativeBoundsRef.current = null
          return
        }
        const bounds: PreviewSurfaceBounds = {
          screenX: window.screenX + rect.left,
          screenY: window.screenY + rect.top,
          width: rect.width,
          height: rect.height,
          scaleFactor: window.devicePixelRatio || 1,
          screenHeight: window.screen.height
        }
        if (nativeSurfaceLive && !boundsChanged(lastNativeBoundsRef.current, bounds)) {
          return
        }
        lastNativeBoundsRef.current = bounds
        void Promise.resolve(onNativePreviewSurfaceBounds(bounds)).catch((error: unknown) => {
          console.error('Native preview surface bounds update failed:', error)
        })
      })
    }

    const observer = new ResizeObserver(reportBounds)
    observer.observe(previewSurfaceRef.current)
    window.addEventListener('resize', reportBounds)
    window.addEventListener('scroll', reportBounds, true)
    reportBounds()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
      window.removeEventListener('scroll', reportBounds, true)
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
      }
    }
  }, [
    nativePreviewSurfaceEnabled,
    nativeSurfaceLive,
    onNativePreviewSurfaceBounds,
    runtimeInfo?.nativePreviewSurfaceStageSuspended
  ])

  const beginCameraDrag = (event: ReactPointerEvent<HTMLButtonElement>, source: SceneSource): void => {
    event.preventDefault()
    onSelectSceneSource?.(source.id)
    event.currentTarget.setPointerCapture(event.pointerId)
    setCameraDrag({
      pointerId: event.pointerId,
      sourceId: source.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: source.transform.x,
      originY: source.transform.y,
      maxX: Math.max(0, 1 - source.transform.width),
      maxY: Math.max(0, 1 - source.transform.height),
      posX: source.transform.x,
      posY: source.transform.y
    })
  }

  const updateCameraDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    setCameraDrag((current) => {
      if (!current || event.pointerId !== current.pointerId) {
        return current
      }
      const deltaX = (event.clientX - current.startClientX) / rect.width
      const deltaY = (event.clientY - current.startClientY) / rect.height
      return {
        ...current,
        posX: clampRange(current.originX + deltaX, 0, current.maxX),
        posY: clampRange(current.originY + deltaY, 0, current.maxY)
      }
    })
  }

  const endCameraDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const current = cameraDrag
    if (current && event.pointerId === current.pointerId) {
      const rect = stageRef.current?.getBoundingClientRect()
      if (rect) {
        const x = clampRange(current.originX + (event.clientX - current.startClientX) / rect.width, 0, current.maxX)
        const y = clampRange(current.originY + (event.clientY - current.startClientY) / rect.height, 0, current.maxY)
        const moved = Math.abs(x - current.originX) > 1e-4 || Math.abs(y - current.originY) > 1e-4
        if (moved) {
          onCameraDragCommit?.(current.sourceId, x, y)
        }
      }
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
    setCameraDrag(null)
  }

  return (
    <div className={cn('flex flex-col gap-3', className)} data-videorc-preview-stage>
      <div
        className="relative aspect-video w-full overflow-hidden rounded-xl border bg-muted"
        data-videorc-preview-surface
        ref={previewSurfaceRef}
      >
        {usingNativeSurface ? (
          <div
            className="size-full bg-transparent"
            data-videorc-native-preview-surface
            aria-hidden="true"
          />
        ) : showActiveScreen && activeScreen ? (
          <img
            alt="Active Screen preview"
            className="size-full object-cover"
            data-videorc-preview-image
            src={fileUrlFromPath(activeScreen.imagePath)}
            onError={() => setScreenImageFailed(true)}
          />
        ) : allowImageFallback && displayPreviewUrl && !imageFailed ? (
          <img
            alt="Selected scene preview"
            className="size-full object-contain"
            data-videorc-preview-image
            src={displayPreviewUrl}
            onLoad={() => setImageFailed(false)}
            onError={() => {
              if (!isLive || !latestFrameUrl) {
                setImageFailed(true)
              }
            }}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            {showUnavailable ? (
              <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center">
                <Image className="size-10 text-muted-foreground/50" weight="duotone" />
                <p className="text-sm font-medium text-muted-foreground">
                  {imageFailed
                    ? 'Live preview stream could not be displayed.'
                    : (previewLiveStatus.message ?? 'Live preview unavailable.')}
                </p>
              </div>
            ) : (
              <VideoCamera className="size-10 text-muted-foreground/50" weight="duotone" />
            )}
            {!showUnavailable && layout.layoutPreset === 'screen-camera' ? (
              <div
                className={cn(
                  'border-2 border-primary/60 bg-primary/10',
                  cameraCircleShapeApplies(layout) ? 'rounded-full' : 'rounded-md'
                )}
                style={cameraBoxStyle(layout)}
              />
            ) : null}
          </div>
        )}
        <Badge className="absolute top-2 left-2" variant={previewBadge.variant}>
          {previewBadge.label}
        </Badge>
        {transportLabel && transportLabel !== previewBadge.label ? (
          <Badge
            className="absolute top-9 left-2"
            variant={
              activeTransport === 'native-surface' && previewSurfaceStatus?.backing === 'cametal-layer'
                ? 'success'
                : activeTransport === 'electron-proof-surface'
                  ? 'warning'
                  : 'secondary'
            }
          >
            {transportLabel}
          </Badge>
        ) : null}
        {activeScreen && !nativePreviewSurfaceEnabled ? (
          <Badge className="absolute top-2 right-2" variant={showActiveScreen ? 'warning' : 'destructive'}>
            {showActiveScreen ? activeScreen.name : 'Screen missing'}
          </Badge>
        ) : null}
        {sceneEditMode ? (
          <Badge className={cn('absolute right-2', activeScreen ? 'top-9' : 'top-2')} variant="warning">
            <PencilSimpleLine data-icon="inline-start" />
            Edit
          </Badge>
        ) : null}
        {sceneEditMode && scene ? (
          <div ref={stageRef} className="pointer-events-none absolute inset-0">
            {scene.sources
              .filter((source) => source.visible)
              .map((source) => {
                const selected = source.id === selectedSceneSourceId
                const draggable = source.kind === 'camera' && !dragDisabled && Boolean(onCameraDragCommit)
                const dragging = cameraDrag?.sourceId === source.id
                const transform =
                  cameraDrag && cameraDrag.sourceId === source.id
                    ? { ...source.transform, x: cameraDrag.posX, y: cameraDrag.posY }
                    : source.transform
                return (
                  <button
                    aria-label={`Select ${source.name}`}
                    className={cn(
                      'pointer-events-auto absolute border text-left transition-colors',
                      'appearance-none p-0',
                      selected
                        ? 'border-primary bg-primary/10 ring-2 ring-primary/40'
                        : 'border-primary/50 bg-primary/5 hover:bg-primary/10',
                      draggable && (dragging ? 'cursor-grabbing' : 'cursor-grab')
                    )}
                    key={source.id}
                    data-videorc-scene-source={source.id}
                    data-videorc-scene-source-kind={source.kind}
                    style={sceneSourceStyle(transform)}
                    type="button"
                    onClick={() => onSelectSceneSource?.(source.id)}
                    onPointerDown={draggable ? (event) => beginCameraDrag(event, source) : undefined}
                    onPointerMove={draggable ? updateCameraDrag : undefined}
                    onPointerUp={draggable ? endCameraDrag : undefined}
                    onPointerCancel={draggable ? endCameraDrag : undefined}
                  >
                    <span className="absolute -top-6 left-0 rounded-md bg-background/95 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
                      {source.name}
                    </span>
                    {selected ? <TransformHandles /> : null}
                  </button>
                )
              })}
          </div>
        ) : null}
      </div>
      {showUnavailable && (onRetry || onOpenPermissions) ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {onOpenPermissions ? (
              <Button size="sm" variant="outline" onClick={onOpenPermissions}>
                <GearSix data-icon="inline-start" />
                Open permissions
              </Button>
            ) : null}
            {runtimeInfo && !runtimeInfo.isPackaged && onRevealPermissionTarget ? (
              <Button size="sm" variant="outline" onClick={onRevealPermissionTarget}>
                <FolderOpen data-icon="inline-start" />
                Reveal Electron.app
              </Button>
            ) : null}
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <ArrowsClockwise data-icon="inline-start" />
                Retry preview
              </Button>
            ) : null}
          </div>
          {runtimeInfo && !runtimeInfo.isPackaged ? (
            <p className="text-xs text-muted-foreground">
              Dev mode needs Screen Recording permission for {runtimeInfo.permissionTargetName}. If it is not listed,
              add the revealed app manually, then relaunch.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function latestPreviewFrameUrl(previewUrl: string | null): string | null {
  if (!previewUrl) {
    return null
  }

  return previewUrl.includes('/preview/live.mjpeg')
    ? previewUrl.replace('/preview/live.mjpeg', '/preview/live.jpg')
    : null
}

function previewPollingIntervalMs(status: PreviewLiveStatus): number {
  if (status.transport !== 'latest-jpeg-polling') {
    return 250
  }

  const targetFps = status.targetFps && Number.isFinite(status.targetFps) ? status.targetFps : 4
  return clampRange(Math.round(1000 / Math.max(1, targetFps)), 80, 250)
}

type PreviewBadgeState = {
  label: string
  variant: 'secondary' | 'destructive' | 'success' | 'warning'
}

function previewBadgeState({
  expectsCamera,
  expectsScreen,
  imageFailed,
  previewCameraStatus,
  previewLiveStatus,
  previewLoading,
  previewScreenStatus,
  previewSurfaceStatus,
  usingNativeSurface
}: {
  expectsCamera: boolean
  expectsScreen: boolean
  imageFailed: boolean
  previewCameraStatus?: PreviewCameraStatus
  previewLiveStatus: PreviewLiveStatus
  previewLoading: boolean
  previewScreenStatus?: PreviewScreenStatus
  previewSurfaceStatus?: PreviewSurfaceStatus
  usingNativeSurface: boolean
}): PreviewBadgeState {
  if (previewLoading || previewLiveStatus.state === 'connecting') {
    return { label: 'Connecting', variant: 'secondary' }
  }

  const message = previewLiveStatus.message?.toLowerCase() ?? ''
  const cameraState = previewCameraStatus?.state
  const screenState = previewScreenStatus?.state

  if (
    cameraState === 'permission-needed' ||
    screenState === 'permission-needed' ||
    message.includes('permission')
  ) {
    return { label: 'Permission needed', variant: 'warning' }
  }

  if (usingNativeSurface) {
    if (expectsScreen && screenState && screenState !== 'live') {
      return { label: 'Waiting for screen', variant: screenState === 'failed' ? 'destructive' : 'secondary' }
    }
    if (expectsCamera && cameraState && cameraState !== 'live') {
      return {
        label: 'Waiting for camera',
        variant: cameraState === 'failed' || cameraState === 'device-missing' ? 'destructive' : 'secondary'
      }
    }
    if (previewSurfaceStatus?.state === 'failed') {
      return { label: 'Preview failed', variant: 'destructive' }
    }
    if (previewSurfaceStatus?.state === 'live') {
      if (previewSurfaceStatus.transport === 'electron-proof-surface') {
        return { label: 'Proof surface', variant: 'warning' }
      }
      if (previewSurfaceStatus.transport === 'native-surface' && previewSurfaceStatus.backing === 'cametal-layer') {
        return { label: 'Native preview', variant: 'success' }
      }
      return { label: 'Proof surface', variant: 'warning' }
    }
    return { label: 'Connecting', variant: 'secondary' }
  }

  if (previewLiveStatus.state === 'reconnecting') {
    return { label: 'Reconnecting', variant: 'secondary' }
  }
  if (previewLiveStatus.state === 'live') {
    return { label: 'Fallback preview', variant: 'warning' }
  }
  if (imageFailed) {
    return { label: 'Preview failed', variant: 'destructive' }
  }
  return { label: 'Unavailable', variant: 'secondary' }
}

function previewTransportLabel(transport: PreviewLiveStatus['transport'], backing?: PreviewSurfaceStatus['backing']): string | null {
  switch (transport) {
    case 'native-surface':
      return backing === 'cametal-layer' ? 'Native preview' : 'Surface proof'
    case 'electron-proof-surface':
      return 'Electron proof'
    case 'latest-jpeg-polling':
      return 'JPEG fallback'
    case 'mjpeg-stream':
      return 'MJPEG debug'
    default:
      return null
  }
}

function isPreviewSurfaceTransport(transport?: PreviewLiveStatus['transport']): boolean {
  return transport === 'native-surface' || transport === 'electron-proof-surface'
}

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  return `${prefix}${encodeURI(normalized)}`
}

function withCacheBust(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}t=${Date.now()}`
}

function boundsChanged(previous: PreviewSurfaceBounds | null, next: PreviewSurfaceBounds): boolean {
  if (!previous) {
    return true
  }

  return (
    Math.abs(previous.screenX - next.screenX) >= 1 ||
    Math.abs(previous.screenY - next.screenY) >= 1 ||
    Math.abs(previous.width - next.width) >= 1 ||
    Math.abs(previous.height - next.height) >= 1 ||
    Math.abs(previous.scaleFactor - next.scaleFactor) >= 0.01 ||
    Math.abs((previous.screenHeight ?? 0) - (next.screenHeight ?? 0)) >= 1
  )
}

function previewSurfaceRectUsable(rect: DOMRect): boolean {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const tolerance = 0.5
  return (
    rect.left >= -tolerance &&
    rect.top >= -tolerance &&
    rect.right <= viewportWidth + tolerance &&
    rect.bottom <= viewportHeight + tolerance
  )
}

function sceneSourceStyle(transform: Scene['sources'][number]['transform']): CSSProperties {
  return {
    left: `${transform.x * 100}%`,
    top: `${transform.y * 100}%`,
    width: `${transform.width * 100}%`,
    height: `${transform.height * 100}%`
  }
}

function TransformHandles(): ReactElement {
  return (
    <>
      {[
        'top-0 left-0 -translate-x-1/2 -translate-y-1/2',
        'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2',
        'top-0 right-0 translate-x-1/2 -translate-y-1/2',
        'top-1/2 right-0 translate-x-1/2 -translate-y-1/2',
        'right-0 bottom-0 translate-x-1/2 translate-y-1/2',
        'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2',
        'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
        'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2'
      ].map((position) => (
        <span className={cn('absolute size-2 rounded-sm border border-background bg-primary', position)} key={position} />
      ))}
    </>
  )
}
