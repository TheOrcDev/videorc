import { type ReactElement } from 'react'

import { KebabMenu } from '@/components/kebab-menu'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { WatchdogAlert, WatchdogAlertFix } from '@/lib/backend'

// The watchdog's card (plan 223 A5, D2): one `Alert` per open problem, in
// the Session panel's notices and in the Stream Manager's chip. Its title
// and detail are the backend's exact words (the clock in them is live), the
// first fix is the primary button, Got it or I meant to is the quiet one,
// and a kebab holds Snooze 10 min. The tone rides on the Alert's icon
// (critical is destructive, warning is warning, a notice is plain); nothing
// else is tinted. "Source: Videorc Cloud" sits under the detail when the
// reading came from the runner (D9); the desktop's own alerts carry no line.

export interface WatchdogAlertCardProps {
  alert: WatchdogAlert
  onFix: (alert: WatchdogAlert, fix: WatchdogAlertFix) => void
  onAcknowledge: (alert: WatchdogAlert) => void
  onSnooze: (alert: WatchdogAlert, scope: 'ten-minutes' | 'stream') => void
  /**
   * The Stream Manager's hover card: compact, with the fixes only. Got it,
   * I meant to and Snooze need the backend socket, which that window has
   * not (plan 223 A6), so they are not drawn there (L2).
   */
  compact?: boolean
}

/** "I meant to" is the mute's own quiet button (D3); every other check says Got it. */
export function watchdogQuietLabel(alert: Pick<WatchdogAlert, 'check'>): string {
  return alert.check === 'mic-muted' ? 'I meant to' : 'Got it'
}

export function watchdogCardVariant(
  alert: Pick<WatchdogAlert, 'severity'>
): 'destructive' | 'warning' | 'default' {
  return alert.severity === 'critical'
    ? 'destructive'
    : alert.severity === 'warning'
      ? 'warning'
      : 'default'
}

export function WatchdogAlertCard({
  alert,
  onFix,
  onAcknowledge,
  onSnooze,
  compact = false
}: WatchdogAlertCardProps): ReactElement {
  const [primary, ...more] = alert.fixes ?? []
  const quiet = watchdogQuietLabel(alert)
  const acknowledged = alert.state === 'acknowledged'
  return (
    <Alert
      data-alert-id={alert.id}
      data-check={alert.check}
      data-severity={alert.severity}
      data-testid="watchdog-alert"
      variant={watchdogCardVariant(alert)}
    >
      <AlertTitle className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1">{alert.title}</span>
        {compact ? null : (
          <KebabMenu
            items={[
              {
                id: 'snooze',
                label: 'Snooze 10 min',
                onSelect: () => onSnooze(alert, 'ten-minutes')
              }
            ]}
            label={`More for ${alert.title}`}
            tabIndex={-1}
          />
        )}
      </AlertTitle>
      <AlertDescription className="min-w-0">
        <p data-testid="watchdog-alert-detail">{alert.detail}</p>
        {alert.source === 'cloud' ? (
          <p className="text-[11px] text-muted-foreground" data-testid="watchdog-alert-source">
            Source: Videorc Cloud
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-2">
          {primary ? (
            <Button
              data-testid="watchdog-alert-fix"
              size="xs"
              type="button"
              variant="default"
              onClick={() => onFix(alert, primary)}
            >
              {primary.label}
            </Button>
          ) : null}
          {more.map((fix) => (
            <Button
              key={fix.kind}
              data-testid="watchdog-alert-fix"
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onFix(alert, fix)}
            >
              {fix.label}
            </Button>
          ))}
          {compact ? null : quiet === 'I meant to' ? (
            <Button
              data-testid="watchdog-alert-quiet"
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onSnooze(alert, 'stream')}
            >
              {quiet}
            </Button>
          ) : (
            <Button
              data-testid="watchdog-alert-quiet"
              disabled={acknowledged}
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onAcknowledge(alert)}
            >
              {acknowledged ? 'Seen' : quiet}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
