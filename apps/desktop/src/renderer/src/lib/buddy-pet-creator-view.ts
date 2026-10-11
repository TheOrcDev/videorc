import type { AiCapabilities, CohostPersona } from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  BUDDY_PET_ATLAS_SHEETS,
  BUDDY_PET_NOTES_ASYMMETRIC_MAX,
  BUDDY_PET_NOTES_FEATURE_MAX_CHARS,
  BUDDY_PET_NOTES_ITEM_MAX_CHARS,
  BUDDY_PET_NOTES_LIST_MAX,
  BUDDY_PET_NOTES_PROPORTIONS_MAX_CHARS,
  BUDDY_PET_PACK_NAME_MAX_CHARS,
  type BuddyPetAtlasSheet,
  type BuddyPetCreation,
  type BuddyPetCreationSource,
  type BuddyPetIdentityNotes,
  type BuddyPetSheetKey
} from '../../../shared/buddy-pet-creator'
import { isBuddyUserAvatarId } from '../../../shared/buddy-library'

// The Buddy pet creator wizard (plan 168 S-F5): pure derivations the wizard
// and its tests share. The backend owns the creation; these only read it.

export type BuddyPetAtlasKey = BuddyPetAtlasSheet['key']

export type BuddyPetCreatorStepId = 'reference' | 'pilot' | 'build' | 'review' | 'save'

export const BUDDY_PET_CREATOR_STEPS: readonly { id: BuddyPetCreatorStepId; label: string }[] = [
  { id: 'reference', label: 'Reference' },
  { id: 'pilot', label: 'Pilot' },
  { id: 'build', label: 'Build' },
  { id: 'review', label: 'Review' },
  { id: 'save', label: 'Save' }
]

export const BUDDY_PET_SIGNED_OUT = 'Sign in to create a Buddy.'
export const BUDDY_PET_CONSENT_OFF =
  'Cloud AI is off. Allow it under Cloud AI on the Buddy tab to create a Buddy.'
export const BUDDY_PET_NOT_AVAILABLE = 'Not available yet'
export const BUDDY_PET_NONE_LEFT = "This month's creations are used up."

export interface BuddyPetCreatorGate {
  /** The wizard works (continue a creation, build, save). */
  allowed: boolean
  /** The one line that says why not; null when allowed. */
  reason: string | null
  /** A new creation can start (one is left this month). */
  canStart: boolean
  /** This month's creations, when the web reported them. */
  allowance: { left: number; limit: number } | null
}

/**
 * Whether the creator works for this account (plan 168 D20): signed in,
 * Premium, cloud AI allowed, and a web that offers pet creation. The checks
 * run in the order a streamer can fix them. Starting a new creation also
 * needs one left this month; a creation already open carries on.
 */
