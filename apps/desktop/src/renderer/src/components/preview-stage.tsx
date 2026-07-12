import { ArrowSquareOut, PushPinSimple, VideoCamera, Warning } from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useDockSlotReporter } from '@/hooks/use-dock-slot'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  DockHiddenReason,
  PreviewLiveStatus,
  PreviewSupervisorState,
  PreviewSurfaceStatus,
  PreviewWindowState
} from '@/lib/backend'
import { cn } from '@/lib/utils'

type PreviewStageProps = {
  previewLiveStatus?: PreviewLiveStatus
  previewSurfaceStatus?: PreviewSurfaceStatus
  nativePreviewSurfaceEnabled?: boolean
  /** Rendered at the left of the docked frame's control row (session status
   * badge) — the docked preview stands alone, without the Studio panel header
   * that normally carries it. */
  dockedFooterStart?: ReactNode
  onRetry?: () => void
  onOpenPermissions?: () => void
  className?: string
}

export function PreviewStage({
  previewLiveStatus,
  previewSurfaceStatus,
  nativePreviewSurfaceEnabled = false,
  dockedFooterStart,
  onRetry,
  onOpenPermissions,
  className
}: PreviewStageProps): ReactElement {
  const {
    previewWindow,
    openPreviewWindow,
    closePreviewWindow,
    setPreviewWindowAlwaysOnTop,
    setPreviewWindowMode,
    captureConfig
  } = useStudioCore()

  const docked =
    nativePreviewSurfaceEnabled && previewWindow.open && previewWindow.mode === 'docked'
  // The reporter is active exactly while the docked frame is on screen; its
  // cleanup tells main the slot unmounted (tab switch, undock, close).
  const slotRef = useDockSlotReporter(docked, previewWindow.dockEpoch)

  if (docked) {
    return (
      <DockedPreviewFrame
        aspect={{
          width: captureConfig.video.width,
          height: captureConfig.video.height
        }}
        className={className}
        footerStart={dockedFooterStart}
        previewSurfaceStatus={previewSurfaceStatus}
        previewWindow={previewWindow}
        slotRef={slotRef}
        onClose={() => void closePreviewWindow()}
        onOpenPermissions={onOpenPermissions}
        onPopOut={() => void setPreviewWindowMode('floating')}
      />
    )
  }

  return (
    <DetachedPreviewCard
      alwaysOnTop={previewWindow.alwaysOnTop}
      aspect={{ width: captureConfig.video.width, height: captureConfig.video.height }}
      className={className}
      nativePreviewSurfaceEnabled={nativePreviewSurfaceEnabled}
      previewLiveStatus={previewLiveStatus}
      previewSupervisor={previewWindow.supervisor}
      previewSurfaceStatus={previewSurfaceStatus}
      previewWindowOpen={previewWindow.open}
      onAlwaysOnTopChange={(alwaysOnTop) => void setPreviewWindowAlwaysOnTop(alwaysOnTop)}
      onClose={() => void closePreviewWindow()}
      onOpen={() => void openPreviewWindow()}
      onOpenPermissions={onOpenPermissions}
      onRetry={onRetry}
      onStick={() => void setPreviewWindowMode('docked')}
    />
  )
}

/** All three preview states occupy the same FOOTPRINT rect so the Studio
 * layout never jumps when the preview opens, docks, or closes. Portrait
 * canvases (the vertical 9:16 profile) keep the LANDSCAPE footprint — a raw
 * full-width 9:16 strip would tower ~2.4× over the Studio column. The docked
 * frame centers a TRUE-portrait slot inside that footprint (see
 * DockedPreviewFrame); this function only shapes the outer strip and the
 * detached placeholder card. */
function previewFootprintRatio(aspect: { width: number; height: number }): string {
  if (aspect.width <= 0 || aspect.height <= 0) {
    return '16 / 9'
  }
  if (aspect.height > aspect.width) {
    return '16 / 9'
  }
  return `${aspect.width} / ${aspect.height}`
}

