import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Plan 231 D8: Studio's Scenes section is the home of scenes. ⌘K's "Add
// scene…" (D14) opens the picker there, and Sources' "Open Scenes" (S8)
// brings the section into view. The section mounts with the Studio, so a
// request waits here until it reads it; a section already mounted hears the
// event instead (the Green screen request's pattern).
export const SCENES_REQUEST_EVENT = 'videorc:scenes-request'

/** `add`: open Add scene…; `show`: scroll the section into view. */
export type ScenesRequest = 'add' | 'show'

let pending: ScenesRequest | null = null

function request(kind: ScenesRequest): void {
  pending = kind
  window.dispatchEvent(new CustomEvent(SCENES_REQUEST_EVENT))
  openWorkspaceTab('studio')
}

/** Opens Studio with Add scene… open. */
export function openAddScene(): void {
  request('add')
}

/** Opens Studio at its Scenes section. */
export function openScenes(): void {
  request('show')
}

/** The request once: the Scenes section takes it and it is gone. */
export function takeScenesRequest(): ScenesRequest | null {
  const taken = pending
  pending = null
  return taken
}
