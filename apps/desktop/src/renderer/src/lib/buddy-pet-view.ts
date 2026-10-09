import type { AiCapabilities, BuddyPetSummary, BuddyTrigger } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import {
  BUDDY_SLEEP_AFTER_MAX_SECONDS,
  BUDDY_TRIGGER_DEFAULT_REACTIONS,
  type BuddyReactionTable
} from '../../../shared/buddy-pet'
import { BUDDY_GENERATE_NOT_AVAILABLE } from '@/lib/buddy-persona-view'

// The Buddy tab's Avatar, Reactions and Motion sections and the Stream
// Manager's reaction chips (plan 168 Phase D): pure copy and derivations the
// components and their tests share.

/** D2's two avatar kinds (owner names, plan 168 open question 1). */
export const BUDDY_AVATAR_KIND_LABELS = { still: 'Still', alive: 'Alive' } as const

/** The `packId` the living preview takes for the Still avatar (the flat pack). */
export const BUDDY_STILL_PACK_ID = 'still'

/** The preview's drawn size on the Buddy tab and in the Stream Manager header. */
export const BUDDY_TAB_PREVIEW_PX = 160
export const BUDDY_HEADER_PREVIEW_PX = 32

/** One trigger's row: what happens, and the events it covers. */
export const BUDDY_TRIGGER_COPY: Readonly<Record<BuddyTrigger, { title: string; detail: string }>> =
  {
    follow: { title: 'Follow', detail: 'A new follower' },
    subscription: { title: 'Sub', detail: 'Subs, resubs and memberships' },
    gift: { title: 'Gifted subs', detail: 'One gift or a community gift' },
    tip: { title: 'Cheer or tip', detail: 'Bits, Kicks, Super Chats, stickers and Power-ups' },
    raid: { title: 'Raid', detail: 'Another channel raids you' },
    'watch-streak': { title: 'Watch streak', detail: 'A viewer shares their streak' },
    redemption: { title: 'Reward redeemed', detail: 'Channel points and rewards' },
    'destination-failed': { title: 'A destination fails', detail: 'Off by default' }
  }

/** The Reactions list, sectioned: what viewers do, then what the stream does. */
export const BUDDY_TRIGGER_SECTIONS: readonly {
  label: string
  triggers: readonly BuddyTrigger[]
}[] = [
  {
    label: 'Viewers',
    triggers: ['follow', 'subscription', 'gift', 'tip', 'raid', 'watch-streak', 'redemption']
  },
  { label: 'Your stream', triggers: ['destination-failed'] }
]

/** Reactions a trigger or a chip never picks: idle frames, not reactions to people. */
export const BUDDY_IDLE_REACTION_IDS: readonly string[] = ['blink', 'sleep']

