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

const TRIGGER_CLASS =
  'flex w-full items-center gap-2 rounded-row border bg-background px-2.5 py-1.5 text-sm transition-colors hover:bg-accent data-[state=open]:bg-accent'

/**
 * Quick Settings (SD2): four compact cards mirroring the controls that own
 * their own pages: Source, Mic, Output, Captions. They edit the SAME
 * captureConfig via the shared builders / setters (one state). Device + preset
 * edits are off-air (disabled mid-session, as on Sources); mic mute is the
 * live-safe action. Scene switching lives in the Scenes gallery below, and the
 * live mic VU in the mixer.
 */
export function QuickSettings(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* SOURCE — screen + camera, edited off-air; full picker on Sources. */}
      <QuickCard icon={DisplayIcon} label="Source">
        <Popover>
          <PopoverTrigger className={TRIGGER_CLASS} title={sourceSummary}>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{sourceSummary}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
            <SourceSelect
              allowNone
              discoveryPending={discoveryPending}
              devices={captureDevices}
              disabled={isSessionActive}
              label="Screen / window"
              value={selectedCaptureId}
              onChange={(captureId) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: buildCaptureSources(current.sources, captureDevices, captureId)
                }))
              }
            />
            <SourceSelect
              allowNone
              discoveryPending={discoveryPending}
              devices={cameras}
              disabled={isSessionActive}
              label="Camera"
              value={captureConfig.sources.cameraId}
              onChange={(cameraId) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: buildCameraSources(current.sources, cameras, cameraId)
                }))
              }
            />
          </PopoverContent>
        </Popover>
      </QuickCard>

      {/* MIC — picker off-air; mute is live-safe. */}
      <QuickCard icon={MicrophoneIcon} label="Mic">
        <Popover>
          <PopoverTrigger className={TRIGGER_CLASS}>
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {selectedMicrophone?.name ?? 'No microphone'}
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
              disabled={isSessionActive}
              label="Microphone"
              value={captureConfig.sources.microphoneId}
              onChange={(microphoneId) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: buildMicrophoneSources(current.sources, microphones, microphoneId)
                }))
              }
            />
            {selectedMicrophone ? (
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
                <MuteIcon className={muted ? 'text-warning' : undefined} data-icon="inline-start" />
                {muted ? 'Unmute microphone' : 'Mute microphone'}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
      </QuickCard>

      {/* OUTPUT — recording resolution, mirroring the Output tab's options. */}
      <QuickCard icon={RecordIcon} label="Output">
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
          <SelectTrigger className="w-full rounded-row border-border bg-background hover:bg-accent data-[state=open]:bg-accent">
            {/* Q7 (plan 022): the compact trigger shows the short canonical
                form ("2K · 1440p30"); the full dimensions live in the items. */}
            <SelectValue placeholder="Custom">{recordingQuality(captureConfig.video)}</SelectValue>
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
      </QuickCard>

      {/* CAPTIONS — live-safe premium toggle mirroring the Streaming tab's
          Live captions section (the config home, incl. the consent copy). */}
      <QuickCard icon={CaptionsIcon} label="Captions">
        <div className="flex items-center justify-between gap-2 rounded-row border bg-background px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
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
      </QuickCard>
    </div>
  )
}

function QuickCard({
  icon: CardIcon,
  label,
  children
}: {
  icon: AppIcon
  label: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-row bg-muted/30 p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CardIcon className="size-3.5 shrink-0" weight="duotone" />
        {label}
      </span>
      {children}
    </div>
  )
}
