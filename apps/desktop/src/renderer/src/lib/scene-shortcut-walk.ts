import type { SceneAppState } from './scene-window-resolution'

/** Library order only. Unavailable scenes retain their place and are skipped. */
export function nextEligibleScene(input: {
  current: string
  direction: 1 | -1
  scenes: readonly { id: string }[]
  appStates: Readonly<Record<string, SceneAppState | undefined>>
  unavailableSceneIds?: readonly string[]
}): string | null {
  const { scenes, appStates, current, direction } = input
  const catalog = scenes.map(({ id }) => `scene:${id}`)
  const eligible = new Set(
    scenes
      .filter(
        (scene) =>
          !input.unavailableSceneIds?.includes(scene.id) &&
          (!appStates[scene.id] || appStates[scene.id] === 'ready')
      )
      .map((scene) => `scene:${scene.id}`)
  )
  const index = catalog.indexOf(current)
  for (let step = 1; step <= catalog.length; step++) {
    const candidate =
      catalog[
        ((index < 0 ? (direction === 1 ? -1 : 0) : index) + direction * step + catalog.length) %
          catalog.length
      ]
    if (candidate !== current && eligible.has(candidate)) return candidate
  }
  return null
}
