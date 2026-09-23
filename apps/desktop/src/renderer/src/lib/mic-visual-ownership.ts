// Synchronous lease suspension is kept small so controls do not eagerly load WebAudio.
const visualOwners = new Set<() => void>()
const visualPipelines = new Set<() => void>()
const visualEpochListeners = new Set<() => void>()
let visualEpoch = 0
export const visualMicrophoneEpoch = (): number => visualEpoch
export function subscribeVisualMicrophoneEpoch(listener: () => void): () => void {
  visualEpochListeners.add(listener)
  return () => {
    visualEpochListeners.delete(listener)
  }
}
export function registerVisualMicrophoneSuspension(suspend: () => void): () => void {
  visualPipelines.add(suspend)
  return () => {
    visualPipelines.delete(suspend)
  }
}
/** Release owned visual leases before the backend starts a microphone transaction. */
export function closeVisualMicrophoneStreams(): void {
  for (const suspend of visualPipelines) suspend()
  for (const close of visualOwners) close()
  visualEpoch += 1
  for (const listener of visualEpochListeners) listener()
}

export function registerVisualMicrophoneOwner(close: () => void): () => void {
  visualOwners.add(close)
  return () => {
    visualOwners.delete(close)
  }
}