/** The slot itself always carries the REAL canvas aspect: the native surface
 * is glued to the slot rect, so a portrait canvas must get a portrait slot —
 * gluing a 9:16 surface over a 16:9 slot renders a squashed preview (the
 * 0.9.32 vertical-mode report). */
function previewSlotRatio(aspect: { width: number; height: number }): string {
  return aspect.width > 0 && aspect.height > 0 ? `${aspect.width} / ${aspect.height}` : '16 / 9'
}

// Docked ("stick") mode: the native preview surface floats glued over the slot
// below, so this frame is what shows through when the surface is hidden — it
// must always state WHY (dockHiddenReason / supervisor copy), never sit blank.
function DockedPreviewFrame({
  previewWindow,
  previewSurfaceStatus,
  aspect,
  slotRef,
  footerStart,
  onPopOut,
  onClose,
  onOpenPermissions,
  className
}: {
  previewWindow: PreviewWindowState
  previewSurfaceStatus?: PreviewSurfaceStatus
  aspect: { width: number; height: number }
  slotRef: (element: HTMLElement | null) => void
  footerStart?: ReactNode
  onPopOut: () => void
  onClose: () => void
  onOpenPermissions?: () => void
  className?: string
}): ReactElement {
  const supervisor = previewWindow.supervisor
  const hidden = dockHiddenDisplay(previewWindow.dockHiddenReason)
  const status = hidden ?? {
    title: previewSupervisorDisplay(true, supervisor, previewSurfaceStatus).title,
    detail: previewSupervisorDisplay(true, supervisor, previewSurfaceStatus).detail
  }
  const showPermissionAction = supervisor.lifecycleState === 'permission-required'
  const footprintRatio = previewFootprintRatio(aspect)
  const slotRatio = previewSlotRatio(aspect)

  return (
    // No border and no panel rounding here: the native surface is a separate
    // window glued over the slot with square corners — CSS cannot clip it, so
    // any rounded frame leaves a dark corner wedge peeking around the video.
    <div
      className={cn('flex w-full flex-col overflow-hidden', className)}
      data-videorc-preview-card
      data-videorc-preview-docked
    >
      {/* The charcoal strip keeps the landscape footprint so the Studio
          column never grows; the SLOT the native surface glues to carries the
          REAL canvas aspect and centers inside it. Landscape: slot == strip.
          Portrait (vertical mode): a true 9:16 slot on the black strip — the
          surface aspect always matches the slot, so it can never be
          squeezed or stretched. */}
      <div
        className="flex w-full items-center justify-center bg-[#0D0D0F]"
        data-videorc-dock-strip
        style={{ aspectRatio: footprintRatio }}
      >
        <div
          ref={slotRef}
          className="relative h-full"
          data-videorc-dock-slot
          style={{ aspectRatio: slotRatio }}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <VideoCamera className="size-8 text-muted-foreground" weight="duotone" />
            <span className="text-sm font-medium text-[#F4F4F5]">{status.title}</span>
            <span className="text-xs text-[#A1A1AA]">{status.detail}</span>
          </div>
        </div>
      </div>
      {/* Slim control row under the bare strip (the docked preview has no
          panel around it): session status left, dock controls right, flush
          with the video edges. */}
      <div className="flex items-center justify-end gap-1.5 pt-2">
        {footerStart ? <div className="mr-auto flex items-center">{footerStart}</div> : null}
        {showPermissionAction && onOpenPermissions ? (
          <Button size="sm" variant="outline" onClick={onOpenPermissions}>
            Open permissions
          </Button>
        ) : null}
        <Button
          data-videorc-preview-pop-out
          size="sm"
          title="Pop the preview out into its own window"
          variant="secondary"
          onClick={onPopOut}
        >
          <ArrowSquareOut className="size-4" />
          Pop out
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

function dockHiddenDisplay(
  reason: DockHiddenReason | null
): { title: string; detail: string } | null {
  switch (reason) {
    case 'no-slot-report':
      return { title: 'Placing preview', detail: 'Sticking the preview into this panel.' }
    case 'overlay-open':
      return {
        title: 'Preview paused behind dialog',
        detail: 'It returns as soon as the dialog closes.'
      }
    case 'scrolled-away':
      return {
        title: 'Preview hidden while scrolled away',
        detail: 'Scroll the panel fully into view to see it again.'
      }
    case 'main-window-fullscreen':
      return {
        title: 'Preview hidden in fullscreen',
        detail: 'Pop the preview out to watch it in fullscreen.'
      }
    // The two remaining reasons cannot be on screen at the same time as this
    // card (the tab or the window itself is gone).
    case 'slot-unmounted':
    case 'main-window-hidden':
    case null:
      return null
  }
}

function DetachedPreviewCard({
  previewWindowOpen,
  previewSupervisor,
  previewSurfaceStatus,
  previewLiveStatus,
  nativePreviewSurfaceEnabled,
  alwaysOnTop,
  aspect,
  onAlwaysOnTopChange,
  onOpen,
  onClose,
  onStick,
  onRetry,
  onOpenPermissions,
  className
}: {
  previewWindowOpen: boolean
  previewSupervisor: PreviewSupervisorState
  previewSurfaceStatus?: PreviewSurfaceStatus
  previewLiveStatus?: PreviewLiveStatus
  nativePreviewSurfaceEnabled: boolean
  alwaysOnTop: boolean
  aspect: { width: number; height: number }
  onAlwaysOnTopChange: (alwaysOnTop: boolean) => void
  onOpen: () => void
  onClose: () => void
  onStick: () => void
  onRetry?: () => void
  onOpenPermissions?: () => void
  className?: string
}): ReactElement {
  const supervisorStatus = previewSupervisorDisplay(
    previewWindowOpen,
    previewSupervisor,
    previewSurfaceStatus,
    previewLiveStatus
  )
  const transportLabel = previewWindowOpen
    ? (supervisorStatus.transportLabel ??
      previewTransportLabel(
        previewSurfaceStatus?.transport ?? 'unavailable',
        previewSurfaceStatus?.backing
      ))
    : null
  const disabledMessage =
    previewLiveStatus?.message ??
    previewSurfaceStatus?.message ??
    'Native preview surface is disabled.'
  const showPermissionAction =
    previewWindowOpen && previewSupervisor.lifecycleState === 'permission-required'

  return (
    <div
      className={cn(
        // Output-aspect rect (same as the open/docked preview) so the layout
        // never jumps when the preview opens, docks, or closes.
        'flex w-full flex-col items-center justify-center gap-3 rounded-panel border border-dashed bg-muted/20 px-6 text-center',
        className
      )}
      data-videorc-preview-card
      style={{ aspectRatio: previewFootprintRatio(aspect) }}
    >
      {nativePreviewSurfaceEnabled && supervisorStatus.tone !== 'warn' ? (
        <VideoCamera className="size-8 text-muted-foreground" weight="duotone" />
      ) : (
        <Warning className="size-8 text-warning" weight="duotone" />
      )}
      {nativePreviewSurfaceEnabled ? (
        previewWindowOpen ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{supervisorStatus.title}</span>
              <span className="text-xs text-muted-foreground">
                {supervisorStatus.detail}
                {transportLabel ? ` - ${transportLabel}` : ''}
              </span>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="secondary" onClick={onOpen}>
                Focus window
              </Button>
              <Button data-videorc-preview-stick size="sm" variant="outline" onClick={onStick}>
                <PushPinSimple className="size-4" />
                Stick to app
              </Button>
              <Button size="sm" variant="outline" onClick={onClose}>
                Close preview
              </Button>
              {showPermissionAction && onOpenPermissions ? (
                <Button size="sm" variant="outline" onClick={onOpenPermissions}>
                  Open permissions
                </Button>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={alwaysOnTop} size="sm" onCheckedChange={onAlwaysOnTopChange} />
              Keep on top of other apps
            </label>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Preview lives in its own window</span>
              <span className="text-xs text-muted-foreground">
                Open it to watch the program output — or stick it into this panel.
              </span>
            </div>
            <Button data-videorc-open-preview-window size="sm" onClick={onOpen}>
              Open preview
              <kbd className="ml-2 rounded bg-background/40 px-1.5 font-mono text-[10px]">
                Cmd+P
              </kbd>
            </Button>
          </>
        )
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Native preview is disabled</span>
            <span className="text-xs text-muted-foreground">{disabledMessage}</span>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry preview
              </Button>
            ) : null}
            {onOpenPermissions ? (
              <Button size="sm" variant="outline" onClick={onOpenPermissions}>
                Open permissions
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

type PreviewSupervisorDisplay = {
  title: string
  detail: string
  transportLabel?: string | null
  tone: 'normal' | 'warn'
}

function previewSupervisorDisplay(
  previewWindowOpen: boolean,
  supervisor: PreviewSupervisorState,
  previewSurfaceStatus?: PreviewSurfaceStatus,
  previewLiveStatus?: PreviewLiveStatus
): PreviewSupervisorDisplay {
  if (!previewWindowOpen) {
    return {
      title: 'Preview lives in its own window',
      detail: 'Open it to watch the program output.',
      tone: 'normal'
    }
  }

  switch (supervisor.lifecycleState) {
    case 'surface-live':
      return {
        title: 'Preview is live in its own window',
        detail: 'Drag, resize, or close it anytime',
        transportLabel: previewTransportLabel(supervisor.transport, supervisor.backing),
        tone: 'normal'
      }
    case 'surface-fallback':
      return {
        title: 'Preview is using fallback rendering',
        detail: supervisor.fallbackReason ?? 'Native surface is not available yet.',
        transportLabel: previewTransportLabel(supervisor.transport, supervisor.backing),
        tone: 'warn'
      }
    case 'permission-required':
      return {
        title: 'Preview needs permission',
        detail:
          supervisor.lastError ??
          previewPermissionMessage(supervisor.permissionStatus) ??
          'Permission is required before this source can preview.',
        tone: 'warn'
      }
    case 'failed':
      return {
        title: 'Preview failed',
        detail:
          supervisor.lastError ??
          previewSurfaceStatus?.message ??
          previewLiveStatus?.message ??
          'The preview surface could not start.',
        tone: 'warn'
      }
    case 'opening-window':
      return {
        title: 'Opening preview window',
        detail: 'Preparing the detached preview.',
        tone: 'normal'
      }
    case 'starting-surface':
      return {
        title: 'Starting preview surface',
        detail: 'Connecting the preview window to the compositor.',
        tone: 'normal'
      }
    case 'closing':
      return {
        title: 'Closing preview',
        detail: 'Tearing down the detached preview surface.',
        tone: 'normal'
      }
    case 'open-no-surface':
    case 'closed':
      return {
        title: 'Preview is open in its own window',
        detail: 'Waiting for the preview surface.',
        tone: 'normal'
      }
  }
}

function previewPermissionMessage(
  permissionStatus: PreviewSupervisorState['permissionStatus']
): string | null {
  switch (permissionStatus) {
    case 'screen-recording-required':
      return 'Screen Recording permission is required for screen and window sources.'
    case 'camera-required':
      return 'Camera permission is required for camera sources.'
    case 'unknown':
      return 'Permission is required before this source can preview.'
    case 'ok':
      return null
  }
}

function previewTransportLabel(
  transport: PreviewLiveStatus['transport'] | PreviewSupervisorState['transport'],
  backing?: PreviewSurfaceStatus['backing'] | PreviewSupervisorState['backing']
): string | null {
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
