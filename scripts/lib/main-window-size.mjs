// The main window's size as a smoke asked for it, read back. A tiling window
// manager (Hyprland) can ignore `resize-window` and tile the window below the
// app's own minimum; a layout verdict measured there is about the window
// manager, not the app, so the smoke stops with the sizes instead.

// apps/desktop/src/main/index.ts: the main BrowserWindow's default and minimum.
export const MAIN_WINDOW_DEFAULT_SIZE = Object.freeze({ width: 1180, height: 780 })
export const MAIN_WINDOW_MINIMUM_SIZE = Object.freeze({ width: 960, height: 660 })
// A setBounds can land a couple of px off on Linux without a window manager
// (comments-window-probe: 1280 requested measured 1282).
export const MAIN_WINDOW_SIZE_TOLERANCE_PX = 4

/** `1180x780` (or `1180×780`) as `{ width, height }`; empty means `fallback`. */
export function parseWindowSize(text, fallback = MAIN_WINDOW_DEFAULT_SIZE) {
  if (text === undefined || text === null || String(text).trim() === '') return { ...fallback }
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(String(text))
  if (!match) throw new Error(`A window size is WIDTHxHEIGHT, like 1180x780; got ${text}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** `1180x780`, or `none` when a size is missing. */
export function formatWindowSize(size) {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return 'none'
  return `${Math.round(size.width)}x${Math.round(size.height)}`
}

/**
 * Whether the window the app is in is the one the smoke asked for. `bounds`
 * is the frame (`main-window-state`'s `bounds`, what `setSize` sets);
 * `viewport` is the renderer's `innerWidth`/`innerHeight`, named in the
 * message so a by-eye reader sees what the layout was measured at. The app
 * never sizes itself below its minimum (macOS clamps `setSize` to it), so a
 * smaller request means the minimum.
 */
export function mainWindowSizeVerdict({
  requested,
  bounds,
  viewport = null,
  minimum = MAIN_WINDOW_MINIMUM_SIZE,
  tolerance = MAIN_WINDOW_SIZE_TOLERANCE_PX
}) {
  const expected = {
    width: Math.max(requested.width, minimum.width),
    height: Math.max(requested.height, minimum.height)
  }
  const sizes = `asked for ${formatWindowSize(requested)}${
    expected.width !== requested.width || expected.height !== requested.height
      ? ` (the app's minimum makes that ${formatWindowSize(expected)})`
      : ''
  }, the window is ${formatWindowSize(bounds)} (viewport ${formatWindowSize(viewport)})`
  const environment =
    'This is the test environment, not a layout result: run it where the window manager ' +
    'applies the requested size (on Hyprland, float the Videorc window).'
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return { ok: false, expected, message: `The main window reported no size: ${sizes}.` }
  }
  if (bounds.width < minimum.width - tolerance || bounds.height < minimum.height - tolerance) {
    return {
      ok: false,
      expected,
      message: `The main window is below the app's ${formatWindowSize(minimum)} minimum: ${sizes}. ${environment}`
    }
  }
  if (
    Math.abs(bounds.width - expected.width) > tolerance ||
    Math.abs(bounds.height - expected.height) > tolerance
  ) {
    return {
      ok: false,
      expected,
      message: `The window manager did not apply the requested main window size: ${sizes}. ${environment}`
    }
  }
  return { ok: true, expected, message: null }
}

/**
 * A message when the renderer's viewport changed between two measurements
 * that are compared (a window manager re-tiling the window mid-run), or null.
 */
export function viewportChange(before, after, tolerance = 0.5) {
  if (!before || !after) return null
  if (
    Math.abs(before.width - after.width) <= tolerance &&
    Math.abs(before.height - after.height) <= tolerance
  ) {
    return null
  }
  return `The main window's viewport changed from ${formatWindowSize(before)} to ${formatWindowSize(after)} between the two measurements, so they cannot be compared. This is the test environment, not a layout result.`
}
