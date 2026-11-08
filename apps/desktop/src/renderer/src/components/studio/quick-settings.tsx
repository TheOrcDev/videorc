import {
  type AppIcon,
  CameraIcon,
  CaptionsIcon,
  ChatIcon,
  DisplayIcon,
  HiddenIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { DevicePicker } from '@/components/device-picker'
import { GroupedList } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import {
  useStudioChat,
  useStudioCore,
  useStudioRecordingState,
  useStudioShell
} from '@/hooks/use-studio'
import {
  buildCameraSources,
  buildCaptureSources,
  capturePickerDevices,
  sourceStandIn,
  type SourceStandIn
} from '@/lib/capture'
import {
  SCREEN_HIDDEN_LABEL,
  screenHideAccelerator,
  screenPrivacyActionLabel,
  screenPrivacyDisabledReason
} from '@/lib/screen-privacy-view'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { standInLine } from '@/lib/source-status'
import { captionsStatusLabel } from '@/lib/state-labels'
import { chatDoorNewLabel } from '@/lib/studio-chat'
import { toastUserError } from '@/lib/user-error'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { systemAudioRowDevice, systemAudioSwitchView } from '@/lib/system-audio'
import { WINDOW_NAMES } from '../../../../shared/window-names'

/**
 * The Studio inspector's mirrors of controls that own their own pages (SD2):
 * Sources (Screen and Camera, with Open Sources as the way home), then
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
    allowCaptureNone,
    selectedCaptureDevice,
    selectedCamera,
    isSessionActive,
    captionsStatus,
    openStudioPanel,
    discoveryPending,
    captureDevices,
    cameras,
    selectedCaptureId,
    selectedCameraId,
    cameraStandIn,
    captureStandIn,
    screenPrivacy
  } = useStudioSources()

  return (
    <>
      <PanelSection
        action={
          <Button variant="ghost" onClick={() => openWorkspaceTab('sources')}>
            Open Sources
          </Button>
        }
        title="Sources"
      >
        <GroupedList>
          {/* SCREEN: one click straight to the list (owner, 2026-09-30); the
            searchable picker stays on Sources. */}
          <InspectorRow
            footer={
              <>
                <StandInLine standIn={captureStandIn} />
                <ScreenPrivacyLine control={screenPrivacy} />
              </>
            }
            icon={DisplayIcon}
            label="Screen"
            status={<SourceSwitchStatus kind="capture" />}
          >
            {/* F-015: the synthetic diagnostic source replaces the screen, so the
              row says so instead of claiming no screen. */}
            <DevicePicker
              devices={captureDevices}
              disabled={Boolean(sourceSwitchReason('capture'))}
              discoveryPending={discoveryPending}
              groupByKind
              kind="capture"
              label="Screen"
              noneLabel={allowCaptureNone ? 'None' : undefined}
              selectedDevice={selectedCaptureDevice}
              selectedName={
                captureConfig.sources.screenName ??
                captureConfig.sources.windowName ??
                captureConfig.sources.wantedWindowName ??
                captureConfig.sources.wantedScreenName
              }
              selectionLabel={captureConfig.sources.testPattern ? 'Test pattern' : undefined}
              trigger="inline"
              value={selectedCaptureId}
              onChange={(captureId) =>
                void switchSourceDeviceLive(
                  'capture',
                  buildCaptureSources(captureConfig.sources, captureDevices, captureId)
                )
              }
            />
          </InspectorRow>

          {/* CAMERA: its own row (plan 080 S4). Off is a choice that sticks. */}
          <InspectorRow
            footer={<StandInLine standIn={cameraStandIn} />}
            icon={CameraIcon}
            label="Camera"
            status={<SourceSwitchStatus kind="camera" />}
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
  children
}: {
  icon: AppIcon
  label: string
  /** A live-switch status line under the row; collapses when it renders nothing. */
  status?: ReactNode
  /** The row's own line under its status (the Screen row's Hide screen). */
  footer?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col" data-slot="inspector-row">
      <div className="flex min-h-row items-center gap-2.5 py-0.5 pr-1 pl-3">
        <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <span className="w-22 shrink-0 truncate text-sm text-muted-foreground">{label}</span>
        <div className="flex min-w-0 flex-1 justify-end">{children}</div>
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
 * Hide screen on the Screen row (plan 210 D9): a 24 px button with its key,
 * never beside Record and Go Live (owner, 2026-10-12). It stays at the right
 * edge in both states, so Show screen is where Hide screen was. While hidden
 * the chip says so; it shows with or without a screen in the scene, because
 * hiding is allowed either way. No toast: the chip and the Preview say it.
 */
function ScreenPrivacyLine({ control }: { control: ScreenPrivacyControl }): ReactElement {
  const { hidden, accelerator, platform, disabledReason, toggle } = control
  const label = screenPrivacyActionLabel(hidden)
  const button = (
    <Button
      data-videorc-screen-privacy=""
      disabled={disabledReason !== null}
      size="xs"
      variant="outline"
      onClick={toggle}
    >
      {label}
    </Button>
  )
  return (
    <div
      className="flex min-h-8 items-center gap-2 pr-1 pb-2 pl-9.5"
      data-hidden={hidden || undefined}
      data-slot="screen-privacy"
    >
      {hidden ? <StatusBadge icon={HiddenIcon} tone="warn" value={SCREEN_HIDDEN_LABEL} /> : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* The key teaches itself while there is room; while hidden the chip
            takes that room, and the tooltip keeps the key. */}
        {accelerator && !hidden ? (
          <ShortcutKeys accelerator={accelerator} platform={platform} />
        ) : null}
        {disabledReason ? (
          <DisabledReason reason={disabledReason}>{button}</DisabledReason>
        ) : (
          <ShortcutTooltip accelerator={accelerator} label={label} platform={platform}>
            {button}
          </ShortcutTooltip>
        )}
      </div>
    </div>
  )
}

/** What both looks' Hide screen controls show and do (the row and the Retro LCD's). */
export interface ScreenPrivacyControl {
  hidden: boolean
  /** The bound key, absent when the streamer cleared it. */
  accelerator?: string
  platform?: string
  /** Why the action is off (a refused hide, Videorc offline), or null. */
  disabledReason: string | null
  toggle: () => void
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
    allowCaptureNone,
    deviceList,
    selectedCaptureDevice,
    selectedCamera,
    isSessionActive,
    audioBusActive,
    captionsStatus,
    wsStatus,
    systemAudioConfirmed,
    systemAudioJoining,
    systemAudioIssue,
    runtimeInfo,
    settings,
    screenPrivacy: privacy,
    hideScreen,
    showScreen
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

  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  // Plan 213 E1: what is in use, else the pick itself as the device that is gone.
  const { sources } = captureConfig
  const selectedCaptureId =
    sources.screenId ?? sources.windowId ?? sources.wantedWindowId ?? sources.wantedScreenId
  const selectedCameraId = sources.cameraId ?? sources.wantedCameraId
  const cameraStandIn = sourceStandIn(sources, 'camera', deviceList.devices)
  const captureStandIn = sourceStandIn(sources, 'capture', deviceList.devices)
  // Plan 210 S8b: the one Studio action, by the state it shows. A failure
  // says so; a refused hide is the hook's warning, and success is silent.
  const screenPrivacy: ScreenPrivacyControl = {
    hidden: privacy.hidden,
    accelerator: screenHideAccelerator(settings.globalShortcuts?.screenHideToggle),
    platform: runtimeInfo?.platform,
    disabledReason: screenPrivacyDisabledReason(privacy, wsStatus === 'connected'),
    toggle: () => {
      const hidden = privacy.hidden
      void (hidden ? showScreen() : hideScreen()).catch((error: unknown) =>
        toastUserError(
          error,
          { action: hidden ? 'show' : 'hide', object: 'your screen' },
          { id: 'screen-privacy' }
        )
      )
    }
  }
  return {
    captureConfig,
    setCaptureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    allowCaptureNone,
    selectedCaptureDevice,
    selectedCamera,
    isSessionActive,
    captionsStatus,
    runtimeInfo,
    openSettings,
    openStudioPanel,
    systemAudio,
    discoveryPending,
    captureDevices,
    cameras,
    selectedCaptureId,
    selectedCameraId,
    cameraStandIn,
    captureStandIn,
    screenPrivacy
  }
}
