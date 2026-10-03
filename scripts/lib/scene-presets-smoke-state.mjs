/** Runs in the renderer so failures name a field before Electron clones the result. */
function readScenePresetState() {
  const state = window.__videorcSmokeScenePresets?.state()
  try {
    structuredClone(state)
  } catch {
    const visited = new WeakSet()
    const uncloneablePath = (value, path) => {
      try {
        structuredClone(value)
        return undefined
      } catch {
        if (value !== null && typeof value === 'object') {
          if (visited.has(value)) return undefined
          visited.add(value)
          for (const [key, nested] of Object.entries(value)) {
            const nestedPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`
            const problem = uncloneablePath(nested, nestedPath)
            if (problem) return problem
          }
        }
        return path
      }
    }
    throw new Error(
      `Scene-preset smoke state is not serializable at ${uncloneablePath(state, 'state') ?? 'state'}`
    )
  }
  // Validation never strips or rewrites diagnostics.
  return state
}

export const scenePresetStateReadCode = `return (${readScenePresetState.toString()})()`
