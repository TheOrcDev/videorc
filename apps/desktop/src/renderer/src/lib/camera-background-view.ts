import {
  CAMERA_BACKGROUND_SLIGHT_BLUR_PCT,
  CAMERA_BACKGROUND_STRONG_BLUR_PCT,
  type CameraBackground,
  type CameraBackgroundKey,
  type CameraBackgroundStatus
} from '../../../shared/backend'
import { DEFAULT_CAMERA_BACKGROUND, normalizeCameraBackground } from './camera-background'

// Plan 258 S5: the words and the rules of the camera's Background control,
// one module for every place it shows (the Studio's Camera row and its
// Retro LCD twin, the Scene page's Background section, ⌘K and the room).
// Pure, so each rule has a table test; the components only draw it. Only
// lazy chunks import it: the launch bundle carries just the output boundary
// (lib/camera-background.ts), within the renderer asset budget.

/**
 * An effect the camera effect stage draws (a blur, a picture, a video, Cut
 * out), as opposed to Off or a screen key. The privacy rules (D2, D6) and
 * the room's fail-closed rule (S5, before S8) apply to these.
 */
export function cameraBackgroundIsEffect(
  background: Pick<CameraBackground, 'mode'> | undefined | null
): boolean {
  return (
    background?.mode === 'blur' ||
    background?.mode === 'image' ||
    background?.mode === 'video' ||
    background?.mode === 'cutout'
  )
}

/** The selected camera's background, Off with Strong blur ready when it has none. */
export function cameraBackgroundFor(
  backgrounds: Record<string, CameraBackground> | undefined,
  cameraId: string | undefined
): CameraBackground {
  return (
    normalizeCameraBackground(cameraId ? backgrounds?.[cameraId] : undefined) ??
    DEFAULT_CAMERA_BACKGROUND
  )
}

/** The tile a pick lights up. A picture is its asset's id. */
export type CameraBackgroundChoiceId =
  | 'off'
  | 'slight-blur'
  | 'strong-blur'
  | 'green'
  | 'blue'
  | `image:${string}`

export type CameraBackgroundGroup = 'blur' | 'images' | 'screens'

/** The groups in the order the popover and the Scene page show them. */
export const CAMERA_BACKGROUND_GROUP_LABELS: Record<CameraBackgroundGroup, string> = {
  blur: 'Blur',
  images: 'Images',
  screens: 'Screen behind you'
}

/** One picture behind you, from the Images library (a background asset). */
export type CameraBackgroundImage = { assetId: string; name: string; picture?: string }

export type CameraBackgroundChoice = {
  id: CameraBackgroundChoiceId
  group: CameraBackgroundGroup
  label: string
  /** A picture's file, for its tile. */
  picture?: string
  /** Why it can't be picked now; null while it can. */
  disabledReason: string | null
}

/** Section, control and ⌘K words (docs/ui-copy.md voice). */
export const CAMERA_BACKGROUND_LABEL = 'Background'
export const CAMERA_BACKGROUND_SETTINGS_LABEL = 'Background settings'
export const CHOOSE_IMAGE_LABEL = 'Choose image…'
export const BLUR_STRENGTH_LABEL = 'Blur strength'
export const WHAT_VIEWERS_SEE_LABEL = 'What viewers see'
export const CAMERA_BACKGROUND_LOCK_LINE = 'Done on this Mac, before anything is recorded or sent.'
export const CAMERA_BACKGROUND_DESCRIPTION =
  "Blurs or replaces what's behind you in the recording, the livestream, Clips, Videorc Camera and the room. This camera keeps it in every scene."
export const CAMERA_BACKGROUND_HINT =
  'Works best with light on your face. Done on this Mac, before anything is recorded or sent.'
/**
 * The plan's blur caveat (UX copy), said wherever a blur is picked: only
 * Strong blur and a picture passed S3's leak smoke, and Slight blur leaves
 * the room easy to make out. A blur never promises the room is gone.
 */
export const CAMERA_BACKGROUND_BLUR_CAVEAT =
  'A blur can still show large shapes and colors behind you. For full privacy, pick a picture.'
