import type { Scene } from '@/lib/backend'

// Plan 215 D4: one "Edit scene" action behind every door (Studio's Scenes
// gallery, the Scene page, ⌘K). Each opens the Scene page with the editor on
// and the camera selected, as a click on the camera on the canvas does.

export const EDIT_SCENE_LABEL = 'Edit scene'

/** The source Edit scene selects: the camera, else the first one that can move. */
export function sceneEditTarget(scene: Pick<Scene, 'sources'> | null): string | null {
  const editable = scene?.sources.filter((source) => !source.locked) ?? []
  return (editable.find((source) => source.kind === 'camera') ?? editable[0])?.id ?? null
}

export interface EditSceneDoor {
  scene: Pick<Scene, 'sources'> | null
  openScenePage: () => void
  selectBanner: (id: string | null) => void
  selectSource: (id: string) => void
  setEditMode: (on: boolean) => void
}

/** Opens the Scene page with the editor on and the camera selected. A banner
 *  selected from Assets gives the stage's one selection back to the source. */
export function editScene(door: EditSceneDoor): void {
  door.openScenePage()
  const target = sceneEditTarget(door.scene)
  if (target) {
    door.selectBanner(null)
    door.selectSource(target)
  }
  door.setEditMode(true)
}
