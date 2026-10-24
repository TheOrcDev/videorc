import {
  CaptionsIcon,
  ExternalLinkIcon,
  SceneIcon,
  MicrophoneIcon,
  RefreshIcon
} from '@/components/icons'
import type { ReactElement } from 'react'
import { toastUserError } from '@/lib/user-error'

import { GroupedList } from '@/components/list-row'
import { LockAlert } from '@/components/lock-alert'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
  SettingsRow
} from '@/components/ui/field'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCaptions, useStudioCore } from '@/hooks/use-studio'
import type { CaptionStyleId } from '@/lib/backend'
import {
  CAPTION_STYLE_IDS,
  captionStyleDefinition,
  type CaptionTextSize
} from '@/lib/caption-overlay'
import {
  captionStripLines,
  captionsStatusIsActive,
  latestFinalCaptionText
} from '@/lib/captions-ui'
import {
  CAPTIONS_OFF_HINT,
  captionsAllowanceLabel,
  captionsPlacementSummary,
  captionsStatusDetail
} from '@/lib/captions-page-view'
import {
  CAPTIONS_LINUX_DETAIL,
  CAPTIONS_LINUX_TITLE,
  captionsPlatformUnavailableReason,
  livestreamCaptionsBlockerFor
} from '@/lib/captions-preflight'
import {
  layoutPresetOrientation,
  simulcastArmed,
  type CaptionsCaptureSettings
} from '@/lib/capture'
import { cloudAiUploadGate } from '@/lib/entitlement-ui'
import { SESSION_LOCK_REASON, unlockActionForGate } from '@/lib/lock-view'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { captionsStatusLabel, captionsStatusTone } from '@/lib/state-labels'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { WINDOW_NAMES } from '../../../../shared/window-names'

const LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'it', label: 'Italian' }
] as const

const CAPTION_TEXT_SIZE_OPTIONS: SegmentedControlOption<CaptionTextSize>[] = [
  { value: 's', label: 'Small' },
  { value: 'm', label: 'Medium' },
  { value: 'l', label: 'Large' }
]

