// The Golem pet creator's wire (plan 168 S-F4), mirrored from
// `crates/videorc-backend/src/golem_pet_create.rs`. A creation is a web build
// session plus a folder under the managed golem root
// (`<personaId>/creations/<buildId>/`): `build-state.json`, the versioned
// sources (`sources/<sheet>-v<n>.png`) and the last build (`pack/`). The long
// calls answer at once and report by event.

/** One pitch row of the 5 x 5 gaze grid, top to bottom. */
export type GolemPetGazeRow = 'up2' | 'up1' | 'level' | 'down1' | 'down2'
export const GOLEM_PET_GAZE_ROWS: readonly GolemPetGazeRow[] = [
  'up2',
  'up1',
  'level',
  'down1',
  'down2'
]

/** A sheet kind as the web route names it (`row` rides with `gaze`). */
export type GolemPetSheetKindName = 'pilot' | 'gaze' | 'reactions-a' | 'reactions-b' | 'extras'

/** A sheet as the creation folder and the events name it. */
export type GolemPetSheetKey =
  | 'pilot'
  | `gaze-${GolemPetGazeRow}`
  | 'reactions-a'
  | 'reactions-b'
  | 'extras'

export interface GolemPetAtlasSheet {
  key: Exclude<GolemPetSheetKey, 'pilot'>
  kind: Exclude<GolemPetSheetKindName, 'pilot'>
  row?: GolemPetGazeRow
}

/** The eight sheets of a pack, in atlas order (D18). */
export const GOLEM_PET_ATLAS_SHEETS: readonly GolemPetAtlasSheet[] = [
  ...GOLEM_PET_GAZE_ROWS.map(
    (row): GolemPetAtlasSheet => ({ key: `gaze-${row}`, kind: 'gaze', row })
  ),
  { key: 'reactions-a', kind: 'reactions-a' },
  { key: 'reactions-b', kind: 'reactions-b' },
  { key: 'extras', kind: 'extras' }
]

/** Every sheet key: the pilot, then the atlas sheets in atlas order. */
export const GOLEM_PET_SHEET_KEYS = [
  'pilot',
  'gaze-up2',
  'gaze-up1',
  'gaze-level',
  'gaze-down1',
  'gaze-down2',
  'reactions-a',
  'reactions-b',
  'extras'
] as const satisfies readonly GolemPetSheetKey[]

/** The identity notes (D19), as the web bounds them. */
export const GOLEM_PET_NOTES_LIST_MAX = 8
export const GOLEM_PET_NOTES_ITEM_MAX_CHARS = 60
export const GOLEM_PET_NOTES_PROPORTIONS_MAX_CHARS = 400
export const GOLEM_PET_NOTES_ASYMMETRIC_MAX = 12
export const GOLEM_PET_NOTES_FEATURE_MAX_CHARS = 80
/** A saved pack's name (the pack list's bound). */
export const GOLEM_PET_PACK_NAME_MAX_CHARS = 64
/** An upload is refused above this before it is decoded. */
export const GOLEM_PET_REFERENCE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024

export interface GolemPetAsymmetry {
  feature: string
  /** The character's own (anatomical) side. */
  side: 'left' | 'right'
}

export interface GolemPetIdentityNotes {
  palette: string[]
  materials: string[]
  proportions: string
  asymmetric: GolemPetAsymmetry[]
}

/** The persona's idle image (the bundled default without one), or a picture
 * the user chose (PNG or WebP with transparency, base64). */
export type GolemPetReference = { kind: 'persona-idle' } | { kind: 'upload'; imageBase64: string }

/** `cohost.pet.identity`. */
export interface CohostPetIdentityParams {
  buildId: string
  reference: GolemPetReference
}

/** `cohost.pet.sheet.generate`. `notes` (corrected) rides with the pilot only. */
export interface CohostPetSheetGenerateParams {
  buildId: string
  kind: GolemPetSheetKindName
  row?: GolemPetGazeRow
  redo: boolean
  notes?: GolemPetIdentityNotes
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
export interface GolemPetCreationAccepted {
  buildId: string
  sheet?: GolemPetSheetKey
}

/** Derived from the data: no notes → `reference`; no accepted pilot →
 * `pilot`; until a build of the accepted sheets succeeds → `build`; then
 * `review`. */
export type GolemPetCreationStep = 'reference' | 'pilot' | 'build' | 'review'

export interface GolemPetCreationSource {
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
export interface GolemPetBuildFailure {
  code: string
  message: string
  sheet?: string
  cell?: string
}

export interface GolemPetCreationBuild {
  state: 'built' | 'failed'
  /** Made from the sheets accepted now (a redo makes it stale). */
  fresh: boolean
  finishedAt: string
  error?: GolemPetBuildFailure
}

export type GolemPetCreatorJob = 'start' | 'identity' | 'sheet' | 'build' | 'save'

export interface GolemPetCreationRunning {
  job: GolemPetCreatorJob
  sheet?: string
}

export interface GolemPetCreation {
  buildId: string
  step: GolemPetCreationStep
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
  reference?: GolemPetCreationSource
  notes?: GolemPetIdentityNotes
  /** The latest pilot made from the current reference. */
  pilot?: GolemPetCreationSource
  pilotAccepted: boolean
  /** The accepted version of each atlas sheet made so far, in atlas order. */
  sheets: GolemPetCreationSource[]
  build?: GolemPetCreationBuild
  running?: GolemPetCreationRunning
}

/** `cohost.pet.creation.status` (and what start and cancel answer). */
export interface GolemPetCreationStatus {
  creation: GolemPetCreation | null
}

export interface GolemPetCreatorError {
  code: string
  message: string
}

/** `cohost.pet.identity.read`. */
export interface GolemPetIdentityReadEvent {
  buildId: string
  notes?: GolemPetIdentityNotes
  error?: GolemPetCreatorError
}

/** `cohost.pet.sheet.generated`. */
export interface GolemPetSheetGeneratedEvent {
  buildId: string
  sheet: GolemPetSheetKey
  version?: number
  opaque: boolean
  sheetsRemaining?: number
  redosRemaining?: number
  error?: GolemPetCreatorError
}

export type GolemPetBuildProgressStep =
  | 'reading'
  | 'cutting'
  | 'registering'
  | 'packing'
  | 'writing'
  | 'done'
  | 'failed'

/** `cohost.pet.build.progress`: the builder's step, then `done` or `failed`. */
export interface GolemPetBuildProgressEvent {
  buildId: string
  step: GolemPetBuildProgressStep
  sheet?: string
  cell?: string
  done: number
  total: number
  error?: string
  code?: string
}

/** The creation folder's files the wizard reads through main (S-F5): a
 * stored source, or the built pack's atlas and manifest. */
const GOLEM_CREATION_SOURCE_FILE = /^sources\/[a-z0-9-]{1,40}-v[0-9]{1,4}\.png$/
const GOLEM_CREATION_PACK_FILES = new Set(['pack/manifest.json', 'pack/mascot.webp'])

export function isGolemCreationFileName(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    (GOLEM_CREATION_SOURCE_FILE.test(file) || GOLEM_CREATION_PACK_FILES.has(file))
  )
}
