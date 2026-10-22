import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useUsageStatsSetting } from '@/hooks/use-usage-stats-setting'
import type { UsageStatsState } from '@/lib/backend'

export const USAGE_STATS_DESCRIPTION =
  "When a recording or livestream starts and stops, Videorc sends a random ID for this install, how long it ran and which platforms you streamed to, so we can count how many people stream each week. Never stream keys, titles, chat or anything you record. If you're signed in, it's linked to your account."

/** Settings → General → Privacy. */
export function PrivacySettingsSection(): ReactElement {
  const { state, error, setEnabled } = useUsageStatsSetting()
  return (
    <PanelSection description="What Videorc shares about how you use it." title="Privacy">
      <UsageStatsFieldView error={error} state={state} onEnabledChange={setEnabled} />
    </PanelSection>
  )
}

/**
 * The "Share anonymous usage stats" row. It waits for the backend with the
 * switch disabled, and a failure says why once, ahead of the row (plan 174
 * I-8). A launch that forced sharing off says so under the switch.
 */
export function UsageStatsFieldView({
  state,
  error,
  onEnabledChange
}: {
  state: UsageStatsState | null
  error: string | null
  onEnabledChange: (on: boolean) => void
}): ReactElement {
  const envDisabled = state?.envDisabled === true
  return (
    <>
      {error ? (
        <Alert data-testid="usage-stats-error" variant="warning">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <FieldGroup variant="grouped">
        <SettingsRow
          description={
            <>
              {USAGE_STATS_DESCRIPTION}
              {envDisabled ? (
                <span className="block" data-slot="usage-stats-env">
                  Turned off when Videorc started. Reopen Videorc to change it.
                </span>
              ) : null}
            </>
          }
          label="Share anonymous usage stats"
        >
          <Switch
            checked={state?.enabled ?? false}
            disabled={!state || envDisabled}
            id="share-anonymous-usage-stats"
            onCheckedChange={onEnabledChange}
          />
        </SettingsRow>
      </FieldGroup>
    </>
  )
}