/** "laugh" → "Laugh", "talk-a" → "Talk a". */
export function buddyReactionLabel(id: string): string {
  const words = id.replace(/-/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : id
}

/** The reactions a trigger may pick from a pack: every reaction but blink and sleep. */
export function buddyChoosableReactions(reactions: readonly string[]): string[] {
  return reactions.filter((id) => !BUDDY_IDLE_REACTION_IDS.includes(id))
}

/** What a trigger does with the active pack (D14). */
export type BuddyTriggerOutcome =
  | { kind: 'reaction'; id: string }
  /** The pack has no frame for it: a motion-only hop with that id's pose. */
  | { kind: 'hop'; id: string }
  | { kind: 'none' }

/**
 * D14 for one trigger: the persona's override when set (`none` turns it
 * off), else the default chain's first id the pack has, else a motion-only
 * hop; a trigger without defaults (a failed destination) does nothing.
 */
export function buddyTriggerOutcome(
  trigger: BuddyTrigger,
  table: BuddyReactionTable,
  packReactions: readonly string[]
): BuddyTriggerOutcome {
  const override = table[trigger]
  if (override === 'none') return { kind: 'none' }
  if (override) {
    return packReactions.includes(override)
      ? { kind: 'reaction', id: override }
      : { kind: 'hop', id: override }
  }
  const chain = BUDDY_TRIGGER_DEFAULT_REACTIONS[trigger]
  if (chain.length === 0) return { kind: 'none' }
  const found = chain.find((id) => packReactions.includes(id))
  return found ? { kind: 'reaction', id: found } : { kind: 'hop', id: chain[0]! }
}

/** The Select value for "use D14's default"; never a reaction id (ids are `[a-z0-9-]`). */
export const BUDDY_REACTION_DEFAULT_VALUE = '__default'

export function buddyOutcomeLabel(outcome: BuddyTriggerOutcome): string {
  if (outcome.kind === 'none') return 'None'
  if (outcome.kind === 'hop') return 'Hop'
  return buddyReactionLabel(outcome.id)
}

/** The table with one trigger set to an id, `none`, or back to its default. */
export function withBuddyTriggerReaction(
  table: BuddyReactionTable,
  trigger: BuddyTrigger,
  value: string
): BuddyReactionTable {
  const next = { ...table }
  if (value === BUDDY_REACTION_DEFAULT_VALUE) delete next[trigger]
  else next[trigger] = value
  return next
}

/** Sleep after (D13): Never and a few minutes; 0 means never. */
export const BUDDY_SLEEP_CHOICES: readonly number[] = [0, 60, 180, 300, 600]

export function buddySleepLabel(seconds: number): string {
  if (seconds <= 0) return 'Never'
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** The choices to list: the standard ones plus a stored value outside them. */
export function buddySleepChoices(current: number): number[] {
  if (BUDDY_SLEEP_CHOICES.includes(current) || current > BUDDY_SLEEP_AFTER_MAX_SECONDS) {
    return [...BUDDY_SLEEP_CHOICES]
  }
  return [...BUDDY_SLEEP_CHOICES, current].sort((a, b) => a - b)
}

/** The Motion slider's ticks; Calm is page-pet's default, the owner's 0.45. */
export const BUDDY_MOTION_TICKS: readonly { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: 'Calm', value: 0.45 },
  { label: 'Lively', value: 1 }
]

/** "Imported", "Made in Videorc", or "Built in" for a pack Videorc ships. */
export function buddyPetSourceLabel(pack: Pick<BuddyPetSummary, 'packId' | 'source'>): string {
  if (pack.packId.startsWith('bundled:')) return 'Built in'
  if (pack.source === 'videorc-creator') return 'Made in Videorc'
  if (pack.source === 'page-pet-import') return 'Imported'
  return 'Still'
}

/** "37 poses": every gaze cell and every reaction. */
export function buddyPetPosesLabel(pack: Pick<BuddyPetSummary, 'gazeCount' | 'reactions'>): string {
  const count = pack.gazeCount + pack.reactions.length
  return `${count} ${count === 1 ? 'pose' : 'poses'}`
}

/** The pack an Alive switch wears first: the persona's own, else the one Videorc ships. */
export function buddyFirstPack(packs: readonly BuddyPetSummary[]): BuddyPetSummary | null {
  return packs.find((pack) => !pack.packId.startsWith('bundled:')) ?? packs[0] ?? null
}

// --- Create (Phase F's creator, D20) -----------------------------------------

/** The web's `cohost.pet` capability block (Phase E), read leniently: older
 * servers omit it and its numbers may be missing. */
export interface BuddyPetCapability {
  enabled: boolean
  remaining: number | null
  limit: number | null
}

const finiteCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null

export function buddyPetCapability(
  capabilities: Pick<AiCapabilities, 'cohost'> | null | undefined
): BuddyPetCapability | null {
  const cohost = capabilities?.cohost as Record<string, unknown> | undefined
  const pet = cohost?.pet
  if (!pet || typeof pet !== 'object') return null
  const block = pet as Record<string, unknown>
  return {
    enabled: block.enabled === true,
    remaining: finiteCount(block.creationsRemainingThisMonth),
    limit: finiteCount(block.monthlyLimit)
  }
}

export const BUDDY_CREATE_SIGNED_OUT = 'Sign in to create a living Buddy.'
export const BUDDY_CREATE_CONSENT_OFF = 'Allow cloud AI below to create a living Buddy.'
export const BUDDY_CREATE_USED_UP = 'No creations left this month'

export interface BuddyPetCreateAvailability {
  allowed: boolean
  /** The one tertiary line under the actions when Create is off. */
  reason: string | null
  /** "2 of 3 left this month", when the web reports the numbers. */
  allowance: string | null
}

/**
 * Whether Create opens the creator (D20): signed in, Premium, cloud AI
 * allowed, and a web that offers pet creation with creations left. The
 * checks run in the order a streamer can fix them.
 */
export function buddyPetCreateAvailability({
  signedIn,
  gate,
  consented,
  capabilities
}: {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): BuddyPetCreateAvailability {
  const pet = buddyPetCapability(capabilities)
  const allowance =
    pet?.enabled && pet.remaining !== null && pet.limit !== null
      ? `${pet.remaining} of ${pet.limit} left this month`
      : null
  if (!signedIn) return { allowed: false, reason: BUDDY_CREATE_SIGNED_OUT, allowance }
  if (!gate.allowed) return { allowed: false, reason: gate.reason, allowance }
  if (!consented) return { allowed: false, reason: BUDDY_CREATE_CONSENT_OFF, allowance }
  if (!pet?.enabled) return { allowed: false, reason: BUDDY_GENERATE_NOT_AVAILABLE, allowance }
  if (pet.remaining !== null && pet.remaining <= 0) {
    return { allowed: false, reason: BUDDY_CREATE_USED_UP, allowance }
  }
  return { allowed: true, reason: null, allowance }
}

// --- Stream Manager (S-D3) ----------------------------------------------------

/** The Say box's reaction chips (S-C3.4 ⚑). */
export const BUDDY_REACTION_CHIPS: readonly { id: string; label: string }[] = [
  { id: 'laugh', label: 'Laugh' },
  { id: 'wave', label: 'Wave' },
  { id: 'surprised', label: 'Surprised' },
  { id: 'proud', label: 'Proud' }
]
