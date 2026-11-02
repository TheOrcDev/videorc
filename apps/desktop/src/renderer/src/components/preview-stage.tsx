import { CameraIcon, ExternalLinkIcon, PinIcon, WarningIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useDockSlotReporter } from '@/hooks/use-dock-slot'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  DockHiddenReason,
  PreviewLiveStatus,
  PreviewSupervisorState,
  PreviewSurfaceStatus,
  PreviewWindowState,
  SystemPermissionPane
} from '@/lib/backend'
import { systemAccessActionLabel } from '@/lib/system-access-view'
import {
  type SystemAccessAction,
  type SystemAccessRow,
  mediaAccessStatusForPane,
  systemAccessAction
} from '@/lib/system-access'
import { useSystemAccessRows } from '@/hooks/use-system-access-rows'
import { previewHoldLabel } from '@/lib/performance-check'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { isNativePreviewCapability } from '../../../shared/native-preview-capability'
import { WINDOW_NAMES } from '../../../shared/window-names'

type PreviewStageProps = {
  previewLiveStatus?: PreviewLiveStatus
  previewSurfaceStatus?: PreviewSurfaceStatus
  nativePreviewSurfaceEnabled?: boolean
  onRetry?: () => void
  onOpenPermissions?: (pane: SystemPermissionPane) => void
  className?: string
}

type PreviewPermissionAccess = {
  action: SystemAccessAction
  row: SystemAccessRow | undefined
}

/**
 * The fix button for the preview's missing grant (plan 174 B-23): the
 * Permissions list's one wording, "Allow access…" or "Open System
 * Settings…", never "Resolve permission".
 */
function permissionActionLabel(
  access: PreviewPermissionAccess | null,
  platform: string | undefined
): string {
  return systemAccessActionLabel(access?.action ?? null, platform) ?? 'Open Permissions'
}

