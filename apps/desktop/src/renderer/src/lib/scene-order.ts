/** The library with one scene moved to `toIndex`, or null when nothing moves. */
export function movedScenes<S extends { id: string }>(
  scenes: readonly S[],
  id: string,
  toIndex: number
): S[] | null {
  const from = scenes.findIndex((scene) => scene.id === id)
  if (from < 0 || toIndex < 0 || toIndex >= scenes.length || toIndex === from) return null
  const next = [...scenes]
  const [scene] = next.splice(from, 1)
  next.splice(toIndex, 0, scene!)
  return next
}
