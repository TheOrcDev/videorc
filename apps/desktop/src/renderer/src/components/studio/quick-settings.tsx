import {
  type AppIcon,
  CameraIcon,
  CaptionsIcon,
  DesktopIcon,
  DisplayIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { DevicePicker } from '@/components/device-picker'
import { GroupedList } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { Button } from '@/components/ui/button'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import { buildCameraSources, buildCaptureSources, capturePickerDevices } from '@/lib/capture'
import { captionsStatusLabel, systemAudioIssueLabel } from '@/lib/state-labels'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import {
  systemAudioDevice,
  requestSystemAudioResume,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'

/**
 * The Studio inspector's mirrors of controls that own their own pages (SD2):
 * Sources (Screen, Camera, System audio, with Open Sources as the way home),
 * then Captions on its own, because captions aren't a source (plan 174 S3.3,
 * B-15 and B-25). They edit the SAME captureConfig via the shared builders /
 * setters (one state). Device source edits use the shared session controller.
 * Output is one row, the Session section's. Scene switching lives in the
 * Scenes gallery; the microphone and its live level live in the Microphone
 * section above (plan 092), so no Mic row here.
 */
export function QuickSettings(): ReactElement {
  const {
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
    selectedCaptureId
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
              selectedName={captureConfig.sources.screenName ?? captureConfig.sources.windowName}
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
              selectedName={captureConfig.sources.cameraName}
              trigger="inline"
              value={captureConfig.sources.cameraId}
              onChange={(cameraId) =>
                void switchSourceDeviceLive(
                  'camera',
                  buildCameraSources(captureConfig.sources, cameras, cameraId)
                )
              }
            />
          </InspectorRow>

          {/* SYSTEM AUDIO: plan 069 On/Off, live-safe; hidden where unsupported. */}
          {systemAudio.visible ? (
            <InspectorRow icon={DesktopIcon} label="System audio">
              <SystemAudioInspectorValue
                platform={runtimeInfo?.platform}
                view={systemAudio}
                onEnabledChange={(systemAudioEnabled) =>
                  setCaptureConfig((current) => ({
                    ...current,
                    audio: { ...current.audio, systemAudioEnabled }
                  }))
                }
                onOpenPermissions={() => openSettings('permissions')}
                onResume={requestSystemAudioResume}
              />
            </InspectorRow>
          ) : null}
        </GroupedList>
      </PanelSection>

      {/* Captions, below Sources and under no heading of its own: the row
        names it, and a captions switch is not a source (B-15). */}
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
        </GroupedList>
      </PanelSection>
    </>
  )
}

/**
 * Short state beside the switch; the full health copy is its tooltip and its
 * description, on hover and on focus (plan 174 S1.10).
 */
export function SystemAudioInspectorValue({
  view,
  platform,
  onEnabledChange,
  onOpenPermissions,
  onResume
}: {
  view: SystemAudioSwitchView
  /** `runtimeInfo.platform`, so the health copy names this computer. */
  platform?: string
  onEnabledChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  /** Plan 076: turn System audio on again after the echo guard paused it. */
  onResume: () => void
}): ReactElement {
  // The Sources row's words for the same issue (plan 174 J2-4).
  const status = view.issue ? systemAudioIssueLabel(view.issue) : view.stateLabel
  return (
    <div className="flex h-control min-w-0 items-center justify-end gap-2.5 px-2">
      {view.permissionRequired ? (
        // The row is narrow: the permission route replaces the (disabled)
        // switch here; the mixer and Sources show both.
        <InfoTooltip content="System audio needs Screen Recording permission." focusable={false}>
          <Button className="min-w-0" size="xs" variant="ghost" onClick={onOpenPermissions}>
            <span className="truncate">Needs permission</span>
          </Button>
        </InfoTooltip>
      ) : (
        <>
          {view.issue === 'echo' ? (
            // The row is narrow: Resume replaces the status; its tooltip and
            // description say why.
            <InfoTooltip content={systemAudioIssueCopy('echo', platform)} focusable={false}>
              <Button className="min-w-0" size="xs" variant="ghost" onClick={onResume}>
                <span className="truncate">Resume</span>
              </Button>
            </InfoTooltip>
          ) : (
            <InfoTooltip
              className="min-w-0"
              content={view.issue ? systemAudioIssueCopy(view.issue, platform) : null}
            >
              <span className="min-w-0 truncate text-sm font-medium">{status}</span>
            </InfoTooltip>
          )}
          <Switch
            aria-label="System audio"
            checked={view.checked}
            disabled={view.disabled}
            onCheckedChange={onEnabledChange}
          />
        </>
      )}
    </div>
  )
}

/** A label on the left, its value control filling the right (the inspector row). */
function InspectorRow({
  icon: RowIcon,
  label,
  status,
  children
}: {
  icon: AppIcon
  label: string
  /** A live-switch status line under the row; collapses when it renders nothing. */
  status?: ReactNode
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
    </div>
  )
}

/**
 * What the Studio's Sources rows show and act with: the same state for the
 * inspector's rows and the Retro LCD screen (plan 197).
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
    captionsStatus,
    wsStatus,
    systemAudioConfirmed,
    systemAudioIssue,
    runtimeInfo
  } = useStudioCore()
  const { openSettings, openStudioPanel } = useWorkspaceNav()
  const systemAudio = systemAudioSwitchView({
    device: systemAudioDevice(deviceList),
    requested: captureConfig.audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    confirmed: systemAudioConfirmed,
    issue: systemAudioIssue
  })
  // Q6 (plan 022): before the backend reports devices, selects say "Finding
  // devices…" instead of rendering blank.
  const discoveryPending = wsStatus !== 'connected'

  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
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
    selectedCaptureId
  }
}
