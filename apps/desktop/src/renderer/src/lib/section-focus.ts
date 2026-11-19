// Plan 250 S4: a door to one section of a page. An entry's "Open Audio"
// opens the Studio and asks its Audio group to bring itself into view: a
// request the section takes when it mounts, and an event for a page that is
// already open. The pattern of `cloud-section-focus.ts`, for many sections.
//
// No imports: sections import this, and anything heavier would pull the app
// shell into a page's import graph.

export type SectionFocusId =
  | 'studio-audio'
  | 'sources-microphone'
  | 'sources-system-audio'
  | 'output-recordings'
  | 'output-clips'
  | 'output-videorc-camera'
  | 'settings-notifications'
  | 'destinations-cloud'

export const SECTION_FOCUS_EVENT = 'videorc:section-focus'

/** A request nobody took (the page never opened) goes stale after this. */
export const SECTION_FOCUS_TTL_MS = 5_000

const pending = new Map<SectionFocusId, number>()

export function requestSectionFocus(id: SectionFocusId, now: number = Date.now()): void {
  pending.set(id, now)
  globalThis.dispatchEvent?.(new CustomEvent<SectionFocusId>(SECTION_FOCUS_EVENT, { detail: id }))
}

/** True once per request: the section that takes it scrolls itself into view. */
export function takeSectionFocus(id: SectionFocusId, now: number = Date.now()): boolean {
  const at = pending.get(id)
  if (at === undefined) return false
  pending.delete(id)
  return now - at < SECTION_FOCUS_TTL_MS
}

/** The attribute a section's root carries, so its request can find it. */
export const SECTION_FOCUS_ATTRIBUTE = 'data-section-focus'
