import type {
  AiCapabilities,
  CohostAvatarCreateParams,
  CohostPersona,
  BuddyLibraryState
} from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  BUDDY_ONBOARDING_GATES,
  BUDDY_ONBOARDING_STEP_COUNT,
  buddyLibraryAliveDownloading,
  buddyLibraryAliveUploading,
  buddyLibraryFullLine,
  buddyLibraryImporting,
  buddyOnboardingAllowance
} from './buddy-onboarding-copy'
import { BUDDY_GENERATE_NOT_AVAILABLE } from './buddy-persona-view'
import { BUDDY_LOOK_CREATE_IMAGES } from './buddy-look-view'
import {
  BUDDY_DEFAULT_OFFICIAL_ID,
  BUDDY_LIBRARY_CONTEXT_MAX_CHARS,
  BUDDY_LIBRARY_DESCRIPTION_MAX_CHARS,
  BUDDY_LIBRARY_LIMIT,
  BUDDY_LIBRARY_NAME_MAX_CHARS,
  BUDDY_LIBRARY_PERSONALITY_MAX_CHARS,
  BUDDY_OFFICIAL_CATALOG,
  officialAliveFallback,
  officialBuddy,
  type BuddyLibraryId,
  type BuddyOfficialEntry,
  type BuddyOfficialSlug
} from '../../../shared/buddy-library'

// "My Buddies" and the four-step onboarding (plan 170 D14 to D16): pure
// derivations the section, the sheet and their tests share. Every string a
// person reads comes from `buddy-onboarding-copy.ts`.

// --- The library -------------------------------------------------------------

export interface BuddyLibraryCard {
  id: BuddyLibraryId
  /** Official cards are read-only: Use and Make it Alive only. */
  kind: 'official' | 'mine'
  name: string
  /** The second line: the official character's tagline, or what was asked for. */
  subtitle: string
  /** The tooltip on the card: the official personality, or the description in full. */
  hint: string
  /** Official cards carry their slug (the picture is bundled); mine carry a cached idle URL. */
  slug: BuddyOfficialSlug | null
  idleUrl: string | null
  active: boolean
  /** A library job acts on this card now (use, delete, update, a pack moving). */
  busy: boolean
  /**
   * Plan 172 D12: the card says "Alive" (an official Buddy whose pack ships,
   * was downloaded, or downloads on use; one of yours with a pack) instead
   * of offering Make it Alive.
   */
  alive: boolean
  /** Make it Alive is offered: one of yours without a pack, or an official
   * one whose pack has not shipped yet. */
  canMakeAlive: boolean
}

export interface BuddyLibraryView {
  signedIn: boolean
  official: BuddyLibraryCard[]
  /** Null when signed out or not loaded yet (the group shows its line instead). */
  mine: BuddyLibraryCard[] | null
  /** The account's choice, picked on videorc.com, that sync would not apply here. */
  pickedElsewhere: { id: BuddyLibraryId; name: string } | null
  /** A sync is running. */
  syncing: boolean
  /** Any library job is running: every action waits. */
  busy: boolean
  /** The last failed sync or action, in the backend's words. */
  error: string | null
}

/**
 * What the persona wears as a library id before the backend's state arrives:
 * its link, else the untouched default Buddy.
 */
export function buddyPersonaLibraryId(
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
): BuddyLibraryId | null {
  if (!persona) return null
  if (persona.libraryAvatarId) return persona.libraryAvatarId
  return persona.source === 'default' ? BUDDY_DEFAULT_OFFICIAL_ID : null
}

function officialCard(
  entry: BuddyOfficialEntry,
  activeId: BuddyLibraryId | null,
  busyId: BuddyLibraryId | null
): BuddyLibraryCard {
  return {
    id: entry.id,
    kind: 'official',
    name: entry.name,
    subtitle: entry.tagline,
    hint: entry.personality,
    slug: entry.slug,
    idleUrl: null,
    active: entry.id === activeId,
    busy: entry.id === busyId,
    alive: entry.alive !== 'none',
    canMakeAlive: entry.alive === 'none'
  }
}

