import { DisabledIcon, ErrorIcon, LockIcon, RefreshIcon, SuccessIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { useStudioAudio, useStudioCore } from '@/hooks/use-studio'
import { osSettingsName } from '@/lib/platform'
import { systemAccessAction, systemAccessRows } from '@/lib/system-access'

/** Settings → Permissions: what the OS lets Videorc capture right now. */
export function PermissionsSettings({
  onOpenPermissionsSetup
}: {
  onOpenPermissionsSetup: () => void
}): ReactElement {
  const {
    deviceList,
    mediaAccess,
    refreshBackend,
    handleSystemPermission,
    openSystemPermissionSettings,
    runtimeInfo
  } = useStudioCore()
  const { audioMeter } = useStudioAudio()

  const accessRows = systemAccessRows({
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    mediaAccess
  })

  return (
    <PanelSection
      description={`What ${osSettingsName(runtimeInfo?.platform)} lets Videorc capture right now.`}
      icon={LockIcon}
      title="System access"
      action={
        <Button size="sm" variant="ghost" onClick={() => void refreshBackend()}>
          <RefreshIcon data-icon="inline-start" />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-row border border-border bg-foreground/[0.03]">
        {accessRows.map((row) => {
          const action = systemAccessAction({
            pane: row.id,
            state: row.state,
            platform: runtimeInfo?.platform,
            mediaAccessStatus:
              row.id === 'camera' || row.id === 'microphone' ? mediaAccess?.[row.id] : undefined
          })
          return (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="w-32 shrink-0 font-medium">{row.label}</span>
              {/* Q4 (plan 022): the permission TARGET is the actionable part —
                  truncation clipped it to "Captur…"/"Voice a…". The row
                  flex-wraps, so let the detail take a full line when tight
                  instead of truncating; tooltip keeps the hover affordance. */}
              <span
                className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground"
                title={`${row.purpose} ${row.detail}`}
              >
                {row.purpose} {row.detail}
              </span>
              {action ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void handleSystemPermission(row.id)}
                >
                  {action === 'request-media-access' ? 'Enable' : 'Open settings'}
                </Button>
              ) : row.state === 'granted' ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void openSystemPermissionSettings(row.id)}
                >
                  Manage
                </Button>
              ) : null}
              {row.state === 'granted' ? (
                <SuccessIcon
                  aria-label={`${row.label} granted`}
                  className="size-4 shrink-0 text-success"
                  weight="fill"
                />
              ) : row.state === 'not-granted' || row.state === 'device-issue' ? (
                <ErrorIcon
                  aria-label={
                    row.state === 'device-issue'
                      ? `${row.label} device issue`
                      : `${row.label} not granted`
                  }
                  className="size-4 shrink-0 text-destructive"
                  weight="fill"
                />
              ) : (
                <DisabledIcon
                  aria-label={`${row.label} checked on first use`}
                  className="size-4 shrink-0 text-muted-foreground"
                  weight="fill"
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button size="sm" variant="outline" onClick={onOpenPermissionsSetup}>
          <LockIcon data-icon="inline-start" />
          Set up permissions
        </Button>
        <p className="text-xs text-muted-foreground">
          Grants live in {osSettingsName(runtimeInfo?.platform)}. After changing one, come back
          here. Rows refresh automatically.
        </p>
      </div>
    </PanelSection>
  )
}
