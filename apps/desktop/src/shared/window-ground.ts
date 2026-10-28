// What a renderer window sits on (plan 208, S2). Main decides it per window
// in window-glass.ts and hands it to the renderer the same way the window
// learns its role: a BrowserWindow `additionalArguments` entry the preload
// reads from `process.argv` before the first paint, so `ChromeGround` never
// waits for an IPC round trip and never pops in.
//
//   chrome  the opaque chrome ground (the default): the window's backing is
//           the theme's solid base and the renderer paints the frosted
//           Liquid Chrome still under its coats.
//   glass   the plan 091 clear glass or Windows Mica (`VIDEORC_GLASS=clear`,
//           the one-release A/B control): the OS shows through, no ground.
//   solid   the plain solid palette (`VIDEORC_GLASS=0`, or a platform that
//           took no material): no ground, the coats over the solid base.

export type WindowGround = 'chrome' | 'glass' | 'solid'

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
      return raw === 'chrome' || raw === 'glass' || raw === 'solid' ? raw : null
    }
  }
  return null
}
