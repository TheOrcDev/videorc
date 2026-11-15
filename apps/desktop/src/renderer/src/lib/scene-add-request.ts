import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Plan 231 D14: ⌘K's "Add scene…" opens the picker in Studio's Scenes
// section, the home of scenes (D8). The section mounts with the Studio, so
// a request waits here until it reads it; a section already mounted hears
// the event instead (the Green screen request's pattern).
export const ADD_SCENE_EVENT = 'videorc:add-scene'

let addSceneRequested = false

/** Opens Studio with Add scene… open. */
export function openAddScene(): void {
  addSceneRequested = true
  window.dispatchEvent(new CustomEvent(ADD_SCENE_EVENT))
  openWorkspaceTab('studio')
}

/** True once per request: the Scenes section takes it and the request is gone. */
export function takeAddSceneRequest(): boolean {
  const requested = addSceneRequested
  addSceneRequested = false
  return requested
}
