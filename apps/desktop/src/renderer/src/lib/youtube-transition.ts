import type { YouTubeBroadcastTransitionResult, YouTubeBroadcastTransitionStatus } from './backend'

export function assertYouTubeTransitionConfirmed(
  result: YouTubeBroadcastTransitionResult,
  expectedStatus: YouTubeBroadcastTransitionStatus
): void {
  if (result.lifecycleStatus === expectedStatus) {
    return
  }

  const current = result.lifecycleStatus ?? 'unknown'
  throw new Error(
    `YouTube didn't confirm ${expectedStatus}; current broadcast status is ${current}.`
  )
}
