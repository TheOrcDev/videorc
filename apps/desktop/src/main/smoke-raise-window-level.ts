/**
 * The level a smoke's `raise-window` lifts a window to.
 *
 * `floating` (the default) is Keep on top's own level, one above the glass
 * probe's backdrop. `screen-saver` is for the invisibility smokes
 * (plan 215 C5): their motion stimulus is a native NSPanel at
 * `.screenSaver` (level 1000), above every floating window, so a window
 * that must be captured has to sit one level higher still or the recording
 * can never show it and a hidden phase proves nothing.
 */
export type SmokeRaiseWindowLevel = 'floating' | 'screen-saver'

export interface SmokeRaiseWindowPlacement {
  level: SmokeRaiseWindowLevel
  relativeLevel: number
}

export function smokeRaiseWindowPlacement(level: unknown): SmokeRaiseWindowPlacement {
  if (level === 'screen-saver') {
    return { level: 'screen-saver', relativeLevel: 1 }
  }
  if (level === undefined || level === 'floating') {
    return { level: 'floating', relativeLevel: 1 }
  }
  throw new Error(`raise-window level must be "floating" or "screen-saver", got ${String(level)}`)
}
