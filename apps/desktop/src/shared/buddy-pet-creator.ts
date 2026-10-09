// The Golem pet creator's wire (plan 168 S-F4), mirrored from
// `crates/videorc-backend/src/buddy_pet_create.rs`. A creation is a web build
// session plus a folder under the managed buddy root
// (`<personaId>/creations/<buildId>/`): `build-state.json`, the versioned
// sources (`sources/<sheet>-v<n>.png`) and the last build (`pack/`). The long
// calls answer at once and report by event.

/** One pitch row of the 5 x 5 gaze grid, top to bottom. */
export type BuddyPetGazeRow = 'up2' | 'up1' | 'level' | 'down1' | 'down2'
export const BUDDY_PET_GAZE_ROWS: readonly BuddyPetGazeRow[] = [
  'up2',
  'up1',
  'level',
  'down1',
  'down2'
]

/** A sheet kind as the web route names it (`row` rides with `gaze`). */
export type BuddyPetSheetKindName = 'pilot' | 'gaze' | 'reactions-a' | 'reactions-b' | 'extras'

/** A sheet as the creation folder and the events name it. */
export type BuddyPetSheetKey =
  | 'pilot'
  | `gaze-${BuddyPetGazeRow}`
  | 'reactions-a'
  | 'reactions-b'
  | 'extras'

export interface BuddyPetAtlasSheet {
  key: Exclude<BuddyPetSheetKey, 'pilot'>
  kind: Exclude<BuddyPetSheetKindName, 'pilot'>
  row?: BuddyPetGazeRow
}

/** The eight sheets of a pack, in atlas order (D18). */
export const BUDDY_PET_ATLAS_SHEETS: readonly BuddyPetAtlasSheet[] = [
  ...BUDDY_PET_GAZE_ROWS.map(
    (row): BuddyPetAtlasSheet => ({ key: `gaze-${row}`, kind: 'gaze', row })
  ),
  { key: 'reactions-a', kind: 'reactions-a' },
  { key: 'reactions-b', kind: 'reactions-b' },
  { key: 'extras', kind: 'extras' }
]

/** Every sheet key: the pilot, then the atlas sheets in atlas order. */
export const BUDDY_PET_SHEET_KEYS = [
  'pilot',
  'gaze-up2',
  'gaze-up1',
  'gaze-level',
  'gaze-down1',
  'gaze-down2',
  'reactions-a',
  'reactions-b',
  'extras'
] as const satisfies readonly BuddyPetSheetKey[]

/** The identity notes (D19), as the web bounds them. */
export const BUDDY_PET_NOTES_LIST_MAX = 8
export const BUDDY_PET_NOTES_ITEM_MAX_CHARS = 60
export const BUDDY_PET_NOTES_PROPORTIONS_MAX_CHARS = 400
export const BUDDY_PET_NOTES_ASYMMETRIC_MAX = 12
export const BUDDY_PET_NOTES_FEATURE_MAX_CHARS = 80
/** A saved pack's name (the pack list's bound). */
export const BUDDY_PET_PACK_NAME_MAX_CHARS = 64
/** An upload is refused above this before it is decoded. */
export const BUDDY_PET_REFERENCE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024

export interface BuddyPetAsymmetry {
  feature: string
  /** The character's own (anatomical) side. */
  side: 'left' | 'right'
}

export interface BuddyPetIdentityNotes {
  palette: string[]
  materials: string[]
  proportions: string
  asymmetric: BuddyPetAsymmetry[]
}

/** The persona's idle image (the bundled default without one), or a picture
 * the user chose (PNG or WebP with transparency, base64). */
export type BuddyPetReference = { kind: 'persona-idle' } | { kind: 'upload'; imageBase64: string }

/** `cohost.pet.identity`. */
export interface CohostPetIdentityParams {
  buildId: string
  reference: BuddyPetReference
}

/** `cohost.pet.sheet.generate`. `notes` (corrected) rides with the pilot only. */
export interface CohostPetSheetGenerateParams {
  buildId: string
  kind: BuddyPetSheetKindName
  row?: BuddyPetGazeRow
  redo: boolean
  notes?: BuddyPetIdentityNotes
}

