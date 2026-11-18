// What a person's tile and strip thumbnail show when their camera is off
// (wire contract 5.5, decision 75): camera off is a muted camera
// publication, and it is not away. The tile stays where the layout puts
// it and draws the camera-off look, the same one the program page draws
// for viewers: the tile's ground, a circle with the name's first letter,
// and the name plate as it is. No frame of theirs shows, and "Back in a
// moment" is never drawn over someone whose camera is off.
//
// Pure, so the choice has unit tests (talk-show-tile.test.ts).

import type { CloudHostShape } from '@/lib/backend'
import type { StageTile } from '@/lib/talk-show-layout'

export type CameraPicture = {
  /** The track to draw, or null: the camera is off, or there is none. */
  track: MediaStreamTrack | null
  cameraOff: boolean
}

/** A person's camera as a tile or thumbnail shows it. */
export function cameraPicture(
  video: MediaStreamTrack | null | undefined,
  cameraOff: boolean | undefined
): CameraPicture {
  const off = cameraOff === true
  return { track: off ? null : (video ?? null), cameraOff: off }
}

/** Whether the away plate shows: never over someone whose camera is off. */
export function showsAway(away: boolean | undefined, cameraOff: boolean): boolean {
  return away === true && !cameraOff
}

/**
 * The letter the camera-off look shows: the name's first character, in
 * capitals; "?" for an empty name. The program page shows the same letter.
 */
export function nameInitial(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? '?' : first.toLocaleUpperCase('en')
}

/** The circle's diameter, as a share of the tile's short side (the page's). */
export const CAMERA_OFF_CIRCLE = 0.36
/** The letter's size, as a share of the circle (the page's). */
export const CAMERA_OFF_INITIAL = 0.5

/** The camera-off look for a tile of `w`×`h` canvas pixels: in those pixels. */
export function cameraOffLook(w: number, h: number): { diameter: number; fontPx: number } {
  const diameter = Math.max(2, Math.round(Math.min(w, h) * CAMERA_OFF_CIRCLE))
  return { diameter, fontPx: Math.max(8, Math.round(diameter * CAMERA_OFF_INITIAL)) }
}

/**
 * The host's circle (plan 247 D-2): the program page clips the host's own
 * person tile to the circle inscribed in it when the stage says
 * `hostShape: 'circle'` and the tile has corners, so never in Solo
 * (`stage-view.ts` on the web). The app's stage copies the stream.
 */
export function hostCircle(
  tile: Pick<StageTile, 'identity' | 'kind' | 'cornerRadius'>,
  hostIdentity: string | null,
  hostShape: CloudHostShape | undefined
): boolean {
  return (
    tile.kind === 'person' &&
    tile.identity === hostIdentity &&
    hostShape === 'circle' &&
    tile.cornerRadius > 0
  )
}

/** The circle inscribed in the tile, centred, as the program page clips it. */
export const HOST_CIRCLE_CLIP = 'circle(closest-side at 50% 50%)'
