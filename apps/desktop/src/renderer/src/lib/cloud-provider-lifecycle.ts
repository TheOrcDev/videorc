import type { CloudStatus } from '@/lib/backend'

/** Actual destination facts, never native encoder readiness or a room's live flag. */
export async function waitForCloudProviderOutput(options: {
  showId: string
  targetId: string
  current: () => boolean
  read: () => Promise<CloudStatus>
  sleep: (ms: number) => Promise<void>
}): Promise<CloudStatus> {
  let interval: string | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!options.current()) throw new Error('The livestream start was cancelled.')
    const state = await options.read()
    if (!options.current()) throw new Error('The livestream start was cancelled.')
    if (
      state.show?.id !== options.showId ||
      state.stoppedBy ||
      state.onAir?.thisDevice === false ||
      state.liveInterval?.endRequestedAt ||
      ['ending', 'failed', 'off'].includes(state.phase)
    )
      throw new Error('This computer no longer owns that cloud output.')
    if (interval && state.liveInterval?.id !== interval)
      throw new Error('The cloud output interval changed.')
    interval ??= state.liveInterval?.id
    const leg = state.legs?.find((candidate) => candidate.targetId === options.targetId)
    if (leg?.state === 'failed' || leg?.state === 'stopped')
      throw new Error('The cloud destination failed before it went live.')
    if (state.connected && leg?.state === 'live') return state
    if (attempt < 7) await options.sleep(2000)
  }
  throw new Error('The cloud destination is not live yet. Going live is still pending.')
}

/** Disappearance/disconnect alone is not a terminal event. Handoff is never one. */
export function cloudTerminalOwner(previous: CloudStatus | null, next: CloudStatus): string | null {
  const id = previous?.show?.id
  if (!id || next.stoppedBy || next.onAir?.thisDevice === false) return null
  if (
    !next.show &&
    next.endReason &&
    !['handover-failed', 'node-unreachable', 'cloud-node-unreachable'].includes(next.endReason)
  )
    return id
  if (next.show?.id === id && previous.room?.live && next.room?.live === false && next.connected)
    return id
  return null
}