export const CAMERA_BACKGROUND_SCREEN_HINT = 'Needs an evenly lit green or blue screen behind you.'
export const CAMERA_BACKGROUND_NO_CAMERA = 'Choose a camera first.'

/**
 * Plan 258 S5, rooms before S8: the room can't apply an effect yet, so
 * while one is open the effect choices are disabled with this reason (Off,
 * Green screen and Blue screen stay), and a room opened with an effect on
 * publishes no camera.
 */
export const ROOM_BACKGROUND_UNAVAILABLE = 'Background effects come to rooms in a later update.'
/** The Show stage's line when the room keeps the camera off for that reason. */
export const ROOM_CAMERA_OFF_FOR_BACKGROUND =
  'Background effects come to rooms in a later update, so your camera is off in the room. Turn off the background effect to show it.'

/** D13: the stage runs on macOS first; S10 and S11 bring Windows and Linux. */
export function platformBackgroundReason(platform: string | undefined): string | null {
  if (platform === 'win32') return 'Background effects come to Windows in a later update.'
  if (platform === 'linux') return 'Background effects come to Linux in a later update.'
  return null
}

const SLIGHT = CAMERA_BACKGROUND_SLIGHT_BLUR_PCT
const STRONG = CAMERA_BACKGROUND_STRONG_BLUR_PCT

/** The blur tile a strength lights: the nearer of Slight and Strong. */
function blurChoice(blurPct: number): 'slight-blur' | 'strong-blur' {
  return blurPct <= (SLIGHT + STRONG) / 2 ? 'slight-blur' : 'strong-blur'
}

/** The tile the camera's background lights, or null for one no tile shows (video, Cut out). */
export function cameraBackgroundChoiceId(
  background: CameraBackground
): CameraBackgroundChoiceId | null {
  switch (background.mode) {
    case 'off':
      return 'off'
    case 'blur':
      return blurChoice(background.blurPct)
    case 'image':
      return background.assetId ? `image:${background.assetId}` : null
    case 'green':
    case 'blue':
      return background.mode
    default:
      return null
  }
}

/**
 * The background a pick makes. Off keeps everything else (so Blur or a
 * screen finds its tuning again); a screen keeps its key; Slight and Strong
 * set the strength at their marks.
 */
export function cameraBackgroundForChoice(
  current: CameraBackground,
  choice: CameraBackgroundChoiceId
): CameraBackground {
  switch (choice) {
    case 'off':
      return { ...current, mode: 'off' }
    case 'slight-blur':
      return { ...current, mode: 'blur', blurPct: SLIGHT }
    case 'strong-blur':
      return { ...current, mode: 'blur', blurPct: STRONG }
    case 'green':
    case 'blue':
      return { ...current, mode: choice }
    default:
      return { ...current, mode: 'image', assetId: choice.slice('image:'.length) }
  }
}

/** The pick in words: the trigger's value and ⌘K's context. */
export function cameraBackgroundValueLabel(
  background: CameraBackground,
  images: readonly CameraBackgroundImage[] = []
): string {
  switch (background.mode) {
    case 'off':
      return 'Off'
    case 'blur':
      if (background.blurPct === SLIGHT) return 'Slight blur'
      if (background.blurPct === STRONG) return 'Strong blur'
      return `Blur ${background.blurPct}%`
    case 'image':
      return images.find((image) => image.assetId === background.assetId)?.name ?? 'Picture'
    case 'video':
      return 'Video'
    case 'cutout':
      return 'Cut out'
    case 'green':
      return 'Green screen'
    case 'blue':
      return 'Blue screen'
  }
}

/**
 * Every tile, grouped, with why one can't be picked now. Effects (a blur, a
 * picture) wait for the platform's stage and, before S8, for a closed room;
 * Off and the two screens always stay. With no camera nothing can be picked.
 * `images` is the Images library (the picked one first is the caller's
 * business; `imageLimit` keeps the popover to a row).
 */
