/** Lightweight DEV harness seam; no worklet import in the eager Studio bundle. */
let enabled = false
const resources = new Map<number, () => Record<string, unknown>>()
export function roomPcmTestEnabled(): boolean {
  return enabled
}
export function setRoomPcmTestEnabled(value: boolean): void {
  if (!import.meta.env.DEV) throw new Error('PCM fixture requires a development renderer.')
  enabled = value
}
export function registerRoomPcmResources(
  generation: number,
  read: () => Record<string, unknown>
): () => void {
  if (resources.size >= 64)
    throw new Error('PCM resource owner limit reached; inspect leaked owners.')
  resources.set(generation, read)
  return () => {
    resources.delete(generation)
  }
}
export function roomPcmTestResources(): { enabled: boolean; owners: Record<string, unknown>[] } {
  return {
    enabled,
    owners: [...resources].map(([generation, read]) => ({ generation, ...read() }))
  }
}
