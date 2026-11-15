import type { LayoutSettings } from '@/lib/backend'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Green screen in reach: the camera's chroma key had one home, the last
// section of the camera's inspector on the Scene page, and nothing else
// named it. The Studio's Camera row now turns it on and off and opens its
// settings, and ⌘K finds it by the words people use for it. The settings
// (colour, similarity, smoothness, spill, edges) stay on the Scene page.

// The two real-world screen colours; the protocol takes any #RRGGBB, so a
// custom picker later needs no wire change.
export const CHROMA_KEY_GREEN = '#00FF00'
export const CHROMA_KEY_BLUE = '#0000FF'

export type GreenScreenColor = 'green' | 'blue'

/** What people type for the key, besides its name. */
export const GREEN_SCREEN_KEYWORDS: readonly string[] = [
  'green screen',
  'greenscreen',
  'blue screen',
  'bluescreen',
  'chroma',
  'chroma key',
  'key out',
  'remove background',
  'background removal',
  'transparent background'
]

type KeyLayout = Pick<LayoutSettings, 'cameraChromaKeyEnabled' | 'cameraChromaKeyColor'>

/** The key's colour. The stored hex may be either case. */
export function greenScreenColor(
  layout: Pick<LayoutSettings, 'cameraChromaKeyColor'>
): GreenScreenColor {
  return layout.cameraChromaKeyColor.toUpperCase() === CHROMA_KEY_BLUE ? 'blue' : 'green'
}

export function chromaKeyHex(color: GreenScreenColor): string {
  return color === 'blue' ? CHROMA_KEY_BLUE : CHROMA_KEY_GREEN
}

/** The control's name: "Blue screen" once a blue key is on, else "Green screen". */
export function greenScreenLabel(layout: KeyLayout): string {
  return layout.cameraChromaKeyEnabled && greenScreenColor(layout) === 'blue'
    ? 'Blue screen'
    : 'Green screen'
}

/** ⌘K's words for the switch, by what it will do. */
export function greenScreenCommandLabel(layout: KeyLayout): string {
  return layout.cameraChromaKeyEnabled
    ? `Turn off ${greenScreenLabel(layout).toLowerCase()}`
    : 'Turn on green screen'
}

export const GREEN_SCREEN_SETTINGS_LABEL = 'Green screen settings'

// The Scene page mounts only while it is open, so a request to show the
// Green screen section waits here until the page reads it. A page that is
// already open hears the event instead.
export const SCENE_GREEN_SCREEN_EVENT = 'videorc:scene-green-screen'

let greenScreenRequested = false

/** Asks the Scene page to select the camera and bring Green screen into view. */
export function requestSceneGreenScreen(): void {
  greenScreenRequested = true
  window.dispatchEvent(new CustomEvent(SCENE_GREEN_SCREEN_EVENT))
}

/** Opens the Scene page on the camera, with Green screen in view. */
export function openSceneGreenScreen(): void {
  requestSceneGreenScreen()
  openWorkspaceTab('layouts')
}

/** True once per request: the Scene page takes it and the request is gone. */
export function takeSceneGreenScreenRequest(): boolean {
  const requested = greenScreenRequested
  greenScreenRequested = false
  return requested
}
