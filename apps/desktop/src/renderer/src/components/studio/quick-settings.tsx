import {
  type AppIcon,
  CameraIcon,
  CaptionsIcon,
  ChatIcon,
  InfoIcon,
  WarningIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { CameraBackgroundLine } from '@/components/camera-background/camera-background-popover'
import { useCameraBackground } from '@/components/camera-background/use-camera-background'
import { DevicePicker } from '@/components/device-picker'
import { GroupedList } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { OpenPageCog } from '@/components/studio/open-page-cog'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import {
  useStudioChat,
  useStudioCore,
  useStudioPreview,
  useStudioRecordingState,
  useStudioShell
} from '@/hooks/use-studio'
import { cameraBackgroundStageLine } from '@/lib/camera-background-view'
import { cameraSystemEffectLine } from '@/lib/camera-system-effect'
import { buildCameraSources, sourceStandIn, type SourceStandIn } from '@/lib/capture'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { standInLine } from '@/lib/source-status'
import { captionsStatusLabel } from '@/lib/state-labels'
import { chatDoorNewLabel } from '@/lib/studio-chat'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { systemAudioRowDevice, systemAudioSwitchView } from '@/lib/system-audio'
import { WINDOW_NAMES } from '../../../../shared/window-names'

/**
 * The Studio inspector's mirrors of controls that own their own pages (SD2):
 * Sources (the Camera, with the Open Sources cog as the way home; plan 231 D8
 * moved the Screen to the scene that shows it, in the Scenes section), then
 * Captions and Chat on their own, because neither is a source (plan 174 S3.3,
 * B-15 and B-25; plan 213 B1). They edit the SAME captureConfig via the shared builders /
 * setters (one state). Device source edits use the shared session controller.
 * Output is one row, the Session section's. Scene switching lives in the
 * Scenes gallery; the microphone and System audio, with their levels and
 * Gain, live in the Audio section above (plans 092 and 201), so no audio
 * rows here.
 */
export function QuickSettings(): ReactElement {
  const {
    captureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    selectedCamera,
    isSessionActive,
    captionsStatus,
    openStudioPanel,
    discoveryPending,
    cameras,
    selectedCameraId,
    cameraStandIn,
    cameraBackground
  } = useStudioSources()

  return (
    <>
      {/* No "Sources" title (plan 235 D3): the rows name themselves, and the
          group keeps its name for screen readers. The way to Sources is the
          cog at the end of the Camera row (D4). The Screen lives with the
          scene that shows it, in the Scenes section (plan 231 D8). */}
      <PanelSection>
        <GroupedList aria-label="Sources" role="group">
          {/* CAMERA: its own row (plan 080 S4). Off is a choice that sticks. */}
          <InspectorRow
            footer={
              <>
                <StandInLine standIn={cameraStandIn} />
                <CameraBackgroundLine control={cameraBackground} />
                <BackgroundStageLine />
                <SystemEffectLine />
              </>
            }
            icon={CameraIcon}
            label="Camera"
            status={<SourceSwitchStatus kind="camera" />}
            trailing={
              <OpenPageCog label="Open Sources" onOpen={() => openWorkspaceTab('sources')} />
            }
          >
            <DevicePicker
              devices={cameras}
              disabled={Boolean(sourceSwitchReason('camera'))}
              discoveryPending={discoveryPending}
              kind="camera"
              label="Camera"
              noneLabel="Off"
              selectedDevice={selectedCamera}
              selectedName={
                captureConfig.sources.cameraName ?? captureConfig.sources.wantedCameraName
              }
              trigger="inline"
              value={selectedCameraId}
              onChange={(cameraId) =>
                void switchSourceDeviceLive(
                  'camera',
                  buildCameraSources(captureConfig.sources, cameras, cameraId)
                )
              }
            />
          </InspectorRow>
        </GroupedList>
      </PanelSection>

      {/* Captions and Chat, below Sources and under no heading of their own:
        each row names itself, and neither is a source (B-15). */}
      <PanelSection>
        <GroupedList>
          {/* CAPTIONS — a door to the Captions page (plan 174 S3.2, B-13), where
            the switch sits beside its upload disclosure. A switch here turned
            on cloud audio upload with no word about it. */}
          <NavigableRow
            icon={CaptionsIcon}
            label="Captions"
            value={captionsStatusLabel(captionsStatus, {
              enabled: captureConfig.captions.enabled,
              sessionActive: isSessionActive
            })}
            onNavigate={() => openStudioPanel('captions')}
          />
          <ChatDoorRow />
        </GroupedList>
      </PanelSection>
    </>
  )
}

/**
 * CHAT — a door to the Stream Manager, built like Captions' (plan 213 B1,
 * D1): a new streamer found no chat in the idle Studio. Never a switch: Chat
 * in Studio stays a setting, off by default (plan 204 D3). Its own component,
 * so a chat message re-renders this row and nothing else.
 */
export function ChatDoorRow(): ReactElement | null {
  const door = useStudioChatDoor()
  if (!door) return null
  return (
    <NavigableRow
      hint={door.newLabel ? door.openLabel : undefined}
      icon={ChatIcon}
      label="Chat"
      value={
        door.newLabel ?? (
          <span className="flex min-w-0 items-center gap-1.5" data-testid="studio-chat-door">
            <span className="truncate">{WINDOW_NAMES.streamManager}</span>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <ShortcutKeys
              accelerator={door.accelerator}
              className="font-normal text-muted-foreground"
              platform={door.platform}
              variant="text"
            />
          </span>
        )
      }
      onNavigate={door.open}
    />
  )
}

/**
 * What both looks' Chat rows show and do (plan 213 B1): "{n} new" while a
 * livestream with chat is on air, else the door and its key. Null when this
 * build has no Stream Manager, like the status bar's hint.
 */
export function useStudioChatDoor(): {
  newLabel: string | null
  openLabel: string
  accelerator: string
  platform?: string
  open: () => void
} | null {
  const { liveChatSnapshot, chatNewCount } = useStudioChat()
  const { recording } = useStudioRecordingState()
  const { openCommentsWindow, runtimeInfo } = useStudioShell()
  if (runtimeInfo?.commentsWindowEnabled === false) return null
  return {
    newLabel: chatDoorNewLabel({ recording, snapshot: liveChatSnapshot, newCount: chatNewCount }),
    openLabel: `Open ${WINDOW_NAMES.streamManager}`,
    accelerator: shortcutAccelerator('comments-window'),
    platform: runtimeInfo?.platform,
    open: () => void openCommentsWindow()
  }
}

/** A label on the left, its value control filling the right (the inspector row). */
function InspectorRow({
  icon: RowIcon,
  label,
  status,
  footer,
  trailing,
  children
}: {
  icon: AppIcon
  label: string
  /** A live-switch status line under the row; collapses when it renders nothing. */
  status?: ReactNode
  /** The row's own lines under its status (the Camera row's Background). */
  footer?: ReactNode
  /** A compact action at the row's right end, after its control (the Camera row's cog). */
  trailing?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col" data-slot="inspector-row">
      <div className="flex min-h-row items-center gap-2.5 py-0.5 pr-1 pl-3">
        <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="w-22 shrink-0 truncate text-sm text-muted-foreground">{label}</span>
        <div className="flex min-w-0 flex-1 justify-end">{children}</div>
        {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}
      </div>
      {status ? (
        <div className="px-3 pb-2 pl-9.5 text-xs text-muted-foreground empty:hidden">{status}</div>
      ) : null}
      {footer}
    </div>
  )
}

/**
 * Plan 213 E1: the pick is not connected and another source stands in for it
 * this session. One calm line under the row, idle too; nothing while the pick
 * itself is in use.
 */
function StandInLine({ standIn }: { standIn: SourceStandIn | undefined }): ReactElement | null {
  if (!standIn) return null
  return (
    <p className="px-3 pb-2 pl-9.5 text-xs text-muted-foreground" data-slot="source-stand-in">
      {standInLine(standIn)}
    </p>
  )
}

/**
 * Plan 258 S4: macOS Video Effects or Windows Studio Effects is changing the
 * camera's background before Videorc sees it. One calm line under the row,
 * never a toast (mockup §3). Its own component, so the camera status's
 * 4 Hz updates re-render this line and nothing else.
 */
function SystemEffectLine(): ReactElement {
  const line = useCameraSystemEffectLine()
  // Kept mounted while empty, so a screen reader hears the line arrive.
  return (
    <div aria-live="polite" className="empty:hidden">
      {line ? (
        <p
          className="flex items-start gap-1.5 px-3 pb-2 pl-9.5 text-xs text-muted-foreground"
          data-slot="camera-system-effect"
        >
          <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{line}</span>
        </p>
      ) : null}
    </div>
  )
}

/** Both looks' system effect line (plan 258 S4): the copy for the camera in use, or null. */
export function useCameraSystemEffectLine(): string | null {
  return cameraSystemEffectLine(useStudioPreview().previewCameraStatus.systemEffect)
}

/**
 * Plan 258 S5 (mockup §3): the camera effect stage is covering for itself
 * (2 s of cover) or can't run here. One line under the Background trigger,
 * beside S4's system effect line, never a toast; viewers see the cover,
 * never the room, and the line says what they see. Its own component, so
 * the camera status's updates re-render this line and nothing else.
 */
function BackgroundStageLine(): ReactElement {
  const line = useCameraBackgroundStageLine()
  return (
    <div aria-live="polite" className="empty:hidden">
      {line ? (
        <p
          className="flex items-start gap-1.5 px-3 pb-2 pl-9.5 text-xs text-muted-foreground"
          data-slot="camera-background-stage"
        >
          <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0 tone-warning" />
          <span className="min-w-0">{line}</span>
        </p>
      ) : null}
    </div>
  )
}

/** Both looks' stage line (plan 258 S5): the copy for the camera in use, or null. */
export function useCameraBackgroundStageLine(): string | null {
  return (
    cameraBackgroundStageLine(useStudioPreview().previewCameraStatus.cameraBackground)?.text ?? null
  )
}

/**
 * What the Studio's Sources rows show and act with: the same state for the
 * inspector's rows and the Retro LCD screen (plan 197), which keeps its
 * System audio row until plan 201 S3 moves it to the Audio screen.
 */
export function useStudioSources() {
  const {
    captureConfig,
    setCaptureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    deviceList,
    selectedCamera,
    isSessionActive,
    audioBusActive,
    captionsStatus,
    wsStatus,
    systemAudioConfirmed,
    systemAudioJoining,
    systemAudioIssue,
    runtimeInfo
  } = useStudioCore()
  const { openSettings, openStudioPanel } = useWorkspaceNav()
  const systemAudio = systemAudioSwitchView({
    device: systemAudioRowDevice(deviceList, runtimeInfo?.platform),
    requested: captureConfig.audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    audioBusActive,
    confirmed: systemAudioConfirmed,
    joining: systemAudioJoining,
    issue: systemAudioIssue
  })
  // Q6 (plan 022): before the backend reports devices, selects say "Finding
  // devices…" instead of rendering blank.
  const discoveryPending = wsStatus !== 'connected'

  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  // Plan 213 E1: what is in use, else the pick itself as the device that is gone.
  const { sources } = captureConfig
  const selectedCameraId = sources.cameraId ?? sources.wantedCameraId
  const cameraStandIn = sourceStandIn(sources, 'camera', deviceList.devices)
  // Plan 258 S5: the camera's one Background pick (a blur, a picture or a
  // screen), kept per camera; both looks show the same control.
  const cameraBackground = useCameraBackground()
  return {
    captureConfig,
    setCaptureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    selectedCamera,
    isSessionActive,
    captionsStatus,
    runtimeInfo,
    openSettings,
    openStudioPanel,
    systemAudio,
    discoveryPending,
    cameras,
    selectedCameraId,
    cameraStandIn,
    cameraBackground
  }
}