/** Before the backend answers: the catalog, its pack states as the catalog implies them. */
const CATALOG_OFFICIAL_ENTRIES: readonly BuddyOfficialEntry[] = BUDDY_OFFICIAL_CATALOG.map(
  ({ description: _description, alive, ...entry }) => ({
    ...entry,
    alive: officialAliveFallback({ alive })
  })
)

/**
 * The line a pack or import job shows while it runs (plan 172): whose moves
 * download or upload, or which Buddy is being saved to the library; null
 * for the other jobs (their card spinner says enough).
 */
export function buddyLibraryBusyLine(
  library: Pick<BuddyLibraryState, 'busy' | 'official' | 'mine'> | null,
  personaName: string | null
): string | null {
  const busy = library?.busy
  if (!busy) return null
  const nameOf = (id: BuddyLibraryId | undefined): string | null => {
    if (!id) return null
    return (
      library.official.find((entry) => entry.id === id)?.name ??
      officialBuddy(id)?.name ??
      library.mine?.find((entry) => entry.id === id)?.name ??
      null
    )
  }
  const name = nameOf(busy.avatarId) ?? personaName ?? 'Buddy'
  switch (busy.kind) {
    case 'alive-download':
      return buddyLibraryAliveDownloading(name)
    case 'alive-upload':
      return buddyLibraryAliveUploading(name)
    case 'import':
      return buddyLibraryImporting(personaName ?? name)
    default:
      return null
  }
}

/**
 * "Save to my library" (plan 172 D10): the Buddy is one made only on this
 * computer (the library knows it is not linked), the streamer is signed in,
 * the web keeps imports (`buddyLibrary.alive`), and it is not being saved
 * already. Null when it is not offered; otherwise the Buddy's name for the
 * line.
 */
