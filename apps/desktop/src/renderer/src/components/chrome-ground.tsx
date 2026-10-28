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

/**
 * The ground's drift (owner, 2026-10-28: "move a little bit, just slightly",
 * then "clear but calm"; tuned live with the owner watching, because under the
 * coats 10 and then 40 px could not be seen). The same still, no second image
 * and no shader: it sways up to 120 px across and 84 px down along two sines
 * whose periods share no factor, so it never visibly loops. Translation only:
 * a changing scale would make the compositor re-raster the still, a slide
 * only moves its layer. The stills overhang the window by `marginPx`, more
 * than the largest offset, so no edge ever shows. At 20 updates a second each
 * step is under 2 px on a σ 24 blur: smooth to the eye.
 */
export const CHROME_GROUND_DRIFT = Object.freeze({
  tickMs: 50,
  marginPx: 128,
  amplitudePx: Object.freeze({ x: 120, y: 84 }),
  periodS: Object.freeze({ x: 25, y: 33 })
})

/** Where the drift is after `seconds` of running, in px from the centre. */
export function chromeGroundDriftAt(seconds: number): { x: number; y: number } {
  const { amplitudePx, periodS } = CHROME_GROUND_DRIFT
  const wave = (period: number): number => Math.sin((2 * Math.PI * seconds) / period)
  return { x: amplitudePx.x * wave(periodS.x), y: amplitudePx.y * wave(periodS.y) }
}

/**
 * The drift layer's transform. Moving, a 3D translate gives it its own
 * compositor layer, so a step costs no paint; paused, a 2D translate at the
 * same place hands the layer back, so a still window holds no extra GPU
 * memory.
 */
export function chromeGroundTransform(seconds: number, moving: boolean): string {
  const { x, y } = chromeGroundDriftAt(seconds)
  return moving
    ? `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
    : `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
}

/**
 * Runs the drift whenever the window is on screen (owner, 2026-10-28), even
 * with another app focused. It pauses where it is while the window is
 * minimised or hidden, while a recording or livestream runs (main's
 * `session:take-running`; a Clips-only ring is no take), and under Reduce
 * Motion. The main window keeps the Page Visibility API frozen (no
 * background throttling), so main says when it is minimised or hidden
 * (`window:visible`); the other windows' documents report it themselves.
 *
 * A 50 ms timer rather than a per-frame callback: the compositor draws 20
 * frames a second, not one per display refresh, and each changes only the
 * transform of a composited layer (no layout, no paint). Its clock advances
 * only while it runs, so it resumes without a jump. The layer says
 * `data-chrome-ground-drift="moving|paused"` (probe:ui-glass holds Reduce
 * Motion so its shots compare like with like).
 */
function startChromeGroundDrift(node: HTMLDivElement): () => void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let windowVisible = true
  let takeRunning = false
  let runningMs = 0
  let lastTick = 0
  let timer: number | undefined
  const tick = (): void => {
    const now = performance.now()
    runningMs += now - lastTick
    lastTick = now
    node.style.transform = chromeGroundTransform(runningMs / 1000, true)
  }
  const update = (): void => {
    const run =
      windowVisible &&
      document.visibilityState === 'visible' &&
      !takeRunning &&
      !reducedMotion.matches
    node.dataset.chromeGroundDrift = run ? 'moving' : 'paused'
    node.style.transform = chromeGroundTransform(runningMs / 1000, run)
    if (run && timer === undefined) {
      lastTick = performance.now()
      timer = window.setInterval(tick, CHROME_GROUND_DRIFT.tickMs)
    } else if (!run && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
  update()
  document.addEventListener('visibilitychange', update)
  reducedMotion.addEventListener('change', update)
  const offWindowVisible = window.videorc?.onWindowVisible?.((visible) => {
    windowVisible = visible
    update()
  })
  const offTakeRunning = window.videorc?.onTakeRunning?.((running) => {
    takeRunning = running
    update()
  })
  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', update)
    reducedMotion.removeEventListener('change', update)
    offWindowVisible?.()
    offTakeRunning?.()
  }
}

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
 * - Sized to the display, plus the drift's margin, and centred on the window
 *   (D11): a resize shows more or less chrome and never rescales it. The
 *   1280 × 720 still is blurred, so the upscale is invisible.
 * - Both themes' images stay mounted and the `.dark` class picks one, so a
 *   theme toggle swaps the ground in the same style pass as the coats:
 *   no frame shows the other theme's ground.
 * - The window coat is painted over the still here: the body paints the same
 *   coat, but as the canvas under this layer, where it only covers the first
 *   paint before the image decodes. The sidebar and the panes add their
 *   deltas above, so every region composites to exactly its cover.
 * - Both stills sit in one drift layer (`startChromeGroundDrift`) under the
 *   coat, which stays put: the chrome slides slightly, the frosting does not.
 * - No CSS filter, transition, keyframes or backdrop-filter. Decoration only:
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
  // Display-sized, plus the margin on every side the drift slides into.
  const overhang = 2 * CHROME_GROUND_DRIFT.marginPx
  const imageStyle = { width: width + overhang, height: height + overhang }
  const imageClass =
    'absolute top-1/2 left-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 object-cover'
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      data-chrome-ground=""
    >
      {/* The drift layer: the window plus the margin, clipped there, so its
          compositor layer is never the size of the display. */}
      <div
        className="absolute overflow-hidden"
        ref={startChromeGroundDrift}
        style={{ inset: -CHROME_GROUND_DRIFT.marginPx }}
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
      </div>
      <div className="absolute inset-0 bg-glass-window" data-chrome-ground-coat="" />
    </div>
  )
}
