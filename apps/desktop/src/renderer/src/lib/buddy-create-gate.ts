import type { AiCapabilities, BuddyLibraryState } from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import { buddyLibraryIsFull, buddyLibraryLimit } from './buddy-library-view'
import { BUDDY_LOOK_CREATE_IMAGES } from './buddy-look-view'
import { BUDDY_ONBOARDING_GATES, buddyLibraryFullLine } from './buddy-onboarding-copy'
import { BUDDY_GENERATE_NOT_AVAILABLE } from './buddy-persona-view'
import { plural } from './format'
import { VIDEORC_PREMIUM_URL } from './premium-upgrade'

// One gate model for creating a Buddy (plan 174 S3.15a, G-5): a new look
// (the onboarding, Redo on a draft) and an Alive Buddy (the creator, Create
// under Alive) ask the same questions in the order a streamer can fix them,
// and every answer is one line with at most one action. One Alert draws it
// (`components/buddy-create-gate-alert.tsx`); the controls under it are off.

export type BuddyCreateGateKind =
  | 'signed-out'
  | 'premium'
  | 'cloud-ai'
  | 'full'
  | 'unavailable'
  | 'allowance'

export type BuddyCreateGateAction =
  | { kind: 'sign-in' }
  | { kind: 'view-premium'; url: string }
  | { kind: 'allow-cloud-ai' }

export interface BuddyCreateGate {
  kind: BuddyCreateGateKind
  /** The one line that says why. */
  reason: string
  /** The one thing that turns it back on, when there is one. */
  action: BuddyCreateGateAction | null
}

// The Alive creator's lines, one family with the onboarding's (G-15).
export const BUDDY_ALIVE_SIGNED_OUT = 'Sign in to create an Alive Buddy.'
export const BUDDY_ALIVE_PREMIUM = 'Creating an Alive Buddy is part of Videorc Premium.'
export const BUDDY_ALIVE_CONSENT_OFF = 'Allow cloud AI to create an Alive Buddy.'
export const BUDDY_ALIVE_NONE_LEFT = "This month's creations are used up."

/** Nothing left this month: the creator's one gate for starting a new creation. */
export const BUDDY_ALIVE_NONE_LEFT_GATE: BuddyCreateGate = {
  kind: 'allowance',
  reason: BUDDY_ALIVE_NONE_LEFT,
  action: null
}

export interface BuddyCreateGateInput {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}

function premiumAction(gate: EntitlementUiGate): BuddyCreateGateAction {
  return {
    kind: 'view-premium',
    url: (!gate.allowed && gate.upgradeUrl) || VIDEORC_PREMIUM_URL
  }
}

/**
 * Why a new look cannot be made now, or null when it can: the account,
 * Premium, cloud AI consent, room in the library, a web that offers the
 * look, then today's images (a Buddy is four).
 */
export function buddyLookCreateGate(
  input: BuddyCreateGateInput & {
    library: Pick<BuddyLibraryState, 'limit' | 'mine'> | null
  }
): BuddyCreateGate | null {
  return lookGate(input, input.library, BUDDY_LOOK_CREATE_IMAGES)
}

/**
 * Why Redo on a draft's pose cannot run now, or null when it can: the same
 * questions, without the library's room (the draft is in it already), and
 * one image is enough.
 */
export function buddyLookRedoGate(input: BuddyCreateGateInput): BuddyCreateGate | null {
  return lookGate(input, null, 1)
}

function lookGate(
  { signedIn, gate, consented, capabilities }: BuddyCreateGateInput,
  library: Pick<BuddyLibraryState, 'limit' | 'mine'> | null,
  images: number
): BuddyCreateGate | null {
  if (!signedIn) {
    return {
      kind: 'signed-out',
      reason: BUDDY_ONBOARDING_GATES.signedOut,
      action: { kind: 'sign-in' }
    }
  }
  if (!gate.allowed) {
    return { kind: 'premium', reason: BUDDY_ONBOARDING_GATES.free, action: premiumAction(gate) }
  }
  if (!consented) {
    return {
      kind: 'cloud-ai',
      reason: BUDDY_ONBOARDING_GATES.cloudAiOff,
      action: { kind: 'allow-cloud-ai' }
    }
  }
  if (library && buddyLibraryIsFull(capabilities, library)) {
    return {
      kind: 'full',
      reason: buddyLibraryFullLine(buddyLibraryLimit(capabilities, library)),
      action: null
    }
  }
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) {
    return { kind: 'unavailable', reason: BUDDY_GENERATE_NOT_AVAILABLE, action: null }
  }
  if (avatar.remainingToday < images) {
    return { kind: 'allowance', reason: BUDDY_ONBOARDING_GATES.allowanceUsed, action: null }
  }
  return null
}

/**
 * Why an Alive Buddy cannot be made now, or null when it can: the account,
 * Premium, cloud AI consent, a web that offers creation, then this month's
 * creations.
 */
export function buddyAliveCreateGate({
  signedIn,
  gate,
  consented,
  capabilities
}: BuddyCreateGateInput): BuddyCreateGate | null {
  if (!signedIn) {
    return { kind: 'signed-out', reason: BUDDY_ALIVE_SIGNED_OUT, action: { kind: 'sign-in' } }
  }
  if (!gate.allowed) {
    return { kind: 'premium', reason: BUDDY_ALIVE_PREMIUM, action: premiumAction(gate) }
  }
  if (!consented) {
    return { kind: 'cloud-ai', reason: BUDDY_ALIVE_CONSENT_OFF, action: { kind: 'allow-cloud-ai' } }
  }
  const pet = capabilities?.cohost?.pet
  if (!pet?.enabled) {
    return { kind: 'unavailable', reason: BUDDY_GENERATE_NOT_AVAILABLE, action: null }
  }
  if (pet.creationsRemainingThisMonth <= 0) return BUDDY_ALIVE_NONE_LEFT_GATE
  return null
}

/** "Redo · 1 image": what a redo spends, on its button (G-14). */
export function buddyRedoLabel(redo: string): string {
  return `${redo} · 1 image`
}

/** "12 images left today", when the web reported today's images; null otherwise. */
export function buddyImagesLeftLine(
  capabilities: Pick<AiCapabilities, 'cohost'> | null
): string | null {
  const avatar = capabilities?.cohost?.avatar
  if (!avatar?.enabled) return null
  return `${plural(avatar.remainingToday, 'image')} left today`
}
