import type {
  AiCapabilities,
  CohostAvatarCreateParams,
  CohostPersona,
  GolemLibraryState
} from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  GOLEM_ONBOARDING_GATES,
  GOLEM_ONBOARDING_STEP_COUNT,
  golemLibraryFullLine,
  golemOnboardingAllowance
} from './golem-onboarding-copy'
import { GOLEM_GENERATE_NOT_AVAILABLE } from './golem-persona-view'
import { GOLEM_LOOK_CREATE_IMAGES } from './golem-look-view'
import {
  GOLEM_DEFAULT_OFFICIAL_ID,
  GOLEM_LIBRARY_CONTEXT_MAX_CHARS,
  GOLEM_LIBRARY_DESCRIPTION_MAX_CHARS,
  GOLEM_LIBRARY_LIMIT,
  GOLEM_LIBRARY_NAME_MAX_CHARS,
  GOLEM_LIBRARY_PERSONALITY_MAX_CHARS,
  GOLEM_OFFICIAL_CATALOG,
  officialGolem,
  type GolemLibraryId,
  type GolemOfficialEntry,
  type GolemOfficialSlug
} from '../../../shared/golem-library'

// "My Golems" and the four-step onboarding (plan 170 D14 to D16): pure
// derivations the section, the sheet and their tests share. Every string a
// person reads comes from `golem-onboarding-copy.ts`.

// --- The library -------------------------------------------------------------

export interface GolemLibraryCard {
  id: GolemLibraryId
  /** Official cards are read-only: Use and Make it Alive only. */
  kind: 'official' | 'mine'
  name: string
  /** The second line: the official character's tagline, or what was asked for. */
  subtitle: string
  /** The tooltip on the card: the official personality, or the description in full. */
  hint: string
  /** Official cards carry their slug (the picture is bundled); mine carry a cached idle URL. */
  slug: GolemOfficialSlug | null
  idleUrl: string | null
  active: boolean
  /** A library job acts on this card now (use, delete, update). */
  busy: boolean
}

export interface GolemLibraryView {
  signedIn: boolean
  official: GolemLibraryCard[]
  /** Null when signed out or not loaded yet (the group shows its line instead). */
  mine: GolemLibraryCard[] | null
  /** The account's choice, picked on videorc.com, that sync would not apply here. */
  pickedElsewhere: { id: GolemLibraryId; name: string } | null
  /** A sync is running. */
  syncing: boolean
  /** Any library job is running: every action waits. */
  busy: boolean
  /** The last failed sync or action, in the backend's words. */
  error: string | null
}

/**
 * What the persona wears as a library id before the backend's state arrives:
 * its link, else the untouched default Golem.
 */
export function golemPersonaLibraryId(
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
): GolemLibraryId | null {
  if (!persona) return null
  if (persona.libraryAvatarId) return persona.libraryAvatarId
  return persona.source === 'default' ? GOLEM_DEFAULT_OFFICIAL_ID : null
}

function officialCard(
  entry: GolemOfficialEntry,
  activeId: GolemLibraryId | null,
  busyId: GolemLibraryId | null
): GolemLibraryCard {
  return {
    id: entry.id,
    kind: 'official',
    name: entry.name,
    subtitle: entry.tagline,
    hint: entry.personality,
    slug: entry.slug,
    idleUrl: null,
    active: entry.id === activeId,
    busy: entry.id === busyId
  }
}

/**
 * The section's model: the official five (always, signed out and offline
 * too), then the account's own, newest first, with the active one marked.
 * Before the backend answers, the catalog and the persona's own link stand in.
 */
export function golemLibraryView({
  library,
  persona
}: {
  library: GolemLibraryState | null
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
}): GolemLibraryView {
  const activeId = library ? library.activeAvatarId : golemPersonaLibraryId(persona)
  const busyId = library?.busy?.avatarId ?? null
  const officialEntries: readonly GolemOfficialEntry[] =
    library && library.official.length > 0 ? library.official : GOLEM_OFFICIAL_CATALOG
  const mine =
    library?.mine?.map(
      (entry): GolemLibraryCard => ({
        id: entry.id,
        kind: 'mine',
        name: entry.name,
        subtitle: entry.description,
        hint: entry.description,
        slug: null,
        idleUrl: entry.poses.idle,
        active: entry.id === activeId,
        busy: entry.id === busyId
      })
    ) ?? null
  const serverId = library?.serverActiveAvatarId ?? null
  const serverName = serverId
    ? (officialGolem(serverId)?.name ?? library?.mine?.find((entry) => entry.id === serverId)?.name)
    : undefined
  return {
    signedIn: library?.signedIn ?? false,
    official: officialEntries.map((entry) => officialCard(entry, activeId, busyId)),
    mine: library?.signedIn ? mine : null,
    pickedElsewhere:
      serverId && serverName && serverId !== activeId ? { id: serverId, name: serverName } : null,
    syncing: library?.busy?.kind === 'sync',
    busy: Boolean(library?.busy),
    error: library?.error?.message ?? null
  }
}

