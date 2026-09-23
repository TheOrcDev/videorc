import {
  type AppIcon,
  CaptionsIcon,
  ChevronDownIcon,
  DisplayIcon,
  MicrophoneIcon,
  RecordIcon,
  SpeakerOffIcon,
  SpeakerOnIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { SourceSelect } from '@/components/source-select'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import { recordingQuality } from '@/lib/studio-session-view'
import type { CaptionsStatus } from '@/lib/backend'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import {
  buildCameraSources,
  buildCaptureSources,
  buildMicrophoneSources,
  capturePickerDevices,
  microphonePickerDevices,
  layoutPresetOrientation,
  resolutionOptionsForOrientation
} from '@/lib/capture'

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

// An inspector value: borderless, right-aligned, and it highlights like a row
// control (plan 050, D4).
const TRIGGER_CLASS =
  'flex h-control w-full min-w-0 items-center justify-end gap-1.5 rounded-chip px-2 text-sm hover:bg-accent data-[state=open]:bg-accent'

/**
 * Inputs (SD2): the Studio inspector's grouped rows mirroring the controls
 * that own their own pages: Source, Mic, Output, Captions. They edit the SAME
 * captureConfig via the shared builders / setters (one state). Device and
 * preset source edits use the shared session controller; mic mute remains
 * live-safe. Scene switching lives in the Scenes gallery, and the live mic VU
 * in the mixer.
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
    selectedMicrophone,
    patchVideo,
    isSessionActive,
    entitlements,
    captionsStatus,
    captionsCommandPending,
    wsStatus
  } = useStudioCore()
  // Q6 (plan 022): before the backend reports devices, selects say "Finding
  // devices…" instead of rendering blank.
  const discoveryPending = wsStatus !== 'connected'
  const captionsGate = cloudAiUploadGate(entitlements)
  const captionsEnabled = captureConfig.captions.enabled

  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const microphones = microphonePickerDevices(deviceList.devices)
  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  const muted = captureConfig.audio.microphoneMuted
  const MuteIcon = muted ? SpeakerOffIcon : SpeakerOnIcon
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

  // F-015: the synthetic diagnostic source replaces the screen — say so
  // instead of claiming "No screen".
  // Q7 (plan 022): the compact trigger lost its distinguishing tail to
  // truncation ("No screen - …"). Name only what IS selected; absence gets one
  // short phrase instead of two "No …" fragments fighting for the width.
  const screenSummary = captureConfig.sources.testPattern
    ? 'Test pattern'
    : selectedCaptureDevice?.name
  const sourceSummary =
    [screenSummary, selectedCamera?.name].filter(Boolean).join(' · ') || 'No sources selected'

  return (
    <PanelSection title="Inputs">
      <GroupedList>
        {/* SOURCE — shared live source controller; full picker on Sources. */}
        <InspectorRow icon={DisplayIcon} label="Source">
          <Popover>
            <PopoverTrigger className={TRIGGER_CLASS} title={sourceSummary}>
              <span className="min-w-0 truncate text-right font-medium">{sourceSummary}</span>
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
              <SourceSelect
                allowNone={allowCaptureNone}
                discoveryPending={discoveryPending}
                devices={captureDevices}
                disabled={Boolean(sourceSwitchReason('capture'))}
                description={<SourceSwitchStatus kind="capture" />}
                selectedName={captureConfig.sources.screenName ?? captureConfig.sources.windowName}
                label="Screen / window"
                value={selectedCaptureId}
                onChange={(captureId) =>
                  void switchSourceDeviceLive(
                    'capture',
                    buildCaptureSources(captureConfig.sources, captureDevices, captureId)
                  )
                }
              />
              <SourceSelect
                allowNone
                discoveryPending={discoveryPending}
                devices={cameras}
                disabled={Boolean(sourceSwitchReason('camera'))}
                description={<SourceSwitchStatus kind="camera" />}
                selectedName={captureConfig.sources.cameraName}
                label="Camera"
                value={captureConfig.sources.cameraId}
                onChange={(cameraId) =>
                  void switchSourceDeviceLive(
                    'camera',
                    buildCameraSources(captureConfig.sources, cameras, cameraId)
                  )
                }
              />
            </PopoverContent>
          </Popover>
        </InspectorRow>

        {/* MIC — confirmed source selection and live mute. */}
        <InspectorRow icon={MicrophoneIcon} label="Mic">
          <Popover>
            <PopoverTrigger className={TRIGGER_CLASS}>
              <span className="min-w-0 truncate text-right font-medium">
                {selectedMicrophone?.name ??
                  captureConfig.sources.microphoneName ??
                  'No microphone'}
              </span>
              {selectedMicrophone && muted ? (
                <SpeakerOffIcon className="size-3.5 shrink-0 text-warning" weight="fill" />
              ) : null}
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
              <SourceSelect
                allowNone
                discoveryPending={discoveryPending}
                devices={microphones}
                disabled={Boolean(sourceSwitchReason('microphone'))}
                description={<SourceSwitchStatus kind="microphone" />}
                selectedName={captureConfig.sources.microphoneName}
                label="Microphone"
                value={captureConfig.sources.microphoneId}
                onChange={(microphoneId) =>
                  void switchSourceDeviceLive(
                    'microphone',
                    buildMicrophoneSources(captureConfig.sources, microphones, microphoneId)
                  )
                }
              />
              {selectedMicrophone || isSessionActive || captureConfig.sources.microphoneId ? (
                <Button
                  aria-pressed={muted}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setCaptureConfig((current) => ({
                      ...current,
                      audio: { ...current.audio, microphoneMuted: !current.audio.microphoneMuted }
                    }))
                  }
                >
                  <MuteIcon
                    className={muted ? 'text-warning' : undefined}
                    data-icon="inline-start"
                  />
                  {muted ? 'Unmute microphone' : 'Mute microphone'}
                </Button>
              ) : null}
            </PopoverContent>
          </Popover>
        </InspectorRow>

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

/** A label on the left, its value control filling the right (the inspector row). */
function InspectorRow({
  icon: RowIcon,
  label,
  children
}: {
  icon: AppIcon
  label: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex min-h-row items-center gap-2.5 py-0.5 pr-1 pl-3" data-slot="inspector-row">
      <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  )
}