export function buddyPetCreatorGate({
  signedIn,
  gate,
  consented,
  capabilities
}: {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): BuddyPetCreatorGate {
  const pet = capabilities?.cohost?.pet
  const allowance = pet?.enabled
    ? { left: pet.creationsRemainingThisMonth, limit: pet.monthlyLimit }
    : null
  const refuse = (reason: string): BuddyPetCreatorGate => ({
    allowed: false,
    reason,
    canStart: false,
    allowance
  })
  if (!signedIn) return refuse(BUDDY_PET_SIGNED_OUT)
  if (!gate.allowed) return refuse(gate.reason)
  if (!consented) return refuse(BUDDY_PET_CONSENT_OFF)
  if (!pet?.enabled) return refuse(BUDDY_PET_NOT_AVAILABLE)
  return { allowed: true, reason: null, canStart: pet.creationsRemainingThisMonth > 0, allowance }
}

/** "2 of 3 left this month". */
export function buddyPetAllowanceCopy(allowance: { left: number; limit: number }): string {
  return `${allowance.left} of ${allowance.limit} left this month`
}

// --- The identity notes as editable sentences ---------------------------------

export interface BuddyPetNotesDraft {
  /** Comma-separated colours. */
  palette: string
  /** Comma-separated materials. */
  materials: string
  proportions: string
  asymmetric: { feature: string; side: 'left' | 'right' }[]
}

export function buddyPetNotesDraft(notes: BuddyPetIdentityNotes): BuddyPetNotesDraft {
  return {
    palette: notes.palette.join(', '),
    materials: notes.materials.join(', '),
    proportions: notes.proportions,
    asymmetric: notes.asymmetric.map((item) => ({ ...item }))
  }
}

const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

/** The draft as the notes the backend takes, or the one thing to fix. */
export function buddyPetNotesFromDraft(
  draft: BuddyPetNotesDraft
): { notes: BuddyPetIdentityNotes } | { error: string } {
  const palette = splitList(draft.palette)
  const materials = splitList(draft.materials)
  for (const [items, what] of [
    [palette, 'colours'],
    [materials, 'materials']
  ] as const) {
    if (items.length > BUDDY_PET_NOTES_LIST_MAX) {
      return { error: `List at most ${BUDDY_PET_NOTES_LIST_MAX} ${what}.` }
    }
    if (items.some((item) => item.length > BUDDY_PET_NOTES_ITEM_MAX_CHARS)) {
      return {
        error: `Keep each of the ${what} under ${BUDDY_PET_NOTES_ITEM_MAX_CHARS + 1} characters.`
      }
    }
  }
  const proportions = draft.proportions.trim()
  if (!proportions) return { error: 'Describe its proportions.' }
  if (proportions.length > BUDDY_PET_NOTES_PROPORTIONS_MAX_CHARS) {
    return {
      error: `Keep the proportions under ${BUDDY_PET_NOTES_PROPORTIONS_MAX_CHARS + 1} characters.`
    }
  }
  const asymmetric = draft.asymmetric
    .map((item) => ({ feature: item.feature.trim(), side: item.side }))
    .filter((item) => item.feature)
  if (asymmetric.length > BUDDY_PET_NOTES_ASYMMETRIC_MAX) {
    return { error: `List at most ${BUDDY_PET_NOTES_ASYMMETRIC_MAX} one-sided features.` }
  }
  if (asymmetric.some((item) => item.feature.length > BUDDY_PET_NOTES_FEATURE_MAX_CHARS)) {
    return {
      error: `Keep each feature under ${BUDDY_PET_NOTES_FEATURE_MAX_CHARS + 1} characters.`
    }
  }
  return { notes: { palette, materials, proportions, asymmetric } }
}

// --- Sheets ---------------------------------------------------------------------

export const BUDDY_PET_SHEET_LABELS: Record<BuddyPetSheetKey, string> = {
  pilot: 'Pilot',
  'gaze-up2': 'Looking up',
  'gaze-up1': 'Looking a little up',
  'gaze-level': 'Looking ahead',
  'gaze-down1': 'Looking a little down',
  'gaze-down2': 'Looking down',
  'reactions-a': 'Laugh to sleep',
  'reactions-b': 'Worried to calm',
  extras: 'Talk and wave'
}

/** The pilot's four poses, row-major. */
export const BUDDY_PET_PILOT_POSES = ['Neutral', 'Turned left', 'Turned right', 'Laughing']

/** The sheet's accepted source, when it was made. */
export function buddyPetSheetSource(
  creation: BuddyPetCreation,
  key: BuddyPetSheetKey
): BuddyPetCreationSource | null {
  return creation.sheets.find((sheet) => sheet.sheet === key) ?? null
}

/** The first atlas sheet not made yet, in atlas order; null when all are. */
export function buddyPetNextSheet(creation: BuddyPetCreation): BuddyPetAtlasSheet | null {
  return BUDDY_PET_ATLAS_SHEETS.find((sheet) => !buddyPetSheetSource(creation, sheet.key)) ?? null
}

export type BuddyPetSheetPhase = 'waiting' | 'making' | 'done' | 'failed'

/** One row of the Build list: waiting, being made, made (and which
 * version), or failed with the reason. */
export function buddyPetSheetPhase(
  creation: BuddyPetCreation,
  key: BuddyPetSheetKey,
  errors: Partial<Record<BuddyPetSheetKey, string>>
): { phase: BuddyPetSheetPhase; version: number | null; opaque: boolean; error: string | null } {
  const source = buddyPetSheetSource(creation, key)
  const making = creation.running?.job === 'sheet' && creation.running.sheet === key
  if (making)
    return { phase: 'making', version: source?.version ?? null, opaque: false, error: null }
  const error = errors[key] ?? null
  if (error) return { phase: 'failed', version: source?.version ?? null, opaque: false, error }
  if (source) return { phase: 'done', version: source.version, opaque: source.opaque, error: null }
  return { phase: 'waiting', version: null, opaque: false, error: null }
}

/** Pilots left in this creation. */
export function buddyPetPilotsLeft(creation: BuddyPetCreation): number {
  return Math.max(0, creation.pilotsAllowed - creation.pilotsUsed)
}

// --- Review ------------------------------------------------------------------------

export interface BuddyPetReviewRow {
  key: BuddyPetAtlasKey
  label: string
  /** Frame ids in the row, left to right. */
  cells: readonly string[]
  /** Cell captions under reactions and extras (gaze cells carry arrows). */
  captions?: readonly string[]
}

const REACTIONS_A = ['laugh', 'surprised', 'wink', 'kiss', 'blink', 'sleep'] as const
const REACTIONS_B = ['worried', 'annoyed', 'proud', 'confused', 'excited', 'calm'] as const
const EXTRAS = ['talk-a', 'talk-b', 'wave'] as const
const caption = (id: string): string =>
  id === 'talk-a'
    ? 'Talk'
    : id === 'talk-b'
      ? 'Talk, half'
      : id.charAt(0).toUpperCase() + id.slice(1)

/** The eight rows a streamer marks (D21): five gaze rows, the two reaction
 * sheets and the extras. */
export const BUDDY_PET_REVIEW_ROWS: readonly BuddyPetReviewRow[] = [
  ...BUDDY_PET_ATLAS_SHEETS.slice(0, 5).map((sheet, row) => ({
    key: sheet.key,
    label: BUDDY_PET_SHEET_LABELS[sheet.key],
    cells: [0, 1, 2, 3, 4].map((col) => `gaze-${col}-${row}`)
  })),
  {
    key: 'reactions-a',
    label: BUDDY_PET_SHEET_LABELS['reactions-a'],
    cells: REACTIONS_A,
    captions: REACTIONS_A.map(caption)
  },
  {
    key: 'reactions-b',
    label: BUDDY_PET_SHEET_LABELS['reactions-b'],
    cells: REACTIONS_B,
    captions: REACTIONS_B.map(caption)
  },
  {
    key: 'extras',
    label: BUDDY_PET_SHEET_LABELS.extras,
    cells: EXTRAS,
    captions: EXTRAS.map(caption)
  }
]

/** Which version of each row "Looks right" was given to. A redo makes a new
 * version, so its row reads as unmarked until it is marked again. */
export type BuddyPetReviewMarks = Partial<Record<BuddyPetAtlasKey, number>>

export function buddyPetRowMarked(
  marks: BuddyPetReviewMarks,
  creation: BuddyPetCreation,
  key: BuddyPetAtlasKey
): boolean {
  const source = buddyPetSheetSource(creation, key)
  return source !== null && marks[key] === source.version
}

export function buddyPetMarkRow(
  marks: BuddyPetReviewMarks,
  creation: BuddyPetCreation,
  key: BuddyPetAtlasKey,
  marked: boolean
): BuddyPetReviewMarks {
  const next = { ...marks }
  const source = buddyPetSheetSource(creation, key)
  if (marked && source) next[key] = source.version
  else delete next[key]
  return next
}

export function buddyPetMarkedCount(
  marks: BuddyPetReviewMarks,
  creation: BuddyPetCreation
): number {
  return BUDDY_PET_REVIEW_ROWS.filter((row) => buddyPetRowMarked(marks, creation, row.key)).length
}

/** Saving needs a fresh build and every row marked "Looks right" (D21). */
export function buddyPetCanSave(marks: BuddyPetReviewMarks, creation: BuddyPetCreation): boolean {
  return (
    creation.step === 'review' &&
    creation.build?.state === 'built' &&
    creation.build.fresh &&
    buddyPetMarkedCount(marks, creation) === BUDDY_PET_REVIEW_ROWS.length
  )
}

/** The direction a gaze cell should look, as an arrow: page-pet's grid
 * (column 0 is the viewer's left, row 0 is up). The centre looks at you. */
export function buddyPetGazeArrow(
  col: number,
  row: number
): { center: boolean; degrees: number; label: string } {
  const x = col / 2 - 1
  const y = row / 2 - 1
  if (x === 0 && y === 0) return { center: true, degrees: 0, label: 'Looking at you' }
  const vertical = y < 0 ? 'up' : y > 0 ? 'down' : ''
  const horizontal = x < 0 ? 'left' : x > 0 ? 'right' : ''
  const strength = Math.max(Math.abs(x), Math.abs(y)) === 1 ? '' : 'a little '
  const direction = [vertical, horizontal].filter(Boolean).join(' and ')
  return {
    center: false,
    degrees: Math.round((Math.atan2(y, x) * 180) / Math.PI),
    label: `Looking ${strength}${direction}`
  }
}

/**
 * Where a saved pack is kept, the Save step's line (plan 172 D10): a Buddy
 * from the account library sends its moves to the account when the web
 * keeps them; any other Buddy keeps them on this computer only.
 */
export function buddyPetSaveNote({
  persona,
  capabilities
}: {
  persona: Pick<CohostPersona, 'name' | 'libraryAvatarId'> | null
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): string {
  const wears = 'Your Buddy wears it right away; switch back to Still any time.'
  const synced =
    isBuddyUserAvatarId(persona?.libraryAvatarId) &&
    capabilities?.cohost?.buddyLibrary?.alive === true
  if (!synced) return `Kept on this computer. ${wears}`
  const name = persona?.name.trim() || 'your Buddy'
  return `Saved with ${name} in your Videorc library, so it moves on every computer you sign in to. ${wears}`
}

/** The pack name as it would be saved, or null when it cannot be. */
export function buddyPetNameToSave(draft: string): string | null {
  const name = draft.trim()
  if (!name || name.length > BUDDY_PET_PACK_NAME_MAX_CHARS) return null
  return name
}

/** The wizard's step for a creation: the backend's step, with the notes
 * still on the Reference step until a pilot exists, and Save once the
 * streamer moved on from a complete review. */
export function buddyPetCreatorStep(
  creation: BuddyPetCreation | null,
  naming: boolean
): BuddyPetCreatorStepId {
  if (!creation) return 'reference'
  switch (creation.step) {
    case 'reference':
      return 'reference'
    case 'pilot':
      return creation.pilot ? 'pilot' : 'reference'
    case 'build':
      return 'build'
    case 'review':
      return naming ? 'save' : 'review'
  }
}

/** Errors only a new creation fixes: the wizard offers "Start a new one". */
export function buddyPetNeedsNewCreation(code: string | null | undefined): boolean {
  return (
    code === 'pet-build-expired' ||
    code === 'pet-build-not-found' ||
    code === 'cohost-pet-creation-none'
  )
}
