/**
 * Plan 260 S2.5 (from plan 220 S3.0b): where an Electron smoke selector and the GPUI app's
 * element differ, this one table says which GPUI element it is.
 *
 * The UI driver (`ui-driver.mjs`) takes selectors in two forms:
 *
 * - an accessible name, `{ name, role? }`: the words a screen reader says,
 *   the same in both apps (Record, Go Live…, a field's label). It needs no
 *   entry here.
 * - a CSS selector string, the `data-videorc-*` hooks the Electron smokes use
 *   today (`[data-videorc-session-status]`). Electron runs it as it is; the
 *   GPUI app has no DOM, so the string must have a row below naming the GPUI
 *   element by the `ui-*` commands' selector (`label`, `role`, `id`, `value`,
 *   `within`; see `apps/videorc/src/smoke/`, once S2.5 lands it).
 *
 * A screen slice that moves a smoke onto the driver adds its rows here. The
 * test (`ui-driver.test.mjs`) checks that every Electron selector below still
 * exists in the renderer and that every GPUI label and id still exists in the
 * GPUI UI, so a rename on either side fails `pnpm test:scripts` instead of a
 * smoke on a live app.
 */

/**
 * `{ electron, gpui, slice }` rows; `slice` is the one that ported the element.
 * Empty until the GPUI app exists (plan 260 S2.1): each screen slice adds the
 * rows for the smokes it moves onto the driver.
 */
export const UI_DRIVER_MAP = Object.freeze([])

/** Thrown when a smoke drives the GPUI app with a CSS selector the map lacks. */
export class UiDriverSelectorError extends Error {
  constructor(selector) {
    super(
      `The GPUI app has no DOM: ${JSON.stringify(selector)} needs a row in scripts/lib/ui-driver-map.mjs naming the GPUI element (or use an accessible name, { name, role }).`
    )
    this.name = 'UiDriverSelectorError'
  }
}

/** The GPUI selector a CSS selector maps to; throws by name when it has no row. */
export function gpuiSelectorFor(css) {
  const row = UI_DRIVER_MAP.find((entry) => entry.electron === css)
  if (!row) throw new UiDriverSelectorError(css)
  return { ...row.gpui }
}

/**
 * The attribute hooks a CSS selector names, as `[{ attribute, value }]`
 * (`value` is null for a bare `[data-videorc-x]`). Only the `data-videorc-*`
 * attribute selectors the map uses are understood.
 */
export function selectorHooks(css) {
  const hooks = []
  for (const match of css.matchAll(/\[(data-videorc-[a-z0-9-]+)(?:="([^"]*)")?\]/g)) {
    hooks.push({ attribute: match[1], value: match[2] ?? null })
  }
  return hooks
}
