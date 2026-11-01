import { useSyncExternalStore } from 'react'

import {
  EMPTY_BUDDY_ONBOARDING_INPUT,
  type BuddyOnboardingInput,
  type BuddyOnboardingStep
} from './buddy-library-view'
import type { BuddyLookPicture } from './buddy-look-view'

// What the streamer typed into the four-step onboarding, kept outside the
// sheet (plan 174 S3.15a, G-12): it survives a sub-tab switch (the sheet
// unmounts), a stray click outside it, and closing it, until a Buddy is made
// or used. One module-level store, like the Alive creator's open flag, so the
// sheet and whoever opens it need no provider.

/** The inspiration picture as chosen: its name, an object URL for the thumbnail, and what is sent. */
export interface BuddyOnboardingPicture {
  name: string
  url: string
  prepared: BuddyLookPicture
}

export interface BuddyOnboardingDraft {
  input: BuddyOnboardingInput
  picture: BuddyOnboardingPicture | null
  /** The step the sheet was on; it reopens there, as far as the input allows. */
  step: BuddyOnboardingStep
  /**
   * Plan 174 G-13, "Start a new one": the draft left in the library to begin
   * again from scratch (its request id), until the next draft replaces it.
   */
  leftBehindDraftId: string | null
}

export const EMPTY_BUDDY_ONBOARDING_DRAFT: BuddyOnboardingDraft = {
  input: EMPTY_BUDDY_ONBOARDING_INPUT,
  picture: null,
  step: 1,
  leftBehindDraftId: null
}

let draft: BuddyOnboardingDraft = EMPTY_BUDDY_ONBOARDING_DRAFT
const draftListeners = new Set<() => void>()

function emitDraft(): void {
  for (const listener of draftListeners) listener()
}

function subscribeDraft(listener: () => void): () => void {
  draftListeners.add(listener)
  return () => {
    draftListeners.delete(listener)
  }
}

export function readBuddyOnboardingDraft(): BuddyOnboardingDraft {
  return draft
}

export function patchBuddyOnboardingDraft(patch: Partial<BuddyOnboardingDraft>): void {
  draft = { ...draft, ...patch }
  emitDraft()
}

export function patchBuddyOnboardingInput(patch: Partial<BuddyOnboardingInput>): void {
  patchBuddyOnboardingDraft({ input: { ...draft.input, ...patch } })
}

/**
 * Forget everything typed (a Buddy was made or used, or the streamer starts
 * over). The picture's object URL is the caller's to revoke: the store never
 * touches the DOM.
 */
export function clearBuddyOnboardingDraft(): void {
  draft = EMPTY_BUDDY_ONBOARDING_DRAFT
  emitDraft()
}

/** Anything typed or chosen: a stray click outside the sheet must not lose it. */
export function buddyOnboardingDraftDirty(
  current: Pick<BuddyOnboardingDraft, 'input' | 'picture'>
): boolean {
  const { description, name, personality, about } = current.input
  return (
    current.picture !== null ||
    [description, name, personality, about].some((value) => value.trim().length > 0)
  )
}

export function useBuddyOnboardingDraft(): BuddyOnboardingDraft {
  return useSyncExternalStore(subscribeDraft, readBuddyOnboardingDraft, readBuddyOnboardingDraft)
}

// --- Opening the sheet from elsewhere ----------------------------------------

/** An ask to open the onboarding (the Alive creator's "New Buddy…", G-4); My Buddies hosts it. */
export interface BuddyOnboardingRequest {
  nonce: number
  step: BuddyOnboardingStep
}

let request: BuddyOnboardingRequest | null = null
const requestListeners = new Set<() => void>()

function subscribeRequest(listener: () => void): () => void {
  requestListeners.add(listener)
  return () => {
    requestListeners.delete(listener)
  }
}

export function requestBuddyOnboarding(step: BuddyOnboardingStep = 1): void {
  request = { nonce: (request?.nonce ?? 0) + 1, step }
  for (const listener of requestListeners) listener()
}

export function readBuddyOnboardingRequest(): BuddyOnboardingRequest | null {
  return request
}

/** Tests start from nothing asked. */
export function clearBuddyOnboardingRequest(): void {
  request = null
  for (const listener of requestListeners) listener()
}

export function useBuddyOnboardingRequest(): BuddyOnboardingRequest | null {
  return useSyncExternalStore(
    subscribeRequest,
    () => request,
    () => request
  )
}
