import { DownloadIcon, RefreshIcon, ThemeIcon } from '@/components/icons'
import { useTheme } from 'next-themes'
import { useState, type ReactElement } from 'react'

import { ObsImportDialog } from '@/components/obs-import-dialog'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import type { RuntimeInfo } from '@/lib/backend'
import { gpuFallbackAge, gpuRenderingLabel } from '@/lib/gpu-fallback-view'

/** Settings → General: how Videorc looks and behaves, and bringing setups across. */
export function GeneralSettings(): ReactElement {
  const { settings, setSettings, runtimeInfo, scheduleHardwareAccelerationRetry } = useStudioCore()
  const { theme, setTheme } = useTheme()
  const [obsImportOpen, setObsImportOpen] = useState(false)

  return (
    <>
      <PanelSection
        description="How Videorc looks and behaves on this device."
        icon={ThemeIcon}
        title="Appearance & behavior"
      >
        <FieldGroup variant="grouped">
          <Field>
            <FieldLabel>Theme</FieldLabel>
            <ToggleGroup
              type="single"
              value={theme ?? 'system'}
              variant="outline"
              onValueChange={(value) => value && setTheme(value)}
            >
              <ToggleGroupItem value="light">Light</ToggleGroupItem>
              <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
              <ToggleGroupItem value="system">System</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {runtimeInfo?.commentsWindowEnabled !== false ? (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <FieldLabel htmlFor="open-stream-manager-on-live">
                    Open Stream Manager when I go live
                  </FieldLabel>
                  <p className="text-xs text-muted-foreground">
                    Chat, viewers, followers and activity for the whole stream, in their own window.
                  </p>
                </div>
                <Switch
                  checked={settings.openStreamManagerOnLive === true}
                  id="open-stream-manager-on-live"
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, openStreamManagerOnLive: checked }))
                  }
                />
              </div>
            </Field>
          ) : null}
          {/* Plan 064: a studio behavior, not a storage setting, so it moved
              here from Recording. */}
          <Field>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <FieldLabel htmlFor="animate-scene-changes">Animate scene changes</FieldLabel>
                <p className="text-xs text-muted-foreground">
                  Layout switches glide into place instead of cutting, visible live on stream and in
                  recordings.
                </p>
              </div>
              <Switch
                checked={settings.animateSceneChanges === true}
                id="animate-scene-changes"
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, animateSceneChanges: checked }))
                }
              />
            </div>
          </Field>
          {runtimeInfo?.platform === 'win32' ? (
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Graphics acceleration</FieldLabel>
                <StatusBadge
                  tone={runtimeInfo.hardwareAccelerationDisabled ? 'warn' : 'good'}
                  value={gpuRenderingLabel(runtimeInfo)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {graphicsAccelerationDescription(runtimeInfo)}
              </p>
              {runtimeInfo.hardwareAccelerationDisabled &&
              runtimeInfo.gpuFallback.source !== 'env' ? (
                <Button
                  className="w-fit"
                  disabled={runtimeInfo.gpuFallback.retryScheduled}
                  size="sm"
                  variant="outline"
                  onClick={() => void scheduleHardwareAccelerationRetry()}
                >
                  <RefreshIcon data-icon="inline-start" />
                  {runtimeInfo.gpuFallback.retryScheduled
                    ? 'Retry scheduled'
                    : 'Retry on next launch'}
                </Button>
              ) : null}
            </Field>
          ) : null}
        </FieldGroup>
      </PanelSection>

      <PanelSection
        description="Coming from OBS Studio? Bring your scenes and settings across."
        icon={DownloadIcon}
        title="Import"
      >
        {/* O4 (OBS import plan): the wizard previews the truthful
            imported/approximated/skipped report BEFORE anything applies. */}
        <div>
          <Button size="sm" variant="outline" onClick={() => setObsImportOpen(true)}>
            <DownloadIcon data-icon="inline-start" />
            Import from OBS…
          </Button>
        </div>
        <ObsImportDialog open={obsImportOpen} onOpenChange={setObsImportOpen} />
      </PanelSection>
    </>
  )
}

function graphicsAccelerationDescription(runtimeInfo: RuntimeInfo): string {
  const age = gpuFallbackAge(runtimeInfo.gpuFallback.updatedAt)
  const fallbackAge = age ? ` ${age}` : ''

  if (runtimeInfo.gpuFallback.source === 'retry') {
    return `This launch is testing hardware acceleration after a fallback${fallbackAge}. Two GPU-process crashes restore software rendering automatically; a stable minute clears the fallback.`
  }
  if (runtimeInfo.gpuFallback.source === 'env') {
    return 'Software rendering was requested with VIDEORC_DISABLE_GPU. Remove that environment override and reopen Videorc to use hardware acceleration.'
  }
  if (runtimeInfo.hardwareAccelerationDisabled) {
    if (runtimeInfo.gpuFallback.retryScheduled) {
      return `The GPU fallback began${fallbackAge}. Hardware acceleration will be retried after you quit and reopen Videorc; this launch stays in software rendering mode.`
    }
    return `Videorc switched to software rendering${fallbackAge} after ${runtimeInfo.gpuFallback.crashCount} GPU-process crashes. A retry affects only the next launch, and repeated crashes restore this safe mode.`
  }
  return 'Chromium hardware acceleration is active. Repeated GPU-process crashes still fall back to software rendering on the next launch.'
}