export function buddyLibrarySaveOffer({
  library,
  persona,
  capabilities
}: {
  library: Pick<BuddyLibraryState, 'signedIn' | 'activeAvatarId' | 'busy' | 'mine'> | null
  persona: Pick<CohostPersona, 'name' | 'libraryAvatarId' | 'images'> | null
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): { name: string } | null {
  if (!library || !persona || !library.signedIn || library.mine === null) return null
  // Being saved now: the busy line ("Saving {name} to your library.") says it.
  if (library.busy?.kind === 'import') return null
  if (library.activeAvatarId !== null || persona.libraryAvatarId) return null
  if (!persona.images.idle) return null
  if (capabilities?.cohost?.buddyLibrary?.alive !== true) return null
  return { name: persona.name.trim() || 'Buddy' }
}

/**
 * The section's model: the official five (always, signed out and offline
 * too), then the account's own, newest first, with the active one marked.
 * Before the backend answers, the catalog and the persona's own link stand in.
 */
export function buddyLibraryView({
  library,
  persona
}: {
  library: BuddyLibraryState | null
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
}): BuddyLibraryView {
  const activeId = library ? library.activeAvatarId : buddyPersonaLibraryId(persona)
  const busyId = library?.busy?.avatarId ?? null
  const officialEntries: readonly BuddyOfficialEntry[] =
    library && library.official.length > 0 ? library.official : CATALOG_OFFICIAL_ENTRIES
  const mine =
    library?.mine?.map(
      (entry): BuddyLibraryCard => ({
        id: entry.id,
        kind: 'mine',
        name: entry.name,
        subtitle: entry.description,
        hint: entry.description,
        slug: null,
        idleUrl: entry.poses.idle,
        active: entry.id === activeId,
        busy: entry.id === busyId,
        alive: entry.alive !== null,
        canMakeAlive: entry.alive === null
      })
    ) ?? null
  const serverId = library?.serverActiveAvatarId ?? null
  const serverName = serverId
    ? (officialBuddy(serverId)?.name ?? library?.mine?.find((entry) => entry.id === serverId)?.name)
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
export function buddyLibraryLimit(
  capabilities: Pick<AiCapabilities, 'cohost'> | null,
  library: Pick<BuddyLibraryState, 'limit'> | null
): number {
  return capabilities?.cohost?.buddyLibrary?.limit ?? library?.limit ?? BUDDY_LIBRARY_LIMIT
}

/** No room for another Buddy: the web's count when it sent one, else the cached list. */
export function buddyLibraryIsFull(
  capabilities: Pick<AiCapabilities, 'cohost'> | null,
  library: Pick<BuddyLibraryState, 'limit' | 'mine'> | null
): boolean {
  const limit = buddyLibraryLimit(capabilities, library)
  const count = capabilities?.cohost?.buddyLibrary?.count ?? library?.mine?.length ?? 0
  return limit > 0 && count >= limit
}

// --- The first-launch invitation (D16) ---------------------------------------

/** Remembered per machine, like the other one-time Buddy cards. */
export const BUDDY_INVITATION_STORAGE_KEY = 'videorc.buddyInvitationDismissed'

/**
 * "Make this Buddy your own, or pick another.": only while the persona is
 * the untouched default Buddy (the library says `official:golem` and the
 * persona has no link of its own) and the streamer has not closed it.
 */
export function buddyInvitationVisible({
  library,
  persona,
  dismissed
}: {
  library: Pick<BuddyLibraryState, 'activeAvatarId'> | null
  persona: Pick<CohostPersona, 'libraryAvatarId' | 'source'> | null
  dismissed: boolean
}): boolean {
  if (dismissed || !library || !persona) return false
  return (
    library.activeAvatarId === BUDDY_DEFAULT_OFFICIAL_ID &&
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

export function readBuddyInvitationDismissed(
  storage: Pick<Storage, 'getItem'> | null = localStorageOrNull()
): boolean {
  try {
    const raw = storage?.getItem(BUDDY_INVITATION_STORAGE_KEY)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

/** Best effort: blocked storage keeps it closed for this window's life only. */
export function writeBuddyInvitationDismissed(
  storage: Pick<Storage, 'setItem'> | null = localStorageOrNull()
): void {
  try {
    storage?.setItem(BUDDY_INVITATION_STORAGE_KEY, '1')
  } catch {
    // Not remembering it is harmless: it shows again next launch.
  }
}

// --- The onboarding's steps (D14) --------------------------------------------

export type BuddyOnboardingStep = 1 | 2 | 3 | 4

export function isBuddyOnboardingStep(value: number): value is BuddyOnboardingStep {
  return Number.isInteger(value) && value >= 1 && value <= BUDDY_ONBOARDING_STEP_COUNT
}

/** What the streamer has entered so far (the picture itself lives in the sheet). */
export interface BuddyOnboardingInput {
  description: string
  hasPicture: boolean
  name: string
  personality: string
  about: string
  /** "Skip for now" on step 3: create without the personality and About you. */
  skipDetails: boolean
}

export const EMPTY_BUDDY_ONBOARDING_INPUT: BuddyOnboardingInput = {
  description: '',
  hasPicture: false,
  name: '',
  personality: '',
  about: '',
  skipDetails: false
}

/** Characters as a person counts them (an emoji is one). */
export function buddyTextLength(value: string): number {
  return [...value].length
}

/** The name as it is sent: trimmed, 1 to 24 characters; null when it cannot be. */
export function buddyOnboardingName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  return buddyTextLength(trimmed) > BUDDY_LIBRARY_NAME_MAX_CHARS ? null : trimmed
}

/** Step 2 is done with a description, a picture, or both. */
export function buddyOnboardingHasLook(input: BuddyOnboardingInput): boolean {
  return input.description.trim().length > 0 || input.hasPicture
}

/**
 * Whether Next works on `step`: step 1 always; step 2 with a description
 * (at most 600) or a picture; step 3 with a name (1 to 24) and the optional
 * fields within their bounds. Step 4 has no Next.
 */
export function buddyOnboardingCanAdvance(
  step: BuddyOnboardingStep,
  input: BuddyOnboardingInput
): boolean {
  switch (step) {
    case 1:
      return true
    case 2:
      return (
        buddyOnboardingHasLook(input) &&
        buddyTextLength(input.description.trim()) <= BUDDY_LIBRARY_DESCRIPTION_MAX_CHARS
      )
    case 3:
      return (
        buddyOnboardingName(input.name) !== null &&
        buddyTextLength(input.personality) <= BUDDY_LIBRARY_PERSONALITY_MAX_CHARS &&
        buddyTextLength(input.about) <= BUDDY_LIBRARY_CONTEXT_MAX_CHARS
      )
    case 4:
      return false
  }
}

/** "Skip for now" shows on step 3 once the name is filled. */
export function buddyOnboardingCanSkip(
  step: BuddyOnboardingStep,
  input: BuddyOnboardingInput
): boolean {
  return step === 3 && buddyOnboardingName(input.name) !== null
}

/** The furthest step the input allows (a later step needs every earlier one done). */
export function buddyOnboardingReachable(
  target: BuddyOnboardingStep,
  input: BuddyOnboardingInput
): BuddyOnboardingStep {
  let step: BuddyOnboardingStep = 1
  while (step < target && buddyOnboardingCanAdvance(step, input)) {
    step = (step + 1) as BuddyOnboardingStep
  }
  return step
}

/**
 * `cohost.avatar.create` with every field the streamer filled: the look
 * (description, picture), the name, and the personality and About you
 * unless step 3 was skipped. Empty optional fields are left out.
 */
export function buddyOnboardingCreateParams(
  input: BuddyOnboardingInput,
  inspirationBase64: string | null
): CohostAvatarCreateParams {
  const description = input.description.trim()
  const name = buddyOnboardingName(input.name)
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

export type BuddyCreateGateAction = 'sign-in' | 'see-premium' | 'start-from-ours' | 'allow-cloud-ai'

export interface BuddyCreateGate {
  kind: 'signed-out' | 'premium' | 'cloud-ai' | 'full' | 'unavailable' | 'allowance'
  line: string
  actions: BuddyCreateGateAction[]
}

/**
 * Why "Create my Buddy" cannot run now, or null when it can. The checks run
 * in the order a streamer can fix them: the account, Premium, Cloud AI
 * consent, room in the library, a web that offers the look, then today's
 * images (a Buddy is four).
 */
export function buddyCreateGate({
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
  library: Pick<BuddyLibraryState, 'limit' | 'mine'> | null
}): BuddyCreateGate | null {
  if (!signedIn) {
    return { kind: 'signed-out', line: BUDDY_ONBOARDING_GATES.signedOut, actions: ['sign-in'] }
  }
  if (!gate.allowed) {
    return {
      kind: 'premium',
      line: BUDDY_ONBOARDING_GATES.free,
      actions: ['see-premium', 'start-from-ours']
    }
  }
  if (!consented) {
    return {
      kind: 'cloud-ai',
      line: BUDDY_ONBOARDING_GATES.cloudAiOff,
      actions: ['allow-cloud-ai']
    }
  }
  if (buddyLibraryIsFull(capabilities, library)) {
    return {
      kind: 'full',
      line: buddyLibraryFullLine(buddyLibraryLimit(capabilities, library)),
      actions: []
    }
  }
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) {
    return { kind: 'unavailable', line: BUDDY_GENERATE_NOT_AVAILABLE, actions: [] }
  }
  if (avatar.remainingToday < BUDDY_LOOK_CREATE_IMAGES) {
    return { kind: 'allowance', line: BUDDY_ONBOARDING_GATES.allowanceUsed, actions: [] }
  }
  return null
}

/** "Uses 4 of your 20 images left today.", when the web reported today's images. */
export function buddyOnboardingAllowanceLine(
  capabilities: Pick<AiCapabilities, 'cohost'> | null
): string | null {
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) return null
  return buddyOnboardingAllowance(avatar.remainingToday)
}

/**
 * The one line for a create that made nothing, by the web's code: a gate
 * the app could not see coming gets the gate's own line, anything else the
 * plain failure (a failed idle meters nothing).
 */
export function buddyCreateFailureLine(
  problem: { code: string } | null,
  limit: number = BUDDY_LIBRARY_LIMIT
): string | null {
  if (!problem) return null
  switch (problem.code) {
    case 'buddy-library-full':
      return buddyLibraryFullLine(limit)
    case 'quota-exhausted':
      return BUDDY_ONBOARDING_GATES.allowanceUsed
    case 'premium-required':
      return BUDDY_ONBOARDING_GATES.free
    case 'unauthorized':
      return BUDDY_ONBOARDING_GATES.signedOut
    default:
      return BUDDY_ONBOARDING_GATES.failed
  }
}
