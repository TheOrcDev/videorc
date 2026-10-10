import {
  commitOutputField,
  outputFieldLimits,
  pickRecordingResolution,
  type OutputNumberField
} from '@/lib/output-quality'
import { AlertIcon, SpinnerIcon, VideoFileIcon } from '@/components/icons'
import { useId, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { VideoPresetSelectItems } from '@/components/video-preset-select-items'
import { useStudioCore } from '@/hooks/use-studio'
import type { VideoPreset, VideoSettings } from '@/lib/backend'
import {
  layoutPresetOrientation,
  resolutionOptionsForOrientation,
  videoProfileCompatibility,
  type LayoutOrientation
} from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { performanceCheckLine } from '@/lib/performance-check-line'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'

export function RecordingTab(): ReactElement {
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
    runPerformanceCheck
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

  return (
    <div className="flex flex-col">
      <PanelSection
        action={
          <Switch
            aria-label="Save local recording"
            checked={captureConfig.recordEnabled}
            disabled={isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)}
            onCheckedChange={(checked) =>
              setCaptureConfig((current) => ({ ...current, recordEnabled: checked }))
            }
          />
        }
        description="Local recording exports MP4 into the recordings folder after capture finalizes. Completed files live in the Library."
        icon={VideoFileIcon}
        title="Recording quality"
      >
        {isSessionActive ? (
          <p className="text-sm text-muted-foreground">
            Locked while live. Output settings apply to the next session.
          </p>
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="video-preset">Recording preset</FieldLabel>
            <Select
              disabled={isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)}
              value={video.preset}
              onValueChange={(value) =>
                applyVideoPreset(value as VideoPreset, { kind: 'recording' })
              }
            >
              <SelectTrigger className="w-full" id="video-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <VideoPresetSelectItems
                  entitlements={entitlements}
                  kind="recording"
                  orientation={orientation}
                  performanceResult={performanceCheck?.result}
                />
              </SelectContent>
            </Select>
            <FieldDescription>
              Editing a value below switches the preset to Custom.
            </FieldDescription>
            {checkLine ? (
              <div
                aria-live="polite"
                className={`flex flex-wrap items-center gap-2 text-xs ${
                  checkLine.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'
                }`}
              >
                {checkLine.busy ? <SpinnerIcon className="size-3.5 animate-spin" /> : null}
                <span>{checkLine.text}</span>
                {checkLine.applyPreset ? (
                  <Button
                    disabled={
                      isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
                    }
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
                    disabled={
                      isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
                    }
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
              <Alert variant="warning">
                <AlertIcon />
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span>{profileEntitlementMessage}</span>
                  {!profileGate.allowed && profileGate.upgradeUrl ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openExternalUrl(VIDEORC_PREMIUM_URL)}
                    >
                      View Premium
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {compatibilityMessage ? (
              <Alert variant={compatibility.blockingReason ? 'destructive' : 'warning'}>
                <AlertIcon />
                <AlertDescription>{compatibilityMessage}</AlertDescription>
              </Alert>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Resolution</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {resolutionPresets.map((preset) => (
                <button
                  aria-pressed={video.width === preset.width && video.height === preset.height}
                  className="rounded-row border border-border px-3 py-1.5 text-left text-sm font-medium hover:bg-accent aria-pressed:glass-chip disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
                  }
                  key={preset.label}
                  type="button"
                  onClick={() =>
                    patchVideo(pickRecordingResolution(video, preset.width, preset.height))
                  }
                >
                  <div>{preset.label}</div>
                  <div className="text-xs font-normal text-muted-foreground">{preset.detail}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            {/* Each field commits once, when it is left or Enter is pressed
                (plan 174, D-1); a size that contradicts the scene's
                orientation is refused with the rule, never transposed. */}
            {OUTPUT_NUMBER_FIELDS.map(({ field, label }) => (
              <OutputNumberInput
                disabled={
                  isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
                }
                field={field}
                key={field}
                label={label}
                orientation={orientation}
                video={video}
                onCommit={patchVideo}
              />
            ))}
          </div>
        </FieldGroup>
      </PanelSection>
    </div>
  )
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
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
