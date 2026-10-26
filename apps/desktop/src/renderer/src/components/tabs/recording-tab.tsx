import {
  commitOutputField,
  outputFieldLimits,
  pickRecordingResolution,
  recordingPresetOptions,
  type OutputNumberField
} from '@/lib/output-quality'
import { ClipIcon, FolderIcon, VideoFileIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useState, useSyncExternalStore, type ReactElement } from 'react'

import { findAcceleratorOwner } from '../../../../shared/accelerator'
import { withGlobalShortcut } from '../../../../shared/global-shortcut-bindings'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { globalShortcutLabel, globalShortcutRegistration } from '@/lib/global-shortcuts'
import {
  CLIPS_LABEL,
  KEEP_LAST_SECONDS_LABEL,
  estimatedReplayDiskBytes,
  formatBytes
} from '@/lib/replay-buffer'

import { LockAlert, SessionLockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { EncoderPreferenceField } from '@/components/settings/encoder-preference-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  SettingsRow
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { VideoPresetSelectItems } from '@/components/video-preset-select-items'
import { useStudioCore, useStudioReplay } from '@/hooks/use-studio'
import type { DirectoryFacts, VideoPreset, VideoSettings } from '@/lib/backend'
import {
  REPLAY_RING_SECONDS,
  layoutPresetOrientation,
  resolutionOptionsForOrientation,
  separateSourceRecordingsIneligibility,
  separateSourceRecordingsIneligibilityCopy,
  separateSourceRecordingsSupported,
  videoProfileCompatibility,
  type LayoutOrientation
} from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { formatVideoQuality } from '@/lib/format-video'
import { performanceCheckLine } from '@/lib/performance-check-line'
import { unlockActionForGate } from '@/lib/lock-view'
import { revealInFileManagerLabel } from '@/lib/platform'
import { platformCopy } from '@/lib/platform-copy'
import { recordingsFolderView } from '@/lib/recordings-folder'
import { toastUserError } from '@/lib/user-error'

/** The Save switch's line: what it does, and why the quality fields are off (D-3). */
export const SAVE_RECORDING_ON =
  'Each recording is saved as an MP4 in your recordings folder and listed in Library.'
export const SAVE_RECORDING_OFF =
  'Go Live streams without saving a file. Turn this on to save one and choose its quality.'

/**
 * The Output page (plan 174 S3.6, D5): the one home for the local file. Its
 * quality, then where it goes. Settings has no Recording tab any more.
 */
export function RecordingTab(): ReactElement {
  return (
    <div className="flex flex-col">
      <LocalRecordingSection />
      <ClipsSection />
      <RecordingsFolderSection />
    </div>
  )
}

/** The two clip keys (plan 199 D5): the 30-second clip, then the minute. */
const CLIP_SHORTCUT_ACTIONS = [
  { action: 'clip-mark', key: 'clipMark' },
  { action: 'clip-mark-long', key: 'clipMarkLong' }
] as const

/**
 * Clips (plan 181, the owner's redesign): the one switch that keeps the last
 * minute whenever Videorc is open (R2, on by default; plan 199 fixed the
 * length), what it takes on disk at the current quality, the two clip keys,
 * and where clips go (R4). On a software encoder path the backend keeps the
 * default off and this section says why; the switch still turns it on.
 */
function ClipsSection(): ReactElement {
  const { captureConfig, settings, setSettings, runtimeInfo, recordBlockedReason } = useStudioCore()
  const clips = useStudioReplay()
  const { enabled } = captureConfig.replayBuffer
  const blocked = clips.blockedReason
  const on = enabled && !blocked
  const running = clips.state.state === 'on' || clips.state.state === 'starting'
  // Plan 199 D2: the ring always keeps the minute, so the disk use does too.
  const estimate = formatBytes(
    estimatedReplayDiskBytes(REPLAY_RING_SECONDS, captureConfig.video.bitrateKbps)
  )
  const shortcutRegistration = useSyncExternalStore(
    globalShortcutRegistration.subscribe,
    globalShortcutRegistration.getSnapshot
  )
  return (
    <PanelSection
      description="Videorc keeps the last minute of your screen and microphone while it is open, so one key saves the last 30 seconds or the whole minute as a clip. While you record, the moment is also marked in the recording."
      icon={ClipIcon}
      title={CLIPS_LABEL}
    >
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="output-clips-switch"
          description={
            blocked
              ? `Off on this computer. ${blocked}`
              : !on
                ? 'Off. A clip can only be marked while you record.'
                : running
                  ? 'The newest seconds are on disk, ready to save, and deleted as they age. Nothing is kept for longer.'
                  : recordBlockedReason
                    ? `Starts once a source is ready. ${recordBlockedReason}`
                    : 'Not running right now. It tries again after the next recording or source change.'
          }
          label={KEEP_LAST_SECONDS_LABEL}
        >
          <Switch
            checked={on}
            data-testid="output-clips-enabled"
            onCheckedChange={(checked) => clips.setEnabled(checked)}
          />
        </SettingsRow>
        <SettingsRow
          data-testid="output-clips-disk"
          description={`At ${formatVideoQuality(captureConfig.video)}, however long it runs.`}
          label="Disk use"
        >
          <span className="text-sm tabular-nums text-muted-foreground">about {estimate}</span>
        </SettingsRow>
        {CLIP_SHORTCUT_ACTIONS.map(({ action, key }) => (
          <ShortcutRecorderField
            key={action}
            id={`global-shortcut-${action}`}
            label={globalShortcutLabel(action)}
            platform={runtimeInfo?.platform}
            registrationFailed={shortcutRegistration[action] === false}
            validate={(accelerator) => {
              const owner = findAcceleratorOwner(
                settings.globalShortcuts ?? {},
                accelerator,
                action,
                runtimeInfo?.platform
              )
              return owner ? `Already used by ${globalShortcutLabel(owner)}.` : null
            }}
            value={settings.globalShortcuts?.[key]}
            onChange={(accelerator) =>
              setSettings((current) => ({
                ...current,
                globalShortcuts: withGlobalShortcut(current.globalShortcuts, action, accelerator)
              }))
            }
          />
        ))}
        <SettingsRow
          data-testid="output-clips-folder"
          description="A Clips folder inside your recordings folder. Every clip is listed in Library."
          label="Where clips go"
        />
      </FieldGroup>
    </PanelSection>
  )
}

function LocalRecordingSection(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    patchVideo,
    applyVideoPreset,
    isSessionActive,
    goLiveConfirmationPending,
    goLivePartialSetup,
    entitlements,
    performanceCheck,
    performanceCheckProgress,
    runPerformanceCheck,
    encoderPreference,
    setEncoderPreference,
    runtimeInfo
  } = useStudioCore()
  const { video } = captureConfig
  // One-click resolutions so nobody has to remember pixel counts; picking one
  // changes dimensions and standard bitrates while preserving custom rates. The list follows
  // the Studio mode — vertical mode offers only portrait canvases, so the
  // canvas can never contradict the scene's orientation.
  const orientation = layoutPresetOrientation(captureConfig.layout.layoutPreset)
  const resolutionPresets = resolutionOptionsForOrientation(orientation)
  const compatibility = videoProfileCompatibility(captureConfig)
  const compatibilityMessage = compatibility.blockingReason ?? compatibility.warning
  // Plan 157: the switch stays available; when the current selection cannot
  // produce both files the copy says so and the session records Combined only.
  // Release test 146, plan 0001: only macOS can write the Screen and Camera
  // files, so elsewhere the switch is off, locked and says why.
  const separateUnsupported = !separateSourceRecordingsSupported(runtimeInfo?.platform)
  const separateIneligibility = separateUnsupported
    ? 'unsupported-platform'
    : captureConfig.separateSourceRecordings.enabled
      ? separateSourceRecordingsIneligibility(captureConfig, runtimeInfo?.platform)
      : null
  const profileGate = videoProfileEntitlementGate({ entitlements, kind: 'recording', video })
  const profileEntitlementMessage = profileGate.allowed ? null : profileGate.reason
  const checkLine = performanceCheckLine({
    state: performanceCheck,
    progress: performanceCheckProgress,
    video
  })
  const sessionLocked = isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
  // Off means stream-only: the quality is the file's, so it waits for the
  // switch, and the switch's own line says so (D-3).
  const qualityLocked = sessionLocked || !captureConfig.recordEnabled

  return (
    <PanelSection
      description="Videorc saves each recording as an MP4. Finished recordings are in Library."
      icon={VideoFileIcon}
      title="Local recording"
    >
      {isSessionActive ? <SessionLockAlert /> : null}
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="output-save-recording"
          description={captureConfig.recordEnabled ? SAVE_RECORDING_ON : SAVE_RECORDING_OFF}
          label="Save a local recording"
        >
          <Switch
            checked={captureConfig.recordEnabled}
            disabled={sessionLocked}
            onCheckedChange={(checked) =>
              setCaptureConfig((current) => ({ ...current, recordEnabled: checked }))
            }
          />
        </SettingsRow>
        {/* Plan 157: a Screen file and a Camera file beside the Combined one.
            The switch stays available; when the current selection cannot
            produce both files the row says why and the session records
            Combined only. It is a property of the saved file, so it waits
            for the Save switch like the quality fields (D-3). */}
        <SettingsRow
          data-testid="output-separate-source-recordings"
          description={
            <>
              <span className="block">
                Also saves a Screen file with the system audio track at this recording size, and a
                Camera file with the microphone track at the camera&apos;s own size, beside the
                Combined recording. A source that is off records as silence. Streams and preview
                stay composed.
              </span>
              {separateIneligibility ? (
                // The tone rides on the icon; the words stay monochrome (plan 174 S1.8).
                <span className="mt-1 flex items-center gap-1.5 text-foreground">
                  <WarningIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-warning"
                    weight="fill"
                  />
                  {separateSourceRecordingsIneligibilityCopy(separateIneligibility)}
                </span>
              ) : null}
            </>
          }
          label="Separate source recordings"
        >
          <Switch
            checked={!separateUnsupported && captureConfig.separateSourceRecordings.enabled}
            disabled={qualityLocked || separateUnsupported}
            id="separate-source-recordings"
            onCheckedChange={(checked) =>
              setCaptureConfig((current) => ({
                ...current,
                separateSourceRecordings: {
                  ...current.separateSourceRecordings,
                  enabled: checked
                }
              }))
            }
          />
        </SettingsRow>
      </FieldGroup>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="video-preset">Recording preset</FieldLabel>
          <Select
            disabled={qualityLocked}
            value={video.preset}
            onValueChange={(value) => applyVideoPreset(value as VideoPreset, { kind: 'recording' })}
          >
            <SelectTrigger className="w-full" id="video-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <VideoPresetSelectItems
                entitlements={entitlements}
                kind="recording"
                options={recordingPresetOptions(video.preset, orientation)}
                performanceResult={performanceCheck?.result}
              />
            </SelectContent>
          </Select>
          <FieldDescription>Editing a value below switches the preset to Custom.</FieldDescription>
          {checkLine ? (
            <div
              aria-live="polite"
              className={`flex flex-wrap items-center gap-2 text-xs ${
                checkLine.tone === 'warning' ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {checkLine.busy ? <Spinner aria-hidden className="size-3.5" /> : null}
              {/* The tone rides on the icon; the words stay monochrome (plan 174 S1.8). */}
              {checkLine.tone === 'warning' && !checkLine.busy ? (
                <WarningIcon aria-hidden className="size-3.5 shrink-0 text-warning" weight="fill" />
              ) : null}
              <span>{checkLine.text}</span>
              {checkLine.applyPreset ? (
                <Button
                  disabled={qualityLocked}
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    checkLine.applyPreset &&
                    applyVideoPreset(checkLine.applyPreset, { kind: 'recording' })
                  }
                >
                  {checkLine.applyLabel}
                </Button>
              ) : null}
              {checkLine.checkLabel ? (
                <Button
                  disabled={sessionLocked}
                  size="xs"
                  variant="ghost"
                  onClick={() => void runPerformanceCheck()}
                >
                  {checkLine.checkLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
          {profileEntitlementMessage ? (
            <LockAlert
              action={unlockActionForGate(profileGate)}
              reason={profileEntitlementMessage}
            />
          ) : null}
          {compatibilityMessage ? (
            <Alert variant={compatibility.blockingReason ? 'destructive' : 'warning'}>
              <AlertDescription>{compatibilityMessage}</AlertDescription>
            </Alert>
          ) : null}
        </Field>

        <Field>
          <FieldLabel>Resolution</FieldLabel>
          <SegmentedControl
            disabled={qualityLocked}
            options={resolutionPresets.map((preset) => ({
              value: preset.label,
              label: preset.label,
              'aria-label': `${preset.label} (${preset.detail})`
            }))}
            value={
              resolutionPresets.find(
                (preset) => video.width === preset.width && video.height === preset.height
              )?.label ?? null
            }
            onValueChange={(label) => {
              const preset = resolutionPresets.find((candidate) => candidate.label === label)
              if (preset) patchVideo(pickRecordingResolution(video, preset.width, preset.height))
            }}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          {/* Each field commits once, when it is left or Enter is pressed
              (plan 174, D-1); a size that contradicts the scene's
              orientation is refused with the rule, never transposed. */}
          {OUTPUT_NUMBER_FIELDS.map(({ field, label }) => (
            <OutputNumberInput
              disabled={qualityLocked}
              field={field}
              key={field}
              label={label}
              orientation={orientation}
              video={video}
              onCommit={patchVideo}
            />
          ))}
        </div>
        {/* Windows PCs with Intel graphics only (plan 090 C5); it was in
            Settings → Recording until plan 174 S3.6. */}
        <EncoderPreferenceField
          state={encoderPreference}
          onChange={(preference) => {
            void setEncoderPreference(preference).catch((error: unknown) => {
              toastUserError(
                error,
                { action: 'change', object: 'the backup encoder' },
                { id: 'encoder-preference' }
              )
            })
          }}
        />
      </FieldGroup>
    </PanelSection>
  )
}

/**
 * Where recordings go (plan 174 S3.6, D5): the folder as words with Choose…,
 * Show in Finder and Use default (I-22, I-23), and Keep original recording.
 */
function RecordingsFolderSection(): ReactElement {
  const { settings, setSettings, runtimeInfo } = useStudioCore()
  const platform = runtimeInfo?.platform
  const handle = settings.outputDirectoryHandle
  // A typo here used to fail silently at record time, so the chosen folder
  // is checked as it changes.
  const [facts, setFacts] = useState<{ handle: string; facts: DirectoryFacts } | null>(null)
  useEffect(() => {
    if (!handle || !window.videorc?.checkDirectory) return
    let cancelled = false
    const timer = setTimeout(() => {
      void window.videorc
        ?.checkDirectory?.(handle)
        .then((next) => {
          if (!cancelled) setFacts({ handle, facts: next })
        })
        .catch(() => {})
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [handle])
  const folder = recordingsFolderView({
    displayName: settings.outputDirectory,
    handle,
    facts: facts && facts.handle === handle ? facts.facts : null,
    defaultPath: platformCopy(platform).defaultRecordingsPath
  })

  const chooseFolder = async (): Promise<void> => {
    const selection = await window.videorc?.pickDirectory?.()
    if (selection) {
      setSettings((current) => ({
        ...current,
        outputDirectory: selection.displayName,
        outputDirectoryHandle: selection.directoryHandleId
      }))
    }
  }

  return (
    <PanelSection
      description="The folder each recording is saved to, and what Videorc keeps there."
      title="Where recordings go"
    >
      <FieldGroup variant="grouped">
        <SettingsRow
          aria-label="Recordings folder"
          data-testid="recordings-folder"
          description={
            <>
              <span className="block truncate select-text">{folder.path}</span>
              {folder.detail ? <span className="block">{folder.detail}</span> : null}
            </>
          }
          error={folder.problem}
          label="Recordings folder"
        >
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => void chooseFolder()}>
              <FolderIcon data-icon="inline-start" />
              Choose…
            </Button>
            {folder.canReveal ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (handle) void window.videorc?.revealSelectedResource?.(handle)
                }}
              >
                {revealInFileManagerLabel(platform)}
              </Button>
            ) : null}
            {folder.custom ? (
              <Button
                variant="ghost"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    outputDirectory: '',
                    outputDirectoryHandle: undefined
                  }))
                }
              >
                Use default
              </Button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          description="Also keeps the capture MKV, with lossless audio, beside the MP4. Uses more disk space."
          label="Keep original recording"
        >
          <Switch
            checked={settings.keepOriginalRecording}
            onCheckedChange={(checked) =>
              setSettings((current) => ({ ...current, keepOriginalRecording: checked }))
            }
          />
        </SettingsRow>
      </FieldGroup>
    </PanelSection>
  )
}

const OUTPUT_NUMBER_FIELDS: { field: OutputNumberField; label: string }[] = [
  { field: 'width', label: 'Width' },
  { field: 'height', label: 'Height' },
  { field: 'fps', label: 'FPS' },
  { field: 'bitrateKbps', label: 'Bitrate kbps' }
]

/**
 * One typed Output value. Typing edits a local draft only; leaving the field
 * or pressing Enter commits it once through `commitOutputField`, and Escape
 * puts the setting back. A refused size keeps the setting and says why under
 * the field.
 */
function OutputNumberInput({
  field,
  label,
  video,
  orientation,
  disabled,
  onCommit
}: {
  field: OutputNumberField
  label: string
  video: VideoSettings
  orientation: LayoutOrientation
  disabled?: boolean
  onCommit: (patch: Partial<VideoSettings>) => void
}): ReactElement {
  const id = useId()
  const errorId = `${id}-error`
  const [draft, setDraft] = useState<string | null>(null)
  // A refusal belongs to the canvas it was refused against: once the size
  // changes some other way (a resolution button), it no longer applies.
  const canvas = `${video.width}x${video.height}`
  const [refused, setRefused] = useState<{ message: string; canvas: string } | null>(null)
  const refusal = refused?.canvas === canvas ? refused.message : null
  const { min, max, step } = outputFieldLimits(field, orientation)

  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    if (disabled) return
    const result = commitOutputField(video, field, draft, orientation)
    setRefused(result.kind === 'refused' ? { message: result.message, canvas } : null)
    if (result.kind === 'commit') onCommit(result.patch)
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        aria-describedby={refusal ? errorId : undefined}
        aria-invalid={refusal ? true : undefined}
        disabled={disabled}
        id={id}
        inputMode="numeric"
        max={max}
        min={min}
        step={step}
        type="number"
        value={draft ?? String(video[field])}
        onBlur={commit}
        onChange={(event) => {
          setDraft(event.target.value)
          setRefused(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault()
            setDraft(null)
            setRefused(null)
          }
        }}
      />
      {refusal ? <FieldError id={errorId}>{refusal}</FieldError> : null}
    </Field>
  )
}
