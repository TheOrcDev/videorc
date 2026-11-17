/** Plan 249 S13a: lightweight DEV harness seam; nothing here enables a production camera. */
let enabled = false
const resources = new Map<number, () => Record<string, unknown>>()
const controls = new Map<number, { resetSurface: () => Promise<void> }>()
export function roomFrameTestEnabled(): boolean {
  return enabled
}
export function setRoomFrameTestEnabled(value: boolean): void {
  if (!import.meta.env.DEV) throw new Error('Frame fixture requires a development renderer.')
  enabled = value
}
/** Harness-only: observe the bridge's encoder output (`RTCRtpScriptTransform`). DEV only. */
let encodeObserverEnabled = false
export function roomFrameEncodeObserverEnabled(): boolean {
  return encodeObserverEnabled
}
export function setRoomFrameEncodeObserver(value: boolean): void {
  if (!import.meta.env.DEV) throw new Error('Encode observer requires a development renderer.')
  encodeObserverEnabled = value
}
export function registerRoomFrameResources(
  generation: number,
  read: () => Record<string, unknown>,
  control: { resetSurface: () => Promise<void> }
): () => void {
  if (resources.size >= 64)
    throw new Error('Frame resource owner limit reached; inspect leaked owners.')
  resources.set(generation, read)
  controls.set(generation, control)
  return () => {
    resources.delete(generation)
    controls.delete(generation)
  }
}
export function roomFrameTestResources(): {
  enabled: boolean
  owners: Record<string, unknown>[]
} {
  return {
    enabled,
    owners: [...resources].map(([generation, read]) => ({ generation, ...read() }))
  }
}
/** Harness-only: simulate a native GPU/surface loss on every live owner. */
export async function resetRoomFrameSurfaces(): Promise<number> {
  const live = [...controls.values()]
  await Promise.all(live.map((control) => control.resetSurface()))
  return live.length
}
