import {
  ArrowClockwise,
  ArrowSquareOut,
  ClosedCaptioning,
  Microphone,
  WarningCircle
} from '@phosphor-icons/react'
import type { ReactElement } from 'react'
import { toast } from 'sonner'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import type { CaptionStyleId, CaptionsStatus } from '@/lib/backend'
import {
  CAPTION_STYLE_IDS,
  captionStyleDefinition,
  type CaptionPosition,
  type CaptionTextSize
} from '@/lib/caption-overlay'
import {
  captionStripLines,
  captionsStatusIsActive,
  latestFinalCaptionText
} from '@/lib/captions-ui'
import type { CaptionBurnTarget, CaptionsCaptureSettings } from '@/lib/capture'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import { displayKeyGlyph } from '@/lib/platform'
import { cn } from '@/lib/utils'

const LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'it', label: 'Italian' }
] as const

type CaptionStatusPresentation = {
  value: string
  tone: StatusTone
  detail: string
}

function captionsStatusPresentation(
  status: CaptionsStatus,
  enabled: boolean,
  sessionActive: boolean
): CaptionStatusPresentation {
  if (!enabled) {
    return { value: 'Off', tone: 'neutral', detail: 'Enable captions to arm them for a session.' }
  }
  switch (status.state) {
    case 'starting':
      return { value: 'Starting', tone: 'neutral', detail: 'Connecting to transcription…' }
    case 'listening':
    case 'live':
      return { value: 'Listening', tone: 'good', detail: 'Microphone speech is being transcribed.' }
    case 'reconnecting':
      return { value: 'Reconnecting', tone: 'warn', detail: 'Trying to restore live captions.' }
    case 'degraded':
      return {
        value: 'Higher delay',
        tone: 'warn',
        detail: status.message ?? 'Captions are continuing with a longer delay.'
      }
    case 'blocked':
      return {
        value: 'Blocked',
        tone: 'error',
        detail: status.message ?? 'Captions need attention before they can start.'
      }
    case 'error':
      return {
        value: 'Error',
        tone: 'error',
        detail: status.message ?? 'Captions stopped unexpectedly.'
      }
    case 'ready':
      return {
        value: 'Ready',
        tone: 'good',
        detail: sessionActive
          ? 'Ready to listen for microphone speech.'
          : 'Starts with your next session.'
      }
    default:
      return {
        value: sessionActive ? 'Waiting' : 'Armed',
        tone: 'neutral',
        detail: sessionActive
          ? 'Waiting for the caption service.'
          : 'Starts with your next session.'
      }
  }
}

function burnTargetFromChecks(stream: boolean, recording: boolean): CaptionBurnTarget {
  if (stream && recording) return 'both'
  if (stream) return 'stream'
  if (recording) return 'recording'
  return 'off'
}

function StyleSwatch({ styleId }: { styleId: CaptionStyleId }): ReactElement {
  const style = captionStyleDefinition(styleId)
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex h-12 w-full items-end overflow-hidden rounded-lg bg-gradient-to-br from-slate-500 via-slate-700 to-slate-950 p-2',
        style.align === 'center' ? 'justify-center' : 'justify-start'
      )}
    >
      <span
        className={cn(
          'line-clamp-1 max-w-full px-2 py-1 text-[8px] leading-none tracking-tight text-white',
          style.fontWeight === 700 ? 'font-bold' : 'font-semibold',
          style.plate === 'none' && '[text-shadow:0_1px_2px_rgb(0_0_0),0_0_1px_rgb(0_0_0)]',
          style.plate === 'glass' && 'rounded-md border border-white/10 bg-black/70 shadow-lg',
          style.plate === 'band' && 'w-full rounded-sm bg-black/85 text-left',
          style.plate === 'solid' && 'rounded-sm bg-black'
        )}
      >
        Make every word count
      </span>
    </span>
  )
}

function OutputCheckbox({
  id,
  checked,
  disabled,
  title,
  description,
  onCheckedChange
}: {
  id: string
  checked: boolean
  disabled: boolean
  title: string
  description: string
  onCheckedChange: (checked: boolean) => void
}): ReactElement {
  return (
    <Field data-disabled={disabled || undefined} orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>{title}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
    </Field>
  )
}

