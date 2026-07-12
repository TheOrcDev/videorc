import {
  CaretDown,
  ClosedCaptioning,
  Layout as LayoutIcon,
  Microphone,
  Monitor,
  Record,
  SpeakerHigh,
  SpeakerSlash,
  type Icon
} from '@phosphor-icons/react'
import { Suspense, lazy, type ReactElement, type ReactNode } from 'react'

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
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import { recordingQuality } from '@/lib/studio-session-view'
import type { CaptionsStatus, LayoutPreset } from '@/lib/backend'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import {
  buildCameraSources,
  buildCaptureSources,
  buildMicrophoneSources,
  capturePickerDevices,
  microphonePickerDevices,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation
} from '@/lib/capture'

// Lazy like the tab chunks (app-shell): the preview (and the live-waveform it
// pulls in) loads on first popover open, keeping it out of the eager renderer
// bundle (check:renderer-assets budget).
const MicPickerPreview = lazy(async () => ({
  default: (await import('@/components/studio/mic-picker-preview')).MicPickerPreview
}))

// Mode-scoped like the Scenes gallery: the picker offers only the current
// orientation's scenes (the gallery's header toggle is the one home for
// switching modes — one-home-per-control).
const HORIZONTAL_QUICK_PRESETS: { id: LayoutPreset; label: string }[] = [
  { id: 'screen-camera', label: 'Screen + Cam' },
  { id: 'screen-only', label: 'Screen' },
  { id: 'camera-only', label: 'Camera' },
  { id: 'side-by-side', label: 'Side by side' }
]

const VERTICAL_QUICK_PRESETS: { id: LayoutPreset; label: string }[] = [
  { id: 'vertical-camera-top', label: 'Camera top' },
  { id: 'vertical-camera-bottom', label: 'Camera bottom' },
  { id: 'vertical-split', label: 'Split' },
  { id: 'vertical-screen-camera', label: 'Screen + Cam' },
  { id: 'vertical-screen-only', label: 'Screen' }
]

function presetLabel(preset: LayoutPreset): string {
  return (
    [...HORIZONTAL_QUICK_PRESETS, ...VERTICAL_QUICK_PRESETS].find((entry) => entry.id === preset)
      ?.label ?? preset
  )
}

// Resolution options mirroring the Output tab (recording-tab.tsx); picking one
// patches width/height (the preset becomes Custom), exactly like that tab.
const RESOLUTIONS = [
  { label: '4K', detail: '3840 × 2160', width: 3840, height: 2160 },
  { label: '2K', detail: '2560 × 1440', width: 2560, height: 1440 },
  { label: '1080p', detail: '1920 × 1080', width: 1920, height: 1080 },
  { label: '720p', detail: '1280 × 720', width: 1280, height: 720 },
  { label: 'Vertical', detail: '1080 × 1920', width: 1080, height: 1920 }
]

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
 * their own pages — Source, Mic, Layout, Output. They edit the SAME
 * captureConfig via the shared builders / setters (one state) and deep-link to
 * the full editor. Device + preset edits are off-air (disabled mid-session, as
 * on Sources); the live-safe actions kept from the old session strip are the
 * Layout preset switch and mic mute. The live mic VU lands in SD4's mixer.
 */
