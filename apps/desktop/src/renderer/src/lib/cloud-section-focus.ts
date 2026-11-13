// Plan 222 U1: "Open Livestream" on the "Videorc Cloud is on" notice asks
// the Livestream page's Videorc Cloud section to scroll into view. No
// imports: the section imports this, and anything heavier pulls the app
// shell into the Livestream page's import graph (a cycle the dev server's
// ESM turns into "Cannot access 'lazy' before initialization").

/**
 * The notice's action asks the Livestream page to bring its Videorc Cloud
 * section into view: a flag the section takes when it mounts, and an event
 * for a page that is already open.
 */
export const CLOUD_SECTION_FOCUS_EVENT = 'videorc:cloud-section-focus'
let cloudSectionFocusPending = false

export function requestCloudSectionFocus(): void {
  cloudSectionFocusPending = true
  globalThis.dispatchEvent?.(new Event(CLOUD_SECTION_FOCUS_EVENT))
}

/** True once per request: the section that takes it scrolls itself into view. */
export function takeCloudSectionFocus(): boolean {
  const pending = cloudSectionFocusPending
  cloudSectionFocusPending = false
  return pending
}
