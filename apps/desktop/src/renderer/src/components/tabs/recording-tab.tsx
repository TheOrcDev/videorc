import {
  commitOutputField,
  outputFieldLimits,
  pickRecordingResolution,
  recordingPresetOptions,
  type OutputNumberField
} from '@/lib/output-quality'
import { FolderIcon, VideoFileIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useState, type ReactElement } from 'react'

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
import { useStudioCore } from '@/hooks/use-studio'
import type { DirectoryFacts, VideoPreset, VideoSettings } from '@/lib/backend'
import {
  layoutPresetOrientation,
  resolutionOptionsForOrientation,
  videoProfileCompatibility,
  type LayoutOrientation
} from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
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
      <RecordingsFolderSection />
    </div>
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
    setEncoderPreference
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
            <Button size="sm" variant="outline" onClick={() => void chooseFolder()}>
              <FolderIcon data-icon="inline-start" />
              Choose…
            </Button>
            {folder.canReveal ? (
              <Button
                size="sm"
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
                size="sm"
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
