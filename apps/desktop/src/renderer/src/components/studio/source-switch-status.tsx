import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import type { SessionSourceKind } from '@/lib/backend'

/** Both picker surfaces describe the same backend operation and recovery. */
export function SourceSwitchStatus({ kind }: { kind: SessionSourceKind }): ReactElement | null {
  const {
    sourceSelectionState: state,
    sourceSwitchReason,
    retrySourceStatus,
    deviceList
  } = useStudioCore()
  const pending = state.snapshot?.pending
  const targetName =
    state.targetName ??
    (pending?.deviceId === null
      ? 'None'
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
          : `Preparing ${targetName ?? 'source'}…`
        : health?.health === 'unavailable'
          ? 'Source unavailable. Select it again to retry, or choose another.'
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
        <Button size="sm" variant="outline" onClick={() => void retrySourceStatus()}>
          Retry status
        </Button>
      ) : null}
    </span>
  )
}
