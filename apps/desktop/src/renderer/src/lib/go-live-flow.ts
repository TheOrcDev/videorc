import type { GoLivePreflight, StreamingSettings, StreamTargetSettings } from './backend'

export type GoLiveSetupFailure = {
  targetId: string
  platform: StreamTargetSettings['platform']
  label: string
  message: string
}

export type GoLivePartialSetup = {
  streaming: StreamingSettings
  failures: GoLiveSetupFailure[]
  readyLabels: string[]
}

export type GoLiveStartDecision = 'start-directly' | 'open-confirmation'

export function decideGoLiveStart(streamEnabled: boolean): GoLiveStartDecision {
  return streamEnabled ? 'open-confirmation' : 'start-directly'
}

export function shouldIgnoreGoLiveAction(input: {
  goLiveConfirmationPending: boolean
  startRequestPending: boolean
}): boolean {
  return input.goLiveConfirmationPending || input.startRequestPending
}

export function decideGoLivePreflight(
  preflight: Pick<GoLivePreflight, 'valid'>
): { kind: 'continue' } | { kind: 'blocked' } {
  return preflight.valid ? { kind: 'continue' } : { kind: 'blocked' }
}

export function decidePreparedGoLiveSetup(
  setup: GoLivePartialSetup
):
  | { kind: 'start'; streaming: StreamingSettings }
  | { kind: 'partial'; setup: GoLivePartialSetup }
  | { kind: 'no-ready-destinations' } {
  if (setup.failures.length === 0) {
    return { kind: 'start', streaming: setup.streaming }
  }
  if (setup.readyLabels.length === 0) {
    return { kind: 'no-ready-destinations' }
  }
  return { kind: 'partial', setup }
}

export function decideCancelGoLiveConfirmation(input: {
  goLiveConfirmationPending: boolean
  startRequestPending: boolean
  partialSetup: GoLivePartialSetup | null
}): { kind: 'ignore' } | { kind: 'close'; cleanupStreaming?: StreamingSettings } {
  if (shouldIgnoreGoLiveAction(input)) {
    return { kind: 'ignore' }
  }
  return {
    kind: 'close',
    cleanupStreaming: input.partialSetup?.streaming
  }
}

export function decideContinueGoLiveWithReadyDestinations(input: {
  goLiveConfirmationPending: boolean
  startRequestPending: boolean
  partialSetup: GoLivePartialSetup | null
}): { kind: 'ignore' } | { kind: 'start'; streaming: StreamingSettings } {
  if (shouldIgnoreGoLiveAction(input) || !input.partialSetup) {
    return { kind: 'ignore' }
  }
  return { kind: 'start', streaming: input.partialSetup.streaming }
}
