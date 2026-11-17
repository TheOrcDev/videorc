const owners = new Map<number, () => Record<string, unknown>>()
export function registerRoomSystemResources(
  generation: number,
  read: () => Record<string, unknown>
): () => void {
  owners.set(generation, read)
  return () => {
    if (owners.get(generation) === read) owners.delete(generation)
  }
}
export function roomSystemResources(): Array<Record<string, unknown> & { generation: number }> {
  return [...owners].map(([generation, read]) => ({ generation, ...read() }))
}

const observations: unknown[] = []
let lost = 0
export function observeRoomSystemAudio(value: unknown): void {
  if (!import.meta.env.DEV) return
  if (observations.length === 2048) {
    observations.shift()
    lost++
  }
  observations.push(value)
}
export function takeRoomSystemObservations() {
  return { events: observations.splice(0), lost }
}
