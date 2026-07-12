import { FileVideo, WarningCircle } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { VideoPresetSelectItems } from '@/components/video-preset-select-items'
import { useStudioCore } from '@/hooks/use-studio'
import type { VideoPreset } from '@/lib/backend'
import { videoProfileCompatibility } from '@/lib/capture'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'

// One-click resolutions so nobody has to remember pixel counts; picking one patches
// width/height (switching the preset to Custom), and the number fields below stay
// available for anything else.
const RESOLUTION_PRESETS = [
  { label: '4K', detail: '3840 × 2160', width: 3840, height: 2160 },
  { label: '2K', detail: '2560 × 1440', width: 2560, height: 1440 },
  { label: '1080p', detail: '1920 × 1080', width: 1920, height: 1080 },
  { label: '720p', detail: '1280 × 720', width: 1280, height: 720 },
  { label: 'Vertical', detail: '1080 × 1920', width: 1080, height: 1920 }
] as const

export function RecordingTab(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    patchVideo,
    applyVideoPreset,
    isSessionActive,
    entitlements
  } = useStudioCore()
  const { video } = captureConfig
  const compatibility = videoProfileCompatibility(captureConfig)
  const compatibilityMessage = compatibility.blockingReason ?? compatibility.warning
  const profileGate = videoProfileEntitlementGate({ entitlements, kind: 'recording', video })
  const profileEntitlementMessage = profileGate.allowed ? null : profileGate.reason

  return (
    <div className="grid gap-5">
      <PanelSection
        action={
          <Switch
            aria-label="Record MKV"
            checked={captureConfig.recordEnabled}
            disabled={isSessionActive}
            onCheckedChange={(checked) =>
              setCaptureConfig((current) => ({ ...current, recordEnabled: checked }))
            }
          />
        }
        description="Local recording exports MP4 into the recordings folder after capture finalizes. Completed files live in the Library."
        icon={FileVideo}
        title="Output"
      >
        {isSessionActive ? (
          <p className="text-sm text-muted-foreground">
            Locked while live — output settings apply to the next session.
          </p>
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="video-preset">Video preset</FieldLabel>
            <Select
              disabled={isSessionActive}
              value={video.preset}
              onValueChange={(value) =>
                applyVideoPreset(value as VideoPreset, { kind: 'recording' })
              }
            >
              <SelectTrigger className="w-full" id="video-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <VideoPresetSelectItems entitlements={entitlements} kind="recording" />
              </SelectContent>
            </Select>
            <FieldDescription>
              Editing a value below switches the preset to Custom.
            </FieldDescription>
            {profileEntitlementMessage ? (
              <Alert variant="warning">
                <WarningCircle />
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
                <WarningCircle />
                <AlertDescription>{compatibilityMessage}</AlertDescription>
              </Alert>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Resolution</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {RESOLUTION_PRESETS.map((preset) => (
                <button
                  aria-pressed={video.width === preset.width && video.height === preset.height}
                  className="cursor-pointer rounded-row border border-border px-3 py-2 text-left text-sm font-medium transition-colors duration-100 hover:bg-accent aria-pressed:border-ring aria-pressed:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isSessionActive}
                  key={preset.label}
                  type="button"
                  onClick={() => patchVideo({ width: preset.width, height: preset.height })}
                >
                  <div>{preset.label}</div>
                  <div className="text-xs font-normal text-muted-foreground">{preset.detail}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <NumberField
              disabled={isSessionActive}
              label="Width"
              max={3840}
              min={640}
              value={video.width}
              onChange={(width) => patchVideo({ width })}
            />
            <NumberField
              disabled={isSessionActive}
              label="Height"
              max={2160}
              min={360}
              value={video.height}
              onChange={(height) => patchVideo({ height })}
            />
            <NumberField
              disabled={isSessionActive}
              label="FPS"
              max={60}
              min={24}
              value={video.fps}
              onChange={(fps) => patchVideo({ fps })}
            />
            <NumberField
              disabled={isSessionActive}
              label="Bitrate kbps"
              max={50000}
              min={1000}
              step={500}
              value={video.bitrateKbps}
              onChange={(bitrateKbps) => patchVideo({ bitrateKbps })}
            />
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

function NumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}): ReactElement {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  )
}
