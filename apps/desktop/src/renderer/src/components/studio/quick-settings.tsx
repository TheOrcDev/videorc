import {
  type AppIcon,
  CameraIcon,
  CaptionsIcon,
  DesktopIcon,
  DisplayIcon,
  RecordIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import { missingSelection, sourceSelectPlaceholder } from '@/lib/source-select-state'
import { recordingQuality } from '@/lib/studio-session-view'
import type { CaptionsStatus, Device } from '@/lib/backend'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import {
  buildCameraSources,
  buildCaptureSources,
  capturePickerDevices,
  layoutPresetOrientation,
  resolutionOptionsForOrientation
} from '@/lib/capture'
import {
  systemAudioDevice,
  requestSystemAudioResume,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'

function resolutionKey(width: number, height: number): string {
  return `${width}x${height}`
}

function compactCaptionsStatus(
  status: CaptionsStatus,
  enabled: boolean,
  sessionActive: boolean,
  premiumAllowed: boolean
): string {
  switch (status.state) {
    case 'starting':
      return 'Starting…'
    case 'listening':
    case 'live':
      return sessionActive ? 'Live' : 'Waiting for session'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'degraded':
      return 'Higher delay'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'ready':
      return 'Ready'
    default:
      return enabled ? 'Armed' : premiumAllowed ? 'Off' : 'Premium'
  }
}

/**
 * Inputs (SD2): the Studio inspector's grouped rows mirroring the controls
 * that own their own pages: Screen, Camera, System audio, Output, Captions.
 * They edit the SAME captureConfig via the shared builders / setters (one
 * state). Device and preset source edits use the shared session controller.
 * Scene switching lives in the Scenes gallery; the microphone and its live
 * level live in the Microphone section above (plan 092), so no Mic row here.
 */
export function QuickSettings(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    allowCaptureNone,
    deviceList,
    selectedCaptureDevice,
    selectedCamera,
    patchVideo,
    isSessionActive,
    entitlements,
    captionsStatus,
    captionsCommandPending,
    wsStatus,
    systemAudioConfirmed,
    systemAudioIssue
  } = useStudioCore()
  const { openSettings } = useWorkspaceNav()
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
  const captionsGate = cloudAiUploadGate(entitlements)
  const captionsEnabled = captureConfig.captions.enabled

  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  // Resolution options mirror the Output tab (recording-tab.tsx) and follow
  // the Studio mode — vertical mode offers only portrait canvases (the mode
  // toggle is the one home for orientation).
  const resolutions = resolutionOptionsForOrientation(
    layoutPresetOrientation(captureConfig.layout.layoutPreset)
  )
  const currentResolution = resolutionKey(captureConfig.video.width, captureConfig.video.height)
  const knownResolution = resolutions.some(
    (resolution) => resolutionKey(resolution.width, resolution.height) === currentResolution
  )

  // F-015: the synthetic diagnostic source replaces the screen, so say so
  // instead of claiming "No screen". Plan 080 S4: screen and camera are two
  // rows, so neither name is truncated to fit beside the other; a saved
  // device that is missing keeps its saved name.
  const screenSummary = captureConfig.sources.testPattern
    ? 'Test pattern'
    : (selectedCaptureDevice?.name ??
      captureConfig.sources.screenName ??
      captureConfig.sources.windowName ??
      'None')
  const cameraSummary =
    selectedCamera?.name ??
    (captureConfig.sources.cameraId ? captureConfig.sources.cameraName : undefined) ??
    'Off'

  return (
    <PanelSection title="Inputs">
      <GroupedList>
        {/* SCREEN: one click straight to the list (owner, 2026-09-30); the
            searchable picker stays on Sources. */}
        <InspectorRow
          icon={DisplayIcon}
          label="Screen"
          status={<SourceSwitchStatus kind="capture" />}
        >
          <InspectorSourceSelect
            allowNone={allowCaptureNone}
            devices={captureDevices}
            disabled={Boolean(sourceSwitchReason('capture'))}
            discoveryPending={discoveryPending}
            groupByKind
            label="Screen"
            selectedName={captureConfig.sources.screenName ?? captureConfig.sources.windowName}
            summary={screenSummary}
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
          <InspectorSourceSelect
            allowNone
            devices={cameras}
            disabled={Boolean(sourceSwitchReason('camera'))}
            discoveryPending={discoveryPending}
            label="Camera"
            noneLabel="Off"
            selectedName={captureConfig.sources.cameraName}
            summary={cameraSummary}
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

        {/* OUTPUT — recording resolution, mirroring the Output tab's options. */}
        <InspectorRow icon={RecordIcon} label="Output">
          <Select
            disabled={isSessionActive}
            value={knownResolution ? currentResolution : ''}
            onValueChange={(value) => {
              const match = resolutions.find(
                (resolution) => resolutionKey(resolution.width, resolution.height) === value
              )
              if (match) {
                patchVideo({ width: match.width, height: match.height })
              }
            }}
          >
            <SelectTrigger className="w-full justify-end border-transparent bg-transparent px-2 font-medium hover:bg-accent data-[state=open]:bg-accent">
              {/* Q7 (plan 022): the compact trigger shows the short canonical
                form ("2K · 1440p30"); the full dimensions live in the items. */}
              <SelectValue placeholder="Custom">
                {recordingQuality(captureConfig.video)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {resolutions.map((resolution) => (
                <SelectItem
                  key={resolution.label}
                  value={resolutionKey(resolution.width, resolution.height)}
                >
                  {resolution.label} · {resolution.detail}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InspectorRow>

        {/* CAPTIONS — live-safe premium toggle mirroring the Streaming tab's
          Live captions section (the config home, incl. the consent copy). */}
        <InspectorRow icon={CaptionsIcon} label="Captions">
          <div className="flex h-control items-center justify-end gap-2.5 px-2">
            <span className="min-w-0 truncate text-sm font-medium">
              {compactCaptionsStatus(
                captionsStatus,
                captionsEnabled,
                isSessionActive,
                captionsGate.allowed
              )}
            </span>
            <Switch
              aria-label="Enable live captions"
              checked={captionsEnabled}
              disabled={captionsCommandPending || (!captionsEnabled && !captionsGate.allowed)}
              onCheckedChange={(enabled) =>
                setCaptureConfig((current) => ({
                  ...current,
                  captions: { ...current.captions, enabled }
                }))
              }
            />
          </div>
        </InspectorRow>
      </GroupedList>
    </PanelSection>
  )
}

/** Short state beside the switch; the full health copy lives in its tooltip. */
export function SystemAudioInspectorValue({
  view,
  onEnabledChange,
  onOpenPermissions,
  onResume
}: {
  view: SystemAudioSwitchView
  onEnabledChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  /** Plan 076: turn System audio on again after the echo guard paused it. */
  onResume: () => void
}): ReactElement {
  const status =
    view.issue === 'lost'
      ? 'Stopped'
      : view.issue === 'bypassed'
        ? 'Off for this session'
        : view.issue === 'echo'
          ? 'Paused'
          : view.issue
            ? 'Could not start'
            : view.stateLabel
  return (
    <div className="flex h-control min-w-0 items-center justify-end gap-2.5 px-2">
      {view.permissionRequired ? (
        // The row is narrow: the permission route replaces the (disabled)
        // switch here; the mixer and Sources show both.
        <Button
          className="min-w-0"
          size="xs"
          title="System audio needs Screen Recording permission."
          variant="ghost"
          onClick={onOpenPermissions}
        >
          <span className="truncate">Needs permission</span>
        </Button>
      ) : (
        <>
          {view.issue === 'echo' ? (
            // The row is narrow: Resume replaces the status; its title says why.
            <Button
              className="min-w-0"
              size="xs"
              title={systemAudioIssueCopy('echo')}
              variant="ghost"
              onClick={onResume}
            >
              <span className="truncate">Resume</span>
            </Button>
          ) : (
            <span
              className="min-w-0 truncate text-sm font-medium"
              title={view.issue ? systemAudioIssueCopy(view.issue) : undefined}
            >
              {status}
            </span>
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

const NONE_VALUE = '__none__'

/**
 * A device picker that IS the row control: one click opens the list, like the
 * Output row. The popover-around-a-select it replaces took two clicks (owner,
 * 2026-09-30: "it should just be one").
 */
function InspectorSourceSelect({
  label,
  devices,
  value,
  selectedName,
  summary,
  allowNone = false,
  noneLabel = 'None',
  groupByKind = false,
  disabled,
  discoveryPending,
  onChange
}: {
  label: string
  devices: Device[]
  value: string | undefined
  selectedName?: string
  summary: string
  allowNone?: boolean
  noneLabel?: string
  /** Screens and windows under their own headings. */
  groupByKind?: boolean
  disabled: boolean
  discoveryPending: boolean
  onChange: (value: string | undefined) => void
}): ReactElement {
  const missing = missingSelection(devices, value, selectedName)
  const screens = devices.filter((device) => device.kind === 'screen')
  const windows = devices.filter((device) => device.kind === 'window')
  const groups =
    groupByKind && screens.length && windows.length
      ? [
          { heading: 'Screens', items: screens },
          { heading: 'Windows', items: windows }
        ]
      : [{ heading: undefined, items: devices }]
  return (
    <Select
      disabled={disabled}
      value={value ?? (allowNone ? NONE_VALUE : '')}
      onValueChange={(next) => onChange(next === NONE_VALUE || next === '' ? undefined : next)}
    >
      <SelectTrigger
        aria-label={label}
        className="w-full min-w-0 justify-end border-transparent bg-transparent px-2 font-medium hover:bg-accent data-[state=open]:bg-accent"
        title={summary}
      >
        <SelectValue>
          <span className="min-w-0 truncate text-right">{summary}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="max-w-80" position="popper">
        {allowNone ? <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem> : null}
        {missing ? (
          <SelectItem disabled value={missing.value}>
            {missing.label}
          </SelectItem>
        ) : null}
        {devices.length === 0 ? (
          <SelectItem disabled value="__empty__">
            {sourceSelectPlaceholder(0, discoveryPending)}
          </SelectItem>
        ) : null}
        {groups.map((group, index) => (
          <SelectGroup key={group.heading ?? 'devices'}>
            {index > 0 ? <SelectSeparator /> : null}
            {group.heading ? <SelectLabel>{group.heading}</SelectLabel> : null}
            {group.items.map((device) => (
              <SelectItem
                disabled={device.status !== 'available'}
                key={device.id}
                value={device.id}
              >
                <span className="truncate">
                  {device.name}
                  {device.status !== 'available' ? ` (${device.status})` : ''}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
