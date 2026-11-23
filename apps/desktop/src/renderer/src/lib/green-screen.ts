import type { LayoutSettings } from '@/lib/backend'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Green screen in reach: ⌘K finds the camera's key by the words people use
// for it. Since plan 258 S5 the key is two choices of the camera's one
// Background pick (Off, a blur, a picture, Green screen, Blue screen), kept
// per camera; the Studio's Camera row and the Scene page's Background
// section pick it, and the tuning stays on the Scene page.

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

// The Scene page mounts only while it is open, so a request to show the
// camera's Background section (plan 258 S5: it replaced Green screen in
// place) waits here until the page reads it. A page that is already open
// hears the event instead.
export const SCENE_BACKGROUND_EVENT = 'videorc:scene-camera-background'

let backgroundRequested = false

/** Asks the Scene page to select the camera and bring Background into view. */
export function requestSceneBackground(): void {
  backgroundRequested = true
  window.dispatchEvent(new CustomEvent(SCENE_BACKGROUND_EVENT))
}

/** Opens the Scene page on the camera, with its Background section in view (the home). */
export function openSceneBackground(): void {
  requestSceneBackground()
  openWorkspaceTab('layouts')
}

/** True once per request: the Scene page takes it and the request is gone. */
export function takeSceneBackgroundRequest(): boolean {
  const requested = backgroundRequested
  backgroundRequested = false
  return requested
}