function StyleSwatch({ styleId }: { styleId: CaptionStyleId }): ReactElement {
  const style = captionStyleDefinition(styleId)
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex h-12 w-full items-end overflow-hidden rounded-chip bg-video-ground p-2',
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

export function CaptionsControls(): ReactElement {
  const {
    captionsCommandPending,
    captionsStatus,
    captionsWindow,
    captureConfig,
    entitlements,
    isSessionActive,
    overlayLayout,
    runtimeInfo,
    selectedMicrophone,
    setCaptureConfig,
    startCaptions,
    toggleCaptionsWindow
  } = useStudioCore()
  const { captionLines } = useStudioCaptions()
  const captions = captureConfig.captions
  const gate = cloudAiUploadGate(entitlements)
  // Locked means disabled, with one reason (S1.5): the lock leads and every
  // control under it is off. A streamer who already has captions on may still
  // turn them off.
  const locked = !gate.allowed
  const runtimeActive = captionsStatusIsActive(captionsStatus)
  const statusOptions = { enabled: captions.enabled, sessionActive: isSessionActive }
  const allowance = captionsAllowanceLabel(captionsStatus.remainingSeconds)
  // Captions hear the Sources microphone; "Off" when none is chosen.
  const microphoneName = captureConfig.sources.microphoneId
    ? (selectedMicrophone?.name ?? captureConfig.sources.microphoneName ?? 'Not connected')
    : 'Off'
  const lines = captionStripLines(captionLines)
  const finalAnnouncement = latestFinalCaptionText(captionLines)
  // A vertical destination shares the recording's picture with the
  // horizontal stream, so livestream captions land in the recording too.
  const verticalLegArmed = simulcastArmed(captureConfig)
  // The rule a livestream would break today, said here before Go Live does
  // (plan 174 S3.4, D-9).
  // Linux can't caption at all yet: one reason, and nothing to turn on.
  const platformUnavailable = captionsPlatformUnavailableReason(runtimeInfo?.platform)
  const livestreamBlocker =
    captions.enabled && !platformUnavailable ? livestreamCaptionsBlockerFor(captureConfig) : null
  const canEnable = (gate.allowed && !platformUnavailable) || captions.enabled
  const showRetry =
    captions.enabled &&
    isSessionActive &&
    (captionsStatus.state === 'blocked' || captionsStatus.state === 'error')

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
      toastUserError(
        error,
        { action: 'start', object: 'live captions' },
        { id: 'captions-start', action: { label: 'Retry', onClick: retry } }
      )
    })
  }

  return (
    <PanelSection
      description="Transcribe your microphone during a recording or livestream. On a livestream, captions need 30 fps or less, and one stream quality when you also record."
      icon={CaptionsIcon}
      title="Live captions"
    >
      <FieldGroup>
        {/* Locked means disabled with one reason, and the lock leads (S1.5). */}
        {locked ? <LockAlert action={unlockActionForGate(gate)} reason={gate.reason} /> : null}
        {/* One state signal (V-5): the switch says on or off; while on, one
            dot names what captions are doing, with its line. */}
        <FieldGroup variant="grouped">
          <SettingsRow
            data-testid="captions-enabled-row"
            description={
              captions.enabled ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <StatusDot
                    label={captionsStatusLabel(captionsStatus, statusOptions)}
                    tone={captionsStatusTone(captionsStatus, statusOptions)}
                  />
                  <span>{captionsStatusDetail(captionsStatus, isSessionActive)}</span>
                </span>
              ) : (
                CAPTIONS_OFF_HINT
              )
            }
            label="Live captions"
          >
            <div className="flex shrink-0 items-center gap-2">
              {showRetry ? (
                <Button
                  disabled={captionsCommandPending}
                  size="xs"
                  variant="outline"
                  onClick={retry}
                >
                  <RefreshIcon data-icon="inline-start" />
                  Retry
                </Button>
              ) : null}
              <Switch
                checked={captions.enabled}
                disabled={captionsCommandPending || !canEnable}
                onCheckedChange={(enabled) => patchCaptions({ enabled })}
              />
            </div>
          </SettingsRow>
        </FieldGroup>
        {platformUnavailable ? (
          <Alert data-testid="captions-platform-unavailable" variant="warning">
            <AlertTitle>{CAPTIONS_LINUX_TITLE}</AlertTitle>
            <AlertDescription>{CAPTIONS_LINUX_DETAIL}</AlertDescription>
          </Alert>
        ) : null}
        {livestreamBlocker ? (
          <Alert data-testid="captions-livestream-blocker" variant="warning">
            <AlertTitle>Captions can&apos;t go out on your next livestream</AlertTitle>
            <AlertDescription>{livestreamBlocker.description}</AlertDescription>
          </Alert>
        ) : null}

        {/* What captions listen to and where they show belong to Sources and
            Scene (D-27): these rows say it and open the page. */}
        <GroupedList aria-label="Captions on other pages" data-testid="captions-elsewhere">
          <NavigableRow
            icon={MicrophoneIcon}
            label="Microphone"
            value={microphoneName}
            onNavigate={() => openWorkspaceTab('sources')}
          />
          <NavigableRow
            icon={SceneIcon}
            label="Placement"
            value={captionsPlacementSummary(
              overlayLayout.captions,
              layoutPresetOrientation(captureConfig.layout.layoutPreset)
            )}
            onNavigate={() => openWorkspaceTab('layouts')}
          />
          {allowance ? (
            <NavigableRow icon={CaptionsIcon} label="Allowance" value={allowance} />
          ) : null}
        </GroupedList>
        {verticalLegArmed ? (
          <FieldDescription>
            A vertical destination shares the recording picture with the horizontal stream, so
            captions on stream are in the recording too.
          </FieldDescription>
        ) : null}

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
            disabled={locked}
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
          {/* Three labelled items need a full row: sharing a half-column let
              the labels escape the buttons at narrow widths (owner report,
              twice). min-w-fit keeps each item's intrinsic floor. */}
          <Field className="sm:col-span-2">
            <FieldLabel>Text size</FieldLabel>
            <SegmentedControl
              aria-label="Caption text size"
              className="w-full"
              disabled={locked}
              options={CAPTION_TEXT_SIZE_OPTIONS}
              value={captions.textSize}
              onValueChange={(textSize) => patchCaptions({ textSize }, true)}
            />
          </Field>
        </div>

        <Field>
          <FieldContent>
            <FieldLabel htmlFor="caption-language">Spoken language</FieldLabel>
            <FieldDescription>
              {isSessionActive ? SESSION_LOCK_REASON : 'Auto-detect works for most conversations.'}
            </FieldDescription>
          </FieldContent>
          <Select
            disabled={locked || isSessionActive}
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

        {(runtimeActive || lines.length > 0) && (
          <div className="flex min-h-16 flex-col justify-end gap-1.5 rounded-row border border-border bg-inset p-3">
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
            When Live captions is on, Videorc sends your microphone audio to its transcription
            service only while you record or go live.
          </p>
          <Button
            disabled={!captionsWindow.open && (locked || !captionsWindow.enabled)}
            variant="outline"
            onClick={() => void toggleCaptionsWindow()}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            {captionsWindow.open
              ? `Close ${WINDOW_NAMES.captions}`
              : `Open ${WINDOW_NAMES.captions}`}
            <ShortcutKeys
              accelerator={shortcutAccelerator('captions-window')}
              className="ml-1"
              platform={runtimeInfo?.platform}
            />
          </Button>
        </div>
      </FieldGroup>
    </PanelSection>
  )
}