export function PreviewStage({
  previewLiveStatus,
  previewSurfaceStatus,
  nativePreviewSurfaceEnabled = false,
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
    captureConfig,
    mediaAccess,
    runtimeInfo,
    performanceCheck,
    performanceCheckProgress
  } = useStudioCore()
  const accessRows = useSystemAccessRows()
  const permissionPane = previewPermissionPane(previewWindow.supervisor)
  const permissionRow = accessRows.find((candidate) => candidate.id === permissionPane)
  const permissionAccess: PreviewPermissionAccess | null = permissionPane
    ? {
        row: permissionRow,
        action: systemAccessAction({
          pane: permissionPane,
          checking: permissionRow?.checking,
          state: permissionRow?.state,
          platform: runtimeInfo?.platform,
          mediaAccessStatus: mediaAccessStatusForPane(mediaAccess, permissionPane)
        })
      }
    : null

  const docked =
    nativePreviewSurfaceEnabled && previewWindow.open && previewWindow.mode === 'docked'
  // The reporter is active exactly while the docked frame is on screen; its
  // cleanup tells main the slot unmounted (tab switch, undock, close).
  const slotRef = useDockSlotReporter(docked, previewWindow.dockEpoch, 'studio')

  if (docked) {
    return (
      <DockedPreviewFrame
        aspect={{
          width: captureConfig.video.width,
          height: captureConfig.video.height
        }}
        checkingLabel={previewHoldLabel(performanceCheck, performanceCheckProgress)}
        className={className}
        previewSurfaceStatus={previewSurfaceStatus}
        previewWindow={previewWindow}
        permissionAccess={permissionAccess}
        slotRef={slotRef}
        onClose={() => void closePreviewWindow()}
        onOpenPermissions={onOpenPermissions}
        onPopOut={() => void setPreviewWindowMode('floating')}
        platform={runtimeInfo?.platform}
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
      permissionAccess={permissionAccess}
      onAlwaysOnTopChange={(alwaysOnTop) => void setPreviewWindowAlwaysOnTop(alwaysOnTop)}
      onClose={() => void closePreviewWindow()}
      onOpen={() => void openPreviewWindow()}
      onOpenPermissions={onOpenPermissions}
      onRetry={onRetry}
      onStick={() => void setPreviewWindowMode('docked')}
      platform={runtimeInfo?.platform}
    />
  )
}

export type PreviewDisabledCopy = {
  title: string
  detail: string
  /** Whether "Retry preview" makes sense: never on Linux, where no native
   * preview exists to retry. */
  retryable: boolean
  tone: 'expected' | 'warn'
}

/** Copy for the card when no native preview surface is enabled. On Linux there
 * is no native surface by design (port plan L5, Plan 0007): the Electron proof
 * surface is the preview, so the message names that path and stays calm. */
export function previewDisabledCopy(
  platform: string | undefined,
  disabledMessage: string
): PreviewDisabledCopy {
  if (platform === 'linux') {
    return {
      title: 'Preview runs on the CPU',
      detail: 'Open Preview to watch your scene. Linux draws it on the CPU, so it can lag.',
      retryable: true,
      tone: 'expected'
    }
  }
  return {
    title: 'The fast preview is off',
    detail: disabledMessage,
    retryable: true,
    tone: 'warn'
  }
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

// Docked ("stick") mode: the native preview surface sits over the slot below
// (on macOS a CAMetalLayer inside this very window, plan 213 D3; elsewhere a
// child window glued to the slot), so this frame is what shows through when
// the surface is hidden — it must always state WHY (dockHiddenReason /
// supervisor copy), never sit blank.
function DockedPreviewFrame({
  previewWindow,
  previewSurfaceStatus,
  aspect,
  slotRef,
  onPopOut,
  onClose,
  permissionAccess,
  onOpenPermissions,
  platform,
  checkingLabel,
  className
}: {
  previewWindow: PreviewWindowState
  previewSurfaceStatus?: PreviewSurfaceStatus
  aspect: { width: number; height: number }
  slotRef: (element: HTMLElement | null) => void
  /** Plan 212: the Preview holds its last picture while a check runs; this says why. */
  checkingLabel?: string | null
  onPopOut: () => void
  onClose: () => void
  permissionAccess: PreviewPermissionAccess | null
  onOpenPermissions?: (pane: SystemPermissionPane) => void
  platform?: string
  className?: string
}): ReactElement {
  const supervisor = previewWindow.supervisor
  const hidden = dockHiddenDisplay(previewWindow.dockHiddenReason)
  const status =
    hidden ??
    previewSupervisorDisplay(true, supervisor, previewSurfaceStatus, undefined, permissionAccess)
  const permissionPane = previewPermissionPane(supervisor)
  const footprintRatio = previewFootprintRatio(aspect)
  const slotRatio = previewSlotRatio(aspect)

  return (
    // No border here. The native surface (a layer in this window on macOS, a
    // window glued over the slot elsewhere) clips itself to the panel radius,
    // so the strip below rounds to the same radius. A square strip leaves a
    // corner wedge behind the video.
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
        className="flex w-full items-center justify-center overflow-hidden rounded-panel bg-video-ground"
        data-videorc-dock-strip
        style={{ aspectRatio: footprintRatio }}
      >
        <div
          ref={slotRef}
          /* rounded-panel (12pt) matches the cornerRadius main sends with the
             docked surface bounds (DOCKED_PREVIEW_CORNER_RADIUS): the native
             CAMetalLayer clips itself to the same radius, so the CSS ground
             and the video agree. A parity test pins the two. */
          className="relative h-full overflow-hidden rounded-panel"
          data-videorc-dock-slot="studio"
          style={{ aspectRatio: slotRatio }}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <CameraIcon className="size-8 text-muted-foreground" weight="duotone" />
            <span className="text-sm font-medium text-video-ground-foreground">{status.title}</span>
            {status.detail ? (
              <span className="text-xs text-video-ground-muted">{status.detail}</span>
            ) : null}
          </div>
        </div>
      </div>
      {/* Slim control row under the bare strip (the docked preview has no
          panel around it): session status left, dock controls right, flush
          with the video edges. */}
      <div className="flex items-center justify-end gap-1.5 pt-2">
        {checkingLabel ? (
          <span
            className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            data-videorc-preview-checking
            role="status"
          >
            <Spinner aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{checkingLabel}</span>
          </span>
        ) : null}
        {permissionPane && permissionAccess?.action && onOpenPermissions ? (
          <Button variant="outline" onClick={() => onOpenPermissions(permissionPane)}>
            {permissionActionLabel(permissionAccess, platform)}
          </Button>
        ) : null}
        <Button data-videorc-preview-pop-out variant="secondary" onClick={onPopOut}>
          <ExternalLinkIcon className="size-4" />
          Pop out
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

/** Stated copy for every reason a docked surface is hidden; shared with the
 * Scene canvas (plan 058), which docks the same surface into the stage. */
export function dockHiddenDisplay(
  reason: DockHiddenReason | null
): { title: string; detail: string } | null {
  switch (reason) {
    case 'no-slot-report':
      return { title: 'Placing preview…', detail: '' }
    case 'overlay-open':
      return {
        title: 'Preview hidden under this window',
        detail: 'It returns as soon as it closes. Recording and streaming keep going.'
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
  permissionAccess,
  onOpenPermissions,
  platform,
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
  permissionAccess: PreviewPermissionAccess | null
  onOpenPermissions?: (pane: SystemPermissionPane) => void
  platform?: string
  className?: string
}): ReactElement {
  const supervisorStatus = previewSupervisorDisplay(
    previewWindowOpen,
    previewSupervisor,
    previewSurfaceStatus,
    previewLiveStatus,
    permissionAccess,
    platform
  )
  // The path is named only when it is a fallback (plan 174 B-23).
  const transportLabel =
    previewWindowOpen && supervisorStatus.title !== PREVIEW_FALLBACK_LABEL
      ? (supervisorStatus.transportLabel ??
        previewFallbackLabel(
          previewSurfaceStatus?.transport,
          previewSurfaceStatus?.backing,
          previewSurfaceStatus?.nativePreviewHostKind,
          platform
        ))
      : null
  const detail = [supervisorStatus.detail, transportLabel].filter(Boolean).join(' · ')
  const disabledCopy = previewDisabledCopy(
    platform,
    previewLiveStatus?.message ??
      previewSurfaceStatus?.message ??
      'Videorc is using a slower preview path.'
  )
  const permissionPane = previewPermissionPane(previewSupervisor)
  const showPermissionAction =
    previewWindowOpen && permissionPane !== null && Boolean(permissionAccess?.action)

  return (
    <div
      className={cn(
        // Output-aspect rect (same as the open/docked preview) so the layout
        // never jumps when the preview opens, docks, or closes.
        'flex w-full flex-col items-center justify-center gap-3 rounded-panel bg-inset px-6 text-center',
        className
      )}
      data-videorc-preview-card
      style={{ aspectRatio: previewFootprintRatio(aspect) }}
    >
      {nativePreviewSurfaceEnabled ? (
        supervisorStatus.tone !== 'warn' ? (
          <CameraIcon className="size-8 text-muted-foreground" weight="duotone" />
        ) : (
          <WarningIcon className="size-8 text-warning" weight="duotone" />
        )
      ) : disabledCopy.tone === 'expected' ? (
        <CameraIcon className="size-8 text-muted-foreground" weight="duotone" />
      ) : (
        <WarningIcon className="size-8 text-warning" weight="duotone" />
      )}
      {nativePreviewSurfaceEnabled ? (
        previewWindowOpen ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{supervisorStatus.title}</span>
              {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={onOpen}>
                {`Show ${WINDOW_NAMES.preview}`}
              </Button>
              <Button data-videorc-preview-stick variant="outline" onClick={onStick}>
                <PinIcon className="size-4" />
                Stick to app
              </Button>
              <Button variant="outline" onClick={onClose}>
                {`Close ${WINDOW_NAMES.preview}`}
              </Button>
              {showPermissionAction && permissionPane && onOpenPermissions ? (
                <Button variant="outline" onClick={() => onOpenPermissions(permissionPane)}>
                  {permissionActionLabel(permissionAccess, platform)}
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
                Open it to watch your scene as viewers see it.
              </span>
            </div>
            <Button data-videorc-open-preview-window onClick={onOpen}>
              {`Open ${WINDOW_NAMES.preview}`}
              <ShortcutKeys accelerator={shortcutAccelerator('preview-window')} className="ml-1" />
            </Button>
          </>
        )
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{disabledCopy.title}</span>
            <span className="text-xs text-muted-foreground">{disabledCopy.detail}</span>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {/* The panel header no longer repeats the stage's actions (plan
                174 S3.3, B-23), so the window opens from here too. */}
            {!previewWindowOpen ? (
              <Button variant="outline" onClick={onOpen}>
                Open preview
                <ShortcutKeys
                  accelerator={shortcutAccelerator('preview-window')}
                  className="ml-1"
                />
              </Button>
            ) : null}
            {onRetry && disabledCopy.retryable ? (
              <Button variant="outline" onClick={onRetry}>
                Retry preview
              </Button>
            ) : null}
            {permissionPane && permissionAccess?.action && onOpenPermissions ? (
              <Button variant="outline" onClick={() => onOpenPermissions(permissionPane)}>
                {permissionActionLabel(permissionAccess, platform)}
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

export function previewSupervisorDisplay(
  previewWindowOpen: boolean,
  supervisor: PreviewSupervisorState,
  previewSurfaceStatus?: PreviewSurfaceStatus,
  previewLiveStatus?: PreviewLiveStatus,
  permissionAccess?: PreviewPermissionAccess | null,
  platform?: string
): PreviewSupervisorDisplay {
  if (!previewWindowOpen) {
    return {
      title: 'Preview lives in its own window',
      detail: 'Open it to watch your scene as viewers see it.',
      tone: 'normal'
    }
  }

  switch (supervisor.lifecycleState) {
    case 'surface-live':
      return {
        title: 'Preview is open in its own window',
        detail: 'Drag, resize or close it anytime.',
        transportLabel: previewFallbackLabel(
          supervisor.transport,
          supervisor.backing,
          supervisor.nativePreviewHostKind,
          platform
        ),
        tone: 'normal'
      }
    case 'surface-fallback':
      // AGENTS.md: a fallback is never silent. The reason stays on the card.
      return {
        title: PREVIEW_FALLBACK_LABEL,
        detail: supervisor.fallbackReason ?? 'The faster preview path isn’t available yet.',
        tone: 'warn'
      }
    case 'permission-required':
      if (
        permissionAccess?.action === null &&
        (permissionAccess.row?.state === 'device-issue' ||
          permissionAccess.row?.state === 'granted')
      ) {
        const row = permissionAccess.row
        return {
          title: 'Preview is recovering',
          detail:
            row.state === 'device-issue'
              ? row.detail
              : `${row.label} permission is granted. Reconnecting capture.`,
          tone: 'warn'
        }
      }
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
          'The preview couldn’t start.',
        tone: 'warn'
      }
    case 'opening-window':
    case 'starting-surface':
      return { title: 'Opening preview…', detail: '', tone: 'normal' }
    case 'closing':
      return { title: 'Closing preview…', detail: '', tone: 'normal' }
    case 'open-no-surface':
    case 'closed':
      return {
        title: 'Preview is open in its own window',
        detail: 'Waiting for the first frame…',
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

export function previewPermissionPane(
  supervisor: PreviewSupervisorState
): SystemPermissionPane | null {
  if (supervisor.lifecycleState !== 'permission-required') {
    return null
  }
  switch (supervisor.permissionStatus) {
    case 'camera-required':
      return 'camera'
    case 'screen-recording-required':
      return 'screen-recording'
    case 'unknown':
      return 'privacy'
    case 'ok':
      return null
  }
}

/** What the preview card says when the preview runs on a slower path (plan 174 B-23). */
export const PREVIEW_FALLBACK_LABEL = 'Using a slower preview path'

/**
 * The preview path, named only when it is a fallback for this platform:
 * "Using a slower preview path", or null. The transport's engineering names
 * ("Surface proof", "Electron proof") stay in Health. Linux has no native
 * surface, so its CPU path is the preview; Windows ships the proof surface as
 * its production presenter (AGENTS.md), so it is not a fallback there, and
 * nothing ever calls it native.
 */
export function previewFallbackLabel(
  transport: PreviewLiveStatus['transport'] | PreviewSupervisorState['transport'] | undefined,
  backing?: PreviewSurfaceStatus['backing'] | PreviewSupervisorState['backing'],
  hostKind?:
    | PreviewSurfaceStatus['nativePreviewHostKind']
    | PreviewSupervisorState['nativePreviewHostKind'],
  platform?: string
): string | null {
  const os = platform ?? 'darwin'
  if (os !== 'darwin' && os !== 'win32') return null
  if (
    !transport ||
    transport === 'unavailable' ||
    transport === 'none' ||
    transport === 'unknown'
  ) {
    return null
  }
  if (os === 'win32' && transport === 'electron-proof-surface') return null
  const native = isNativePreviewCapability(
    {
      transport,
      backing: backing === 'unknown' || backing === undefined ? 'none' : backing,
      nativePreviewHostKind: hostKind
    },
    os
  )
  return native ? null : PREVIEW_FALLBACK_LABEL
}
