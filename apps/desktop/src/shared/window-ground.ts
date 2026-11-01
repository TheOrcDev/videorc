// What a renderer window sits on (plan 208, S2). Main decides it per window
// in window-glass.ts and hands it to the renderer the same way the window
// learns its role: a BrowserWindow `additionalArguments` entry the preload
// reads from `process.argv` before the first paint.
//
//   solid   the plain solid palette (the default, `VIDEORC_GLASS=0`, or a
//           platform that took no material): the coats over the solid base.
//   glass   the plan 091 clear glass or Windows Mica (`VIDEORC_GLASS=clear`,
//           the A/B control): the OS shows through.
//
// The plan 208 chrome ground (`chrome`) was removed on 2026-10-29.

export type WindowGround = 'glass' | 'solid'

export const WINDOW_GROUND_ARGUMENT_PREFIX = '--videorc-window-ground='

export function windowGroundArgument(ground: WindowGround): string {
  return `${WINDOW_GROUND_ARGUMENT_PREFIX}${ground}`
}

/** The ground main passed this renderer, or null when no argument names one. */
export function windowGroundFromArguments(arguments_: readonly string[]): WindowGround | null {
  // The final occurrence wins, like the renderer role: an inherited app CLI
  // argument must not pick a window's ground.
  for (let index = arguments_.length - 1; index >= 0; index -= 1) {
    const argument = arguments_[index]
    if (argument.startsWith(WINDOW_GROUND_ARGUMENT_PREFIX)) {
      const raw = argument.slice(WINDOW_GROUND_ARGUMENT_PREFIX.length)
      return raw === 'glass' || raw === 'solid' ? raw : null
    }
  }
  return null
}
