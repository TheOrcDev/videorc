import { FileVideo, WarningCircle } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
import { useStudio } from '@/hooks/use-studio'
import type { SessionSummary, VideoPreset } from '@/lib/backend'
import {
  customVideoPresetOption,
  legacyVideoPresetOptions,
  recordingVideoPresetOptions,
  streamingVideoPresetOptions,
  videoProfileCompatibility
} from '@/lib/capture'
import { dayLabel, durationMsLabel } from '@/lib/format'

// One-click resolutions so nobody has to remember pixel counts; picking one patches
// width/height (switching the preset to Custom), and the number fields below stay
// available for anything else.
const RESOLUTION_PRESETS = [
  { label: '4K', detail: '3840 × 2160', width: 3840, height: 2160 },
  { label: '2K', detail: '2560 × 1440', width: 2560, height: 1440 },
  { label: '1080p', detail: '1920 × 1080', width: 1920, height: 1080 },
  { label: '720p', detail: '1280 × 720', width: 1280, height: 720 }
] as const

export function RecordingTab(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    patchVideo,
    applyVideoPreset,
    sessions,
    remuxSession,
    isSessionActive
  } = useStudio()
  const { video } = captureConfig
  const compatibility = videoProfileCompatibility(captureConfig)
  const compatibilityMessage = compatibility.blockingReason ?? compatibility.warning
  const outputSessions = sessions.filter((session) => session.outputPath || session.streamPreset)

  return (
    <div className="grid gap-4">
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
        description="Local recording exports MP4 into the recordings folder after capture finalizes."
        icon={FileVideo}
        title="Recording"
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
              onValueChange={(value) => applyVideoPreset(value as VideoPreset)}
            >
              <SelectTrigger className="w-full" id="video-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Recording</SelectLabel>
                  {recordingVideoPresetOptions.map((option) => (
                    <SelectItem
                      className={option.tone === 'warning' ? 'text-warning' : undefined}
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectLabel>Streaming</SelectLabel>
                  {streamingVideoPresetOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectLabel>Legacy</SelectLabel>
                  {legacyVideoPresetOptions.map((option) => (
                    <SelectItem
                      className={option.tone === 'warning' ? 'text-warning' : undefined}
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={customVideoPresetOption.value}>
                    {customVideoPresetOption.label}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Editing a value below switches the preset to Custom.
            </FieldDescription>
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
                  className="cursor-pointer rounded-lg border border-border px-3 py-2 text-left text-sm font-medium transition-colors duration-100 hover:bg-accent aria-pressed:border-ring aria-pressed:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
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

      <PanelSection
        description="Completed local recording artifacts live here."
        icon={FileVideo}
        title="Recording artifacts"
      >
        {outputSessions.length ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {outputSessions.map((session) => (
              <OutputSessionRow
                key={session.id}
                session={session}
                onRemux={() => remuxSession(session.id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Completed local recordings will appear here.
          </p>
        )}
      </PanelSection>
    </div>
  )
}

function OutputSessionRow({
  session,
  onRemux
}: {
  session: SessionSummary
  onRemux: () => void
}): ReactElement {
  const canRemux = Boolean(
    session.status === 'completed' && session.outputPath?.endsWith('.mkv') && !session.mp4Path
  )

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{session.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {dayLabel(session.startedAt)} · {session.status} ·{' '}
          {session.mp4Path ?? session.outputPath ?? session.streamPreset}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {session.container ? (
            <Badge variant="outline">{session.container.toUpperCase()}</Badge>
          ) : null}
          {typeof session.durationMs === 'number' ? (
            <Badge variant="secondary">{durationMsLabel(session.durationMs)}</Badge>
          ) : null}
          {session.mp4Path ? (
            <Badge variant="success">MP4</Badge>
          ) : (
            <Badge variant="outline">MKV</Badge>
          )}
        </div>
      </div>
      <Button disabled={!canRemux} size="sm" variant="outline" onClick={onRemux}>
        Export MP4
      </Button>
    </div>
  )
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
