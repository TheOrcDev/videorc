import type { CameraBackgroundChoice } from '@/lib/camera-background-view'

// Plan 258 S5: what the camera looks like on stream with each Background
// pick, as data. `camera-background-orc-art.tsx` draws it (the Orc over the
// pick's room, blur, picture or screen colour) on the tiles, the popover's
// fallback and the Camera row's trigger; this module draws nothing, so the
// always-loaded Studio can name the pick without loading any picture.

export type CameraBackgroundArtKind =
  | { kind: 'room' }
  | { kind: 'blur'; strength: 'slight' | 'strong' }
  | { kind: 'picture'; src: string }
  | { kind: 'screen'; color: 'green' | 'blue' }

/** The picture a tile shows: what the camera looks like on stream with that pick. */
export function choiceArt(
  choice: Pick<CameraBackgroundChoice, 'id' | 'picture'>
): CameraBackgroundArtKind {
  switch (choice.id) {
    case 'off':
      return { kind: 'room' }
    case 'slight-blur':
      return { kind: 'blur', strength: 'slight' }
    case 'strong-blur':
      return { kind: 'blur', strength: 'strong' }
    case 'green':
    case 'blue':
      return { kind: 'screen', color: choice.id }
    default:
      return choice.picture ? { kind: 'picture', src: choice.picture } : { kind: 'room' }
  }
}
