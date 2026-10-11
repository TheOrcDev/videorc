import { RefreshIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SystemAccessList } from '@/components/system-access-list'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { useStudioAudio, useStudioCore } from '@/hooks/use-studio'
import { osSettingsName } from '@/lib/platform'
import { systemAccessRows } from '@/lib/system-access'

/**
 * Settings → Permissions: what the OS lets Videorc capture right now. The
 * rows are the first-run dialog's own list (plan 174 S3.17, I-10), so a
 * "set up permissions" step that reopened the same rows is gone.
 */
export function PermissionsSettings(): ReactElement {
  const {
    deviceList,
    mediaAccess,
    refreshBackend,
    handleSystemPermission,
    openSystemPermissionSettings,
    runtimeInfo
  } = useStudioCore()
  const { audioMeter } = useStudioAudio()
  const platform = runtimeInfo?.platform
  const settingsName = osSettingsName(platform)

  const accessRows = systemAccessRows({ deviceList, audioMeter, platform, mediaAccess })

  return (
    <PanelSection
      description={`What ${settingsName} lets Videorc capture right now.`}
      title="System access"
      action={
        <Button variant="ghost" onClick={() => void refreshBackend()}>
          <RefreshIcon data-icon="inline-start" />
          Refresh
        </Button>
      }
    >
      {accessRows.length > 0 ? (
        <>
          <SystemAccessList
            mediaAccess={mediaAccess}
            platform={platform}
            rows={accessRows}
            onAction={handleSystemPermission}
          />
          <FieldGroup variant="grouped">
            <SettingsRow
              description={`Grants live in ${settingsName}. Come back here after changing one: the rows update on their own.`}
              label="Change a permission"
            >
              <Button
                variant="outline"
                onClick={() => void openSystemPermissionSettings('privacy')}
              >
                Open {settingsName}…
              </Button>
            </SettingsRow>
          </FieldGroup>
        </>
      ) : (
        // Linux (plan 174 I-8): no standing camera or microphone grant, and the
        // desktop portal asks per capture, so there is nothing to list. Say so
        // instead of an empty box.
        <Empty className="p-4" data-testid="system-access-none">
          <EmptyHeader>
            <EmptyTitle>Nothing to grant here</EmptyTitle>
            <EmptyDescription>
              Linux keeps no capture permissions for apps. Your desktop may ask when Videorc starts
              capturing the screen.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PanelSection>
  )
}