/** `cohost.pet.build` and `cohost.pet.creation.cancel`. */
export interface CohostPetBuildIdParams {
  buildId: string
}

/** `cohost.pet.save`. */
export interface CohostPetSaveParams {
  buildId: string
  name: string
}

/** An accepted job; the outcome is its event. */
export interface BuddyPetCreationAccepted {
  buildId: string
  sheet?: BuddyPetSheetKey
}

/** Derived from the data: no notes → `reference`; no accepted pilot →
 * `pilot`; until a build of the accepted sheets succeeds → `build`; then
 * `review`. */
export type BuddyPetCreationStep = 'reference' | 'pilot' | 'build' | 'review'

export interface BuddyPetCreationSource {
  /** `reference` or a sheet key. */
  sheet: string
  version: number
  /** Relative to the creation folder: `sources/<sheet>-v<version>.png`. */
  file: string
  sha256: string
  opaque: boolean
  referenceVersion?: number
  createdAt: string
}

/** Why a build failed, naming the sheet and cell when the builder did. */
export interface BuddyPetBuildFailure {
  code: string
  message: string
  sheet?: string
  cell?: string
}

export interface BuddyPetCreationBuild {
  state: 'built' | 'failed'
  /** Made from the sheets accepted now (a redo makes it stale). */
  fresh: boolean
  finishedAt: string
  error?: BuddyPetBuildFailure
}

export type BuddyPetCreatorJob = 'start' | 'identity' | 'sheet' | 'build' | 'save'

export interface BuddyPetCreationRunning {
  job: BuddyPetCreatorJob
  sheet?: string
}

export interface BuddyPetCreation {
  buildId: string
  step: BuddyPetCreationStep
  createdAt: string
  expiresAt: string
  /** Past `expiresAt`: generation is over; a build and a save still work. */
  expired: boolean
  sheetsAllowed: number
  redosAllowed: number
  pilotsAllowed: number
  sheetsRemaining: number
  redosRemaining: number
  pilotsUsed: number
  reference?: BuddyPetCreationSource
  notes?: BuddyPetIdentityNotes
  /** The latest pilot made from the current reference. */
  pilot?: BuddyPetCreationSource
  pilotAccepted: boolean
  /** The accepted version of each atlas sheet made so far, in atlas order. */
  sheets: BuddyPetCreationSource[]
  build?: BuddyPetCreationBuild
  running?: BuddyPetCreationRunning
}

/** `cohost.pet.creation.status` (and what start and cancel answer). */
export interface BuddyPetCreationStatus {
  creation: BuddyPetCreation | null
}

export interface BuddyPetCreatorError {
  code: string
  message: string
}

/** `cohost.pet.identity.read`. */
export interface BuddyPetIdentityReadEvent {
  buildId: string
  notes?: BuddyPetIdentityNotes
  error?: BuddyPetCreatorError
}

/** `cohost.pet.sheet.generated`. */
export interface BuddyPetSheetGeneratedEvent {
  buildId: string
  sheet: BuddyPetSheetKey
  version?: number
  opaque: boolean
  sheetsRemaining?: number
  redosRemaining?: number
  error?: BuddyPetCreatorError
}

export type BuddyPetBuildProgressStep =
  | 'reading'
  | 'cutting'
  | 'registering'
  | 'packing'
  | 'writing'
  | 'done'
  | 'failed'

/** `cohost.pet.build.progress`: the builder's step, then `done` or `failed`. */
export interface BuddyPetBuildProgressEvent {
  buildId: string
  step: BuddyPetBuildProgressStep
  sheet?: string
  cell?: string
  done: number
  total: number
  error?: string
  code?: string
}

/** The creation folder's files the wizard reads through main (S-F5): a
 * stored source, or the built pack's atlas and manifest. */
const BUDDY_CREATION_SOURCE_FILE = /^sources\/[a-z0-9-]{1,40}-v[0-9]{1,4}\.png$/
const BUDDY_CREATION_PACK_FILES = new Set(['pack/manifest.json', 'pack/mascot.webp'])

export function isBuddyCreationFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    (BUDDY_CREATION_SOURCE_FILE.test(file) || BUDDY_CREATION_PACK_FILES.has(file))
  )
}