export function QuickSettings(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    deviceList,
    selectedCaptureDevice,
    selectedCamera,
    selectedMicrophone,
    applyCameraPreset,
    patchVideo,
    layoutSwitchPending,
    isSessionActive,
    entitlements,
    captionsStatus,
    captionsCommandPending,
    wsStatus
  } = useStudioCore()
  // Q6 (plan 022): before the backend reports devices, selects say "Finding
  // devices…" instead of rendering blank.
  const discoveryPending = wsStatus !== 'connected'
  const { openStudioPanel } = useWorkspaceNav()
  const captionsGate = cloudAiUploadGate(entitlements)
  const captionsEnabled = captureConfig.captions.enabled

  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const microphones = microphonePickerDevices(deviceList.devices)
  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  const hasCamera = Boolean(captureConfig.sources.cameraId)
  const hasScreen = Boolean(selectedCaptureId)
  const muted = captureConfig.audio.microphoneMuted
  const MuteIcon = muted ? SpeakerSlash : SpeakerHigh
  const currentResolution = resolutionKey(captureConfig.video.width, captureConfig.video.height)
  const knownResolution = RESOLUTIONS.some(
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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {/* SOURCE — screen + camera, edited off-air; full picker on Sources. */}
      <QuickCard icon={Monitor} label="Source">
        <Popover>
          <PopoverTrigger className={TRIGGER_CLASS} title={sourceSummary}>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{sourceSummary}</span>
            <CaretDown className="size-3 shrink-0 text-muted-foreground" />
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
            <ManageLink onClick={() => openStudioPanel('sources')}>Manage sources</ManageLink>
          </PopoverContent>
        </Popover>
      </QuickCard>

      {/* MIC — picker off-air; mute is live-safe. */}
      <QuickCard icon={Microphone} label="Mic">
        <Popover>
          <PopoverTrigger className={TRIGGER_CLASS}>
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {selectedMicrophone?.name ?? 'No microphone'}
            </span>
            {selectedMicrophone && muted ? (
              <SpeakerSlash className="size-3.5 shrink-0 text-warning" weight="fill" />
            ) : null}
            <CaretDown className="size-3 shrink-0 text-muted-foreground" />
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
            {/* See-before-you-pick: live waveform of the selected mic while the
                popover is open. Mounted only with the popover, so the preview
                stream releases the device on close. */}
            <Suspense fallback={<div className="h-[38px] rounded-row border bg-muted/20" />}>
              <MicPickerPreview deviceName={selectedMicrophone?.name} />
            </Suspense>
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
            <ManageLink onClick={() => openStudioPanel('sources')}>Audio settings</ManageLink>
          </PopoverContent>
        </Popover>
      </QuickCard>

      {/* LAYOUT — live-safe preset switch (the deliberate two-home control). */}
      <QuickCard icon={LayoutIcon} label="Layout">
        <Popover>
          <PopoverTrigger className={TRIGGER_CLASS}>
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {layoutSwitchPending ? 'Switching…' : presetLabel(captureConfig.layout.layoutPreset)}
            </span>
            <CaretDown className="size-3 shrink-0 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2">
            <div className="grid grid-cols-2 gap-1.5">
              {(layoutPresetOrientation(captureConfig.layout.layoutPreset) === 'vertical'
                ? VERTICAL_QUICK_PRESETS
                : HORIZONTAL_QUICK_PRESETS
              ).map((preset) => (
                <Button
                  key={preset.id}
                  disabled={
                    (layoutPresetNeedsCamera(preset.id) && !hasCamera) ||
                    (layoutPresetNeedsScreen(preset.id) && !hasScreen)
                  }
                  size="sm"
                  variant={
                    captureConfig.layout.layoutPreset === preset.id ? 'secondary' : 'outline'
                  }
                  onClick={() => applyCameraPreset({ layoutPreset: preset.id })}
                >
                  {layoutSwitchPending === preset.id ? 'Switching…' : preset.label}
                </Button>
              ))}
            </div>
            <Separator className="my-2" />
            <ManageLink onClick={() => openStudioPanel('layouts')}>Edit scene</ManageLink>
          </PopoverContent>
        </Popover>
      </QuickCard>

      {/* OUTPUT — recording resolution, mirroring the Output tab's options. */}
      <QuickCard icon={Record} label="Output">
        <Select
          disabled={isSessionActive}
          value={knownResolution ? currentResolution : ''}
          onValueChange={(value) => {
            const match = RESOLUTIONS.find(
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
            {RESOLUTIONS.map((resolution) => (
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
      <QuickCard icon={ClosedCaptioning} label="Captions">
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
        <ManageLink onClick={() => openStudioPanel('captions')}>Manage captions</ManageLink>
      </QuickCard>
    </div>
  )
}

function QuickCard({
  icon: CardIcon,
  label,
  children
}: {
  icon: Icon
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

function ManageLink({
  onClick,
  children
}: {
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <Button className="w-full justify-start" size="sm" variant="ghost" onClick={onClick}>
      {children}
    </Button>
  )
}
