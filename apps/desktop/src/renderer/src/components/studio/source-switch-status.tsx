import type { ReactElement } from 'react'
import { LCD_VALUE_BUTTON } from '@/components/lcd-panel'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import type { SessionSourceKind } from '@/lib/backend'

/** Both picker surfaces describe the same backend operation and recovery. */
export function SourceSwitchStatus({
  kind,
  look = 'default'
}: {
  kind: SessionSourceKind
  /** `lcd`: on a Studio screen (plan 197), so its one action is the screen's too. */
  look?: 'default' | 'lcd'
}): ReactElement | null {
  const {
    sourceSelectionState: state,
    sourceSwitchReason,
    retrySourceStatus,
    deviceList
  } = useStudioCore()
  const pending = state.snapshot?.pending
  // A switch to no device turns the source off: "Turning off…", never
  // "Preparing None…" (plan 174 C-PAT: Off, not None).
  const turningOff = !state.targetName && pending?.deviceId === null
  const targetName =
    state.targetName ??
    (pending?.deviceId === null
      ? null
      : (deviceList.devices.find((device) => device.id === pending?.deviceId)?.name ??
        pending?.deviceId))
  const health = state.snapshot?.health.find((item) => item.kind === kind)
  const message =
    (state.error && (!state.errorKind || state.errorKind === kind) ? state.error : null) ??
    (state.checking
      ? 'Checking source…'
      : state.pending === kind || pending?.kind === kind
        ? pending?.stage === 'restoring'
          ? 'Restoring previous source…'
          : turningOff
            ? 'Turning off…'
            : `Preparing ${targetName ?? 'source'}…`
        : health?.health === 'unavailable'
          ? 'Source unavailable. Choose it again to retry, or choose another.'
          : state.snapshot?.lastOperation?.kind === kind &&
              state.snapshot.lastOperation.stage === 'applied' &&
              !state.snapshot.lastOperation.outputObserved
            ? state.snapshot.lastOperation.outputSuperseded
              ? 'Source selected. A newer scene is now active.'
              : 'Source changed. Checking output…'
            : sourceSwitchReason(kind))
  if (!message) return null
  return (
    <span className="flex flex-col items-start gap-1" role="status">
      <span>{message}</span>
      {(state.checking || state.outputPending) && state.error ? (
        look === 'lcd' ? (
          <button
            className={LCD_VALUE_BUTTON}
            type="button"
            onClick={() => void retrySourceStatus()}
          >
            Check again
          </button>
        ) : (
          <Button variant="outline" onClick={() => void retrySourceStatus()}>
            Check again
          </Button>
        )
      ) : null}
    </span>
  )
}