export function cameraBackgroundChoices(input: {
  images: readonly CameraBackgroundImage[]
  cameraSelected: boolean
  roomOpen: boolean
  platform: string | undefined
  imageLimit?: number
}): CameraBackgroundChoice[] {
  const effectReason = !input.cameraSelected
    ? CAMERA_BACKGROUND_NO_CAMERA
    : (platformBackgroundReason(input.platform) ??
      (input.roomOpen ? ROOM_BACKGROUND_UNAVAILABLE : null))
  const anyReason = input.cameraSelected ? null : CAMERA_BACKGROUND_NO_CAMERA
  const images =
    input.imageLimit === undefined ? input.images : input.images.slice(0, input.imageLimit)
  return [
    { id: 'off', group: 'blur', label: 'Off', disabledReason: anyReason },
    { id: 'slight-blur', group: 'blur', label: 'Slight blur', disabledReason: effectReason },
    { id: 'strong-blur', group: 'blur', label: 'Strong blur', disabledReason: effectReason },
    ...images.map(
      (image): CameraBackgroundChoice => ({
        id: `image:${image.assetId}`,
        group: 'images',
        label: image.name,
        ...(image.picture ? { picture: image.picture } : {}),
        disabledReason: effectReason
      })
    ),
    { id: 'green', group: 'screens', label: 'Green screen', disabledReason: anyReason },
    { id: 'blue', group: 'screens', label: 'Blue screen', disabledReason: anyReason }
  ]
}

/**
 * The pictures for the popover's row: the picked one first, then the rest
 * in library order, so the pick never hides behind Choose image….
 */
export function imagesPickedFirst(
  images: readonly CameraBackgroundImage[],
  pickedAssetId: string | undefined
): CameraBackgroundImage[] {
  const picked = images.find((image) => image.assetId === pickedAssetId)
  return picked ? [picked, ...images.filter((image) => image !== picked)] : [...images]
}

/** How long the cover stands in before the Studio says so (D6, mockup §3). */
export const COVER_LINE_AFTER_MS = 2000

export type CameraBackgroundStageLine = { tone: 'warning'; text: string }

/**
 * The stage's line under the Camera row, never a toast (mockup §3): the
 * cover after 2 s, or a stage that can't run here. Either way viewers see
 * the cover, never the room, and the line says what they see. Null while
 * it runs (or for Off and a screen, which have no stage).
 */
export function cameraBackgroundStageLine(
  status: CameraBackgroundStatus | undefined
): CameraBackgroundStageLine | null {
  if (!status || !cameraBackgroundIsEffect(status)) return null
  const sees =
    status.mode === 'blur'
      ? 'Viewers see your whole camera blurred'
      : status.mode === 'cutout'
        ? 'Viewers see your scene without you'
        : 'Viewers see only your picture'
  if (status.state === 'unavailable')
    return {
      tone: 'warning',
      text: `Background effects can't run on this Mac right now. ${sees} until you turn the effect off.`
    }
  if (status.state === 'cover' && (status.coverForMs ?? 0) >= COVER_LINE_AFTER_MS)
    return { tone: 'warning', text: `Background is catching up. ${sees} until it's back.` }
  return null
}

/** ⌘K's quick command for the camera's background, by state (plan 258 UX). */
export function cameraBackgroundCommand(background: CameraBackground): {
  label: string
  next: CameraBackgroundChoiceId
} {
  return cameraBackgroundIsEffect(background)
    ? { label: 'Turn off background effect', next: 'off' }
    : { label: 'Blur background', next: 'strong-blur' }
}

/** What people type for the background, besides the green-screen words. */
export const CAMERA_BACKGROUND_KEYWORDS: readonly string[] = [
  'background',
  'blur',
  'background blur',
  'blur background',
  'virtual background',
  'replace background',
  'background image',
  'privacy'
]

/** A screen's tuning, with the scene key's defaults for a camera that never had one. */
export function cameraBackgroundKeyOf(background: CameraBackground): CameraBackgroundKey {
  return background.key ?? { similarityPct: 40, smoothnessPct: 8, spillPct: 10 }
}