export function CaptionsControls(): ReactElement {
  const {
    aiQuota,
    captionLines,
    captionsCommandPending,
    captionsStatus,
    captionsWindow,
    captureConfig,
    entitlements,
    isSessionActive,
    runtimeInfo,
    setCaptureConfig,
    startCaptions,
    toggleCaptionsWindow
  } = useStudioCore()
  const captions = captureConfig.captions
  const gate = cloudAiUploadGate(entitlements)
  const runtimeActive = captionsStatusIsActive(captionsStatus)
  const status = captionsStatusPresentation(captionsStatus, captions.enabled, isSessionActive)
  const lines = captionStripLines(captionLines)
  const finalAnnouncement = latestFinalCaptionText(captionLines)
  const streamChecked = captions.burnTarget === 'stream' || captions.burnTarget === 'both'
  const recordingChecked = captions.burnTarget === 'recording' || captions.burnTarget === 'both'
  const canEnable = gate.allowed || captions.enabled
  const showRetry =
    captions.enabled &&
    isSessionActive &&
    (captionsStatus.state === 'blocked' || captionsStatus.state === 'error')
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  const patchCaptions = (
    patch: Partial<CaptionsCaptureSettings>,
    bumpStyleRevision = false
  ): void => {
    setCaptureConfig((current) => {
      const changed = Object.entries(patch).some(
        ([key, value]) => current.captions[key as keyof CaptionsCaptureSettings] !== value
      )
      if (!changed) return current
      return {
        ...current,
        captions: {
          ...current.captions,
          ...patch,
          styleRevision: bumpStyleRevision
            ? current.captions.styleRevision + 1
            : current.captions.styleRevision
        }
      }
    })
  }

  const retry = (): void => {
    void startCaptions(captions.language).catch((error: unknown) => {
      toast.error('Live captions could not start', {
        description: error instanceof Error ? error.message : 'The caption service is unavailable.'
      })
    })
  }

  return (
    <PanelSection
      action={<StatusBadge tone={status.tone} value={status.value} />}
      description="Transcribe your microphone during a recording or livestream."
      icon={ClosedCaptioning}
      title="Live captions"
    >
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Enable live captions</FieldTitle>
            <FieldDescription>
              Starts automatically with your next session. Turn this off at any time to stop audio
              upload.
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-label="Enable live captions"
            checked={captions.enabled}
            disabled={captionsCommandPending || !canEnable}
            onCheckedChange={(enabled) => patchCaptions({ enabled })}
          />
        </Field>

        {!gate.allowed ? (
          <Alert variant="warning">
            <WarningCircle weight="fill" />
            <AlertTitle>Premium captions</AlertTitle>
            <AlertDescription>
              {gate.reason}
              {gate.upgradeUrl ? (
                <Button
                  className="ml-2 h-auto p-0 align-baseline"
                  size="xs"
                  variant="link"
                  onClick={() => openExternalUrl(gate.upgradeUrl as string)}
                >
                  View Premium
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 rounded-row border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Microphone className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
              <span className="font-medium">Microphone</span>
              <span className="text-muted-foreground">
                · {captionsStatus.transport === 'realtime' ? 'Realtime' : 'Live transcription'}
              </span>
            </div>
            {typeof (captionsStatus.remainingSeconds ?? aiQuota?.monthly.remaining) === 'number' ? (
              <span className="text-xs text-muted-foreground">
                {captionsStatus.remainingSeconds !== undefined
                  ? `${Math.max(0, Math.ceil(captionsStatus.remainingSeconds / 60))} min left`
                  : `${aiQuota?.monthly.remaining ?? 0} credits left`}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{status.detail}</p>
            {showRetry ? (
              <Button disabled={captionsCommandPending} size="xs" variant="outline" onClick={retry}>
                <ArrowClockwise data-icon="inline-start" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>

        <Field>
          <FieldContent>
            <FieldTitle>Style</FieldTitle>
            <FieldDescription>
              Appearance updates live without restarting captions.
            </FieldDescription>
          </FieldContent>
          <ToggleGroup
            aria-label="Caption style"
            className="grid w-full grid-cols-2 gap-2"
            type="single"
            value={captions.styleId}
            variant="outline"
            onValueChange={(value) => {
              if (CAPTION_STYLE_IDS.includes(value as CaptionStyleId)) {
                patchCaptions({ styleId: value as CaptionStyleId }, true)
              }
            }}
          >
            {CAPTION_STYLE_IDS.map((styleId) => {
              const definition = captionStyleDefinition(styleId)
              return (
                <ToggleGroupItem
                  aria-label={definition.label}
                  className="h-auto min-w-0 flex-col items-stretch gap-2 overflow-hidden rounded-row p-2 text-left whitespace-normal data-[state=on]:border-primary/50 data-[state=on]:bg-primary/10"
                  key={styleId}
                  value={styleId}
                >
                  <StyleSwatch styleId={styleId} />
                  <span className="min-w-0 whitespace-normal">
                    <span className="block text-xs font-medium">{definition.label}</span>
                    <span className="mt-0.5 block break-words text-[11px] leading-snug whitespace-normal text-muted-foreground">
                      {definition.description}
                    </span>
                  </span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Position</FieldLabel>
            <ToggleGroup
              aria-label="Caption position"
              className="w-full"
              type="single"
              value={captions.position}
              variant="outline"
              onValueChange={(value) => {
                if (value === 'top' || value === 'bottom') {
                  patchCaptions({ position: value as CaptionPosition }, true)
                }
              }}
            >
              <ToggleGroupItem className="flex-1" value="bottom">
                Bottom
              </ToggleGroupItem>
              <ToggleGroupItem className="flex-1" value="top">
                Top
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>Text size</FieldLabel>
            <ToggleGroup
              aria-label="Caption text size"
              className="w-full"
              type="single"
              value={captions.textSize}
              variant="outline"
              onValueChange={(value) => {
                if (value === 's' || value === 'm' || value === 'l') {
                  patchCaptions({ textSize: value as CaptionTextSize }, true)
                }
              }}
            >
              <ToggleGroupItem className="flex-1" value="s">
                Small
              </ToggleGroupItem>
              <ToggleGroupItem className="flex-1" value="m">
                Medium
              </ToggleGroupItem>
              <ToggleGroupItem className="flex-1" value="l">
                Large
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>

        <Field>
          <FieldContent>
            <FieldLabel htmlFor="caption-language">Spoken language</FieldLabel>
            <FieldDescription>
              {isSessionActive
                ? 'Language is locked until the next session.'
                : 'Auto-detect works for most conversations.'}
            </FieldDescription>
          </FieldContent>
          <Select
            disabled={isSessionActive}
            value={captions.language}
            onValueChange={(language) => patchCaptions({ language })}
          >
            <SelectTrigger className="w-full" id="caption-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LANGUAGES.map((language) => (
                  <SelectItem key={language.id} value={language.id}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldContent>
            <FieldTitle>Show captions in</FieldTitle>
            <FieldDescription>
              {isSessionActive
                ? 'Output routing is locked until the next session.'
                : 'Choose livestream burn-in and whether to create a captioned recording copy.'}
            </FieldDescription>
          </FieldContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <OutputCheckbox
              checked={streamChecked}
              description="Visible to livestream viewers."
              disabled={isSessionActive}
              id="captions-output-stream"
              title="Livestream"
              onCheckedChange={(checked) =>
                patchCaptions({ burnTarget: burnTargetFromChecks(checked, recordingChecked) })
              }
            />
            <OutputCheckbox
              checked={recordingChecked}
              description="Visible in the captioned recording copy."
              disabled={isSessionActive}
              id="captions-output-recording"
              title="Recording"
              onCheckedChange={(checked) =>
                patchCaptions({ burnTarget: burnTargetFromChecks(streamChecked, checked) })
              }
            />
          </div>
        </Field>

        {(runtimeActive || lines.length > 0) && (
          <div className="flex min-h-16 flex-col justify-end gap-1.5 rounded-row border border-border bg-muted/15 p-3">
            {lines.length === 0 ? (
              <span className="text-sm text-muted-foreground">Listening…</span>
            ) : (
              lines.map((line) => (
                <p
                  className={cn(
                    'text-sm leading-6',
                    line.kind === 'partial' ? 'text-muted-foreground' : 'text-foreground'
                  )}
                  key={`${line.sessionClientId}-${line.seq}`}
                >
                  {line.text}
                </p>
              ))
            )}
          </div>
        )}
        <span aria-live="polite" className="sr-only">
          {finalAnnouncement}
        </span>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="max-w-md text-xs text-muted-foreground">
            While enabled, microphone audio is sent to Videorc’s transcription provider only during
            an active session.
          </p>
          <Button
            disabled={!captionsWindow.enabled && !captionsWindow.open}
            size="sm"
            variant="outline"
            onClick={() => void toggleCaptionsWindow()}
          >
            <ArrowSquareOut data-icon="inline-start" />
            {captionsWindow.open ? 'Close reader' : 'Open reader'}
            <KbdGroup className="ml-1">
              <Kbd>{modKey}</Kbd>
              <Kbd>{shiftKey}</Kbd>
              <Kbd>C</Kbd>
            </KbdGroup>
          </Button>
        </div>
      </FieldGroup>
    </PanelSection>
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
