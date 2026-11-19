// Plan 222 U1: "Open Destinations" on the "Videorc Cloud is on" notice asks
// the Destinations page's Videorc Cloud section to scroll into view. Since
// plan 250 S4 it is one caller of `section-focus.ts`, which does the same
// for every section a notification can point at. Still no heavy imports:
// the section imports this, and anything heavier pulls the app shell into
// the Destinations page's import graph (a cycle the dev server's ESM turns
// into "Cannot access 'lazy' before initialization").

import { requestSectionFocus, SECTION_FOCUS_EVENT, takeSectionFocus } from './section-focus'

/**
 * The notice's action asks the Destinations page to bring its Videorc Cloud
 * section into view: a request the section takes when it mounts, and an
 * event for a page that is already open.
 */
export const CLOUD_SECTION_FOCUS_EVENT = SECTION_FOCUS_EVENT

export function requestCloudSectionFocus(): void {
  requestSectionFocus('destinations-cloud')
}

/** True once per request: the section that takes it scrolls itself into view. */
export function takeCloudSectionFocus(): boolean {
  return takeSectionFocus('destinations-cloud')
}