/** The account's cap: the web's, else the library's, else 30. */
export function golemLibraryLimit(
  capabilities: Pick<AiCapabilities, 'cohost'> | null,
  library: Pick<GolemLibraryState, 'limit'> | null
): number {
  return capabilities?.cohost?.golemLibrary?.limit ?? library?.limit ?? GOLEM_LIBRARY_LIMIT
}

/** No room for another Golem: the web's count when it sent one, else the cached list. */
export function golemLibraryIsFull(
  capabilities: Pick<AiCapabilities, 'cohost'> | null,
  library: Pick<GolemLibraryState, 'limit' | 'mine'> | null
): boolean {
  const limit = golemLibraryLimit(capabilities, library)
  const count = capabilities?.cohost?.golemLibrary?.count ?? library?.mine?.length ?? 0
  return limit > 0 && count >= limit
}

// --- The first-launch invitation (D16) ---------------------------------------

/** Remembered per machine, like the other one-time Golem cards. */
export const GOLEM_INVITATION_STORAGE_KEY = 'videorc.golemInvitationDismissed'

/**
 * "Make this Golem your own, or pick another.": only while the persona is
 * the untouched default Golem (the library says `official:golem` and the
 * persona has no link of its own) and the streamer has not closed it.
 */
export function golemInvitationVisible({
  library,
  persona,
  dismissed
}: {
  library: Pick<GolemLibraryState, 'activeAvatarId'> | null
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
  dismissed: boolean
}): boolean {
  if (dismissed || !library || !persona) return false
  return (
    library.activeAvatarId === GOLEM_DEFAULT_OFFICIAL_ID &&
    !persona.libraryAvatarId &&
    persona.source === 'default'
  )
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readGolemInvitationDismissed(
  storage: Pick<Storage, 'getItem'> | null = localStorageOrNull()
): boolean {
  try {
    const raw = storage?.getItem(GOLEM_INVITATION_STORAGE_KEY)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

/** Best effort: blocked storage keeps it closed for this window's life only. */
export function writeGolemInvitationDismissed(
  storage: Pick<Storage, 'setItem'> | null = localStorageOrNull()
): void {
  try {
    storage?.setItem(GOLEM_INVITATION_STORAGE_KEY, '1')
  } catch {
    // Not remembering it is harmless: it shows again next launch.
  }
}

// --- The onboarding's steps (D14) --------------------------------------------

export type GolemOnboardingStep = 1 | 2 | 3 | 4

export function isGolemOnboardingStep(value: number): value is GolemOnboardingStep {
  return Number.isInteger(value) && value >= 1 && value <= GOLEM_ONBOARDING_STEP_COUNT
}

/** What the streamer has entered so far (the picture itself lives in the sheet). */
export interface GolemOnboardingInput {
  description: string
  hasPicture: boolean
  name: string
  personality: string
  about: string
  /** "Skip for now" on step 3: create without the personality and About you. */
  skipDetails: boolean
}

export const EMPTY_GOLEM_ONBOARDING_INPUT: GolemOnboardingInput = {
  description: '',
  hasPicture: false,
  name: '',
  personality: '',
  about: '',
  skipDetails: false
}

/** Characters as a person counts them (an emoji is one). */
export function golemTextLength(value: string): number {
  return [...value].length
}

/** The name as it is sent: trimmed, 1 to 24 characters; null when it cannot be. */
export function golemOnboardingName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  return golemTextLength(trimmed) > GOLEM_LIBRARY_NAME_MAX_CHARS ? null : trimmed
}

/** Step 2 is done with a description, a picture, or both. */
export function golemOnboardingHasLook(input: GolemOnboardingInput): boolean {
  return input.description.trim().length > 0 || input.hasPicture
}

/**
 * Whether Next works on `step`: step 1 always; step 2 with a description
 * (at most 600) or a picture; step 3 with a name (1 to 24) and the optional
 * fields within their bounds. Step 4 has no Next.
 */
export function golemOnboardingCanAdvance(
  step: GolemOnboardingStep,
  input: GolemOnboardingInput
): boolean {
  switch (step) {
    case 1:
      return true
    case 2:
      return (
        golemOnboardingHasLook(input) &&
        golemTextLength(input.description.trim()) <= GOLEM_LIBRARY_DESCRIPTION_MAX_CHARS
      )
    case 3:
      return (
        golemOnboardingName(input.name) !== null &&
        golemTextLength(input.personality) <= GOLEM_LIBRARY_PERSONALITY_MAX_CHARS &&
        golemTextLength(input.about) <= GOLEM_LIBRARY_CONTEXT_MAX_CHARS
      )
    case 4:
      return false
  }
}

/** "Skip for now" shows on step 3 once the name is filled. */
export function golemOnboardingCanSkip(
  step: GolemOnboardingStep,
  input: GolemOnboardingInput
): boolean {
  return step === 3 && golemOnboardingName(input.name) !== null
}

/** The furthest step the input allows (a later step needs every earlier one done). */
export function golemOnboardingReachable(
  target: GolemOnboardingStep,
  input: GolemOnboardingInput
): GolemOnboardingStep {
  let step: GolemOnboardingStep = 1
  while (step < target && golemOnboardingCanAdvance(step, input)) {
    step = (step + 1) as GolemOnboardingStep
  }
  return step
}

/**
 * `cohost.avatar.create` with every field the streamer filled: the look
 * (description, picture), the name, and the personality and About you
 * unless step 3 was skipped. Empty optional fields are left out.
 */
export function golemOnboardingCreateParams(
  input: GolemOnboardingInput,
  inspirationBase64: string | null
): CohostAvatarCreateParams {
  const description = input.description.trim()
  const name = golemOnboardingName(input.name)
  const personality = input.skipDetails ? '' : input.personality.trim()
  const context = input.skipDetails ? '' : input.about.trim()
  return {
    ...(description ? { description } : {}),
    ...(inspirationBase64 ? { inspirationBase64 } : {}),
    ...(name ? { name } : {}),
    ...(personality ? { personality } : {}),
    ...(context ? { context } : {})
  }
}

// --- Step 4's gates (D15) ----------------------------------------------------

export type GolemCreateGateAction = 'sign-in' | 'see-premium' | 'start-from-ours' | 'allow-cloud-ai'

export interface GolemCreateGate {
  kind: 'signed-out' | 'premium' | 'cloud-ai' | 'full' | 'unavailable' | 'allowance'
  line: string
  actions: GolemCreateGateAction[]
}

/**
 * Why "Create my Golem" cannot run now, or null when it can. The checks run
 * in the order a streamer can fix them: the account, Premium, Cloud AI
 * consent, room in the library, a web that offers the look, then today's
 * images (a Golem is four).
 */
export function golemCreateGate({
  signedIn,
  gate,
  consented,
  capabilities,
  library
}: {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
  library: Pick<GolemLibraryState, 'limit' | 'mine'> | null
}): GolemCreateGate | null {
  if (!signedIn) {
    return { kind: 'signed-out', line: GOLEM_ONBOARDING_GATES.signedOut, actions: ['sign-in'] }
  }
  if (!gate.allowed) {
    return {
      kind: 'premium',
      line: GOLEM_ONBOARDING_GATES.free,
      actions: ['see-premium', 'start-from-ours']
    }
  }
  if (!consented) {
    return {
      kind: 'cloud-ai',
      line: GOLEM_ONBOARDING_GATES.cloudAiOff,
      actions: ['allow-cloud-ai']
    }
  }
  if (golemLibraryIsFull(capabilities, library)) {
    return {
      kind: 'full',
      line: golemLibraryFullLine(golemLibraryLimit(capabilities, library)),
      actions: []
    }
  }
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) {
    return { kind: 'unavailable', line: GOLEM_GENERATE_NOT_AVAILABLE, actions: [] }
  }
  if (avatar.remainingToday < GOLEM_LOOK_CREATE_IMAGES) {
    return { kind: 'allowance', line: GOLEM_ONBOARDING_GATES.allowanceUsed, actions: [] }
  }
  return null
}

/** "Uses 4 of your 20 images left today.", when the web reported today's images. */
export function golemOnboardingAllowanceLine(
  capabilities: Pick<AiCapabilities, 'cohost'> | null
): string | null {
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) return null
  return golemOnboardingAllowance(avatar.remainingToday)
}

/**
 * The one line for a create that made nothing, by the web's code: a gate
 * the app could not see coming gets the gate's own line, anything else the
 * plain failure (a failed idle meters nothing).
 */
export function golemCreateFailureLine(
  problem: { code: string } | null,
  limit: number = GOLEM_LIBRARY_LIMIT
): string | null {
  if (!problem) return null
  switch (problem.code) {
    case 'golem-library-full':
      return golemLibraryFullLine(limit)
    case 'quota-exhausted':
      return GOLEM_ONBOARDING_GATES.allowanceUsed
    case 'premium-required':
      return GOLEM_ONBOARDING_GATES.free
    case 'unauthorized':
      return GOLEM_ONBOARDING_GATES.signedOut
    default:
      return GOLEM_ONBOARDING_GATES.failed
  }
}
