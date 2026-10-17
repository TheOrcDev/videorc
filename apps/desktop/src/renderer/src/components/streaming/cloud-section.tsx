import { useEffect, type ReactElement } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Field, FieldDescription, FieldGroup, FieldLabel, SettingsRow } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import {
  CLOUD_NOT_YET_REASON,
  CLOUD_PREMIUM_REASON,
  cloudSectionState,
  formatHoldLimit
} from '@/lib/cloud-view'
import { VIDEORC_PREMIUM_URL } from '@/lib/videorc-web-links'

// The Livestream page's Videorc Cloud section (plan 184 C6). Stream settings
// live on this page, so the cloud's do too: the switch, the month's hours,
// what viewers see if this computer drops, and for how long. Go Live itself
// never grows a control (D11): with the switch on it goes through the cloud.
// Locked means disabled with one reason: the plan's lock leads this section,
// and a running session's is the page's own SessionLockAlert.

const BRB_CARD = 'default'

export function CloudSection(): ReactElement | null {
  const { cloudStatus, refreshCloudAllowance, setCloudSettings } = useStudioCloud()
  const { isSessionActive, screens } = useStudioCore()
  const section = cloudSectionState(cloudStatus)
  const kind = section?.kind

  // Fresh hours when the page opens (and when the account becomes entitled);
  // the backend keeps them current during a show.
  useEffect(() => {
    if (kind === 'available') void refreshCloudAllowance()
  }, [kind, refreshCloudAllowance])

  // An older backend never answers: the section stays away.
  if (!cloudStatus || !section) return null

  const { settings } = cloudStatus
  const available = section.kind === 'available'
  const disabled = !available || isSessionActive
  // A locked section shows what the cloud does, switched off; an open one
  // folds the hold choices away while the switch is off.
  const enabled = available && settings.enabled
  const showHold = !available || settings.enabled
  return (
    <PanelSection
      description="Your stream stays on air if this computer drops."
      title="Videorc Cloud"
    >
      {section.kind === 'upsell' ? (
        <LockAlert
          action={{ kind: 'view-premium', url: VIDEORC_PREMIUM_URL }}
          reason={CLOUD_PREMIUM_REASON}
        />
      ) : section.kind === 'unavailable' ? (
        <LockAlert reason={CLOUD_NOT_YET_REASON} />
      ) : null}
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="cloud-stream-through"
          description={available ? section.hours : null}
          label="Stream through Videorc Cloud"
        >
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(next) => void setCloudSettings({ enabled: next })}
          />
        </SettingsRow>
      </FieldGroup>
      {showHold ? (
        <FieldGroup>
          <Field data-disabled={disabled}>
            <FieldLabel>If this computer drops, show</FieldLabel>
            <Select
              disabled={disabled}
              value={settings.holdImageScreenId ?? BRB_CARD}
              onValueChange={(value) =>
                void setCloudSettings({ holdImageScreenId: value === BRB_CARD ? null : value })
              }
            >
              <SelectTrigger className="w-full" data-testid="cloud-hold-image">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BRB_CARD}>Be right back card</SelectItem>
                {screens.map((screen) => (
                  <SelectItem key={screen.id} value={screen.id}>
                    {screen.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Viewers see it until you&apos;re back.</FieldDescription>
          </Field>
          <Field data-disabled={disabled}>
            <FieldLabel>End the stream after</FieldLabel>
            <SegmentedControl<string>
              disabled={disabled}
              options={settings.holdMaxChoices.map((seconds) => ({
                value: String(seconds),
                label: formatHoldLimit(seconds)
              }))}
              value={String(settings.holdMaxSeconds)}
              onValueChange={(value) => void setCloudSettings({ holdMaxSeconds: Number(value) })}
            />
            <FieldDescription>
              Come back before then and the stream picks up where it left off.
            </FieldDescription>
          </Field>
        </FieldGroup>
      ) : null}
    </PanelSection>
  )
}
