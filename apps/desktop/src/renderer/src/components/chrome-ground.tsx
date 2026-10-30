import { useSyncExternalStore, type ReactElement } from 'react'

// The S1 files at the repository root, never a copy that can drift (the
// phone remote serves the same files, plan 208 S6). `?no-inline`: a file,
// never a data URI in the eager bundle. A guard fails if any other module
// imports them.
import chromeGroundDark from '../../../../../../assets/backgrounds/chrome-ground-dark.webp?no-inline'
import chromeGroundLight from '../../../../../../assets/backgrounds/chrome-ground-light.webp?no-inline'

/** The ground image per theme: a 1280 × 720 frosted still of Liquid Chrome Polished. */
export const CHROME_GROUND_ASSETS = Object.freeze({
  dark: chromeGroundDark,
  light: chromeGroundLight
})

const subscribeNever = (): (() => void) => () => {}

/** What the theme bootstrap wrote on the root before the first paint: chrome, glass or solid. */
function groundSnapshot(): string {
  return document.documentElement.dataset.ground ?? ''
}

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/**
 * The display the window is on, in CSS px, never smaller than the viewport
 * (a window can be larger than its screen). One string, so the store snapshot
 * compares by value. It re-reads on resize: a window moved to another display
 * catches up on its next resize (plan 208, D11).
 */
function displaySizeSnapshot(): string {
  const width = Math.max(window.screen?.width ?? 0, window.innerWidth)
  const height = Math.max(window.screen?.height ?? 0, window.innerHeight)
  return `${width}x${height}`
}

/**
 * The chrome ground (plan 208, D1): the frosted still of Liquid Chrome every
 * window sits on, black with silver streaks in dark and its crisp invert in
 * light. Mounted once per window root (`WindowProviders`), under everything,
 * while the root says `data-ground="chrome"`; the VIDEORC_GLASS escape
 * hatches (clear glass, solid) leave it unmounted.
 *
 * - Sized to the display and centred on the window (D11): a resize shows
 *   more or less chrome and never rescales it. The 1280 × 720 still is
 *   blurred, so the upscale is invisible.
 * - Both themes' images stay mounted and the `.dark` class picks one, so a
 *   theme toggle swaps the ground in the same style pass as the coats:
 *   no frame shows the other theme's ground.
 * - The window coat is painted over the still here: the body paints the same
 *   coat, but as the canvas under this layer, where it only covers the first
 *   paint before the image decodes. The sidebar and the panes add their
 *   deltas above, so every region composites to exactly its cover.
 * - No CSS filter, transition, animation or backdrop-filter. Decoration only:
 *   hidden from assistive tech and from the pointer. styles.css hides it under
 *   `prefers-reduced-transparency` and while first-run setup is open.
 */
export function ChromeGround(): ReactElement | null {
  const ground = useSyncExternalStore(subscribeNever, groundSnapshot, () => '')
  const size = useSyncExternalStore(subscribeResize, displaySizeSnapshot, () => '0x0')
  if (ground !== 'chrome') {
    return null
  }
  const [width, height] = size.split('x').map(Number)
  const imageStyle = { width, height }
  const imageClass =
    'absolute top-1/2 left-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 object-cover'
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      data-chrome-ground=""
    >
      <img
        alt=""
        className={`${imageClass} dark:hidden`}
        data-chrome-ground-image="light"
        decoding="sync"
        draggable={false}
        src={CHROME_GROUND_ASSETS.light}
        style={imageStyle}
      />
      <img
        alt=""
        className={`${imageClass} hidden dark:block`}
        data-chrome-ground-image="dark"
        decoding="sync"
        draggable={false}
        src={CHROME_GROUND_ASSETS.dark}
        style={imageStyle}
      />
      <div className="absolute inset-0 bg-glass-window" data-chrome-ground-coat="" />
    </div>
  )
}
