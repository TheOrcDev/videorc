import type { CohostAvatarState, CohostBubbleStyle, CohostPersona } from './backend'
import { BUDDY_DEFAULT_OFFICIAL_ID, officialBuddy } from '../../../shared/buddy-library'
import { BUDDY_MOTION_DEFAULTS } from '../../../shared/buddy-pet'

// The Buddy creation screen (plan 164 S-A4): pure derivations the section
// and its tests share. The look's own derivations live in buddy-look-view.ts
// (plan 169).

export const BUDDY_NAME_MAX_CHARS = 24
export const BUDDY_PERSONALITY_MAX_CHARS = 1200

export const BUDDY_STATE_LABELS: Record<CohostAvatarState, string> = {
  idle: 'Idle',
  talk: 'Talking',
  laugh: 'Laughing',
  think: 'Thinking'
}

export const BUDDY_BUBBLE_STYLES: readonly CohostBubbleStyle[] = ['speech', 'thought', 'shout']
export const BUDDY_BUBBLE_LABELS: Record<CohostBubbleStyle, string> = {
  speech: 'Speech',
  thought: 'Thought',
  shout: 'Shout'
}

/** Three personalities one click away (⚑ copy, plan 164 S-A4). */
export const BUDDY_PERSONALITY_EXAMPLES: readonly string[] = [
  'Grumpy old orc who secretly loves chat',
  'Cheerful goblin merchant',
  'Deadpan stone golem'
]

export const BUDDY_NAME_REQUIRED = 'It needs a name.'
/**
 * "Not available", in the one gate family every creating surface uses (plan
 * 174 G-15, G-5): the look, the Alive creator and the library's New Buddy.
 * The rest of the family is `buddy-create-gate.ts`.
 */
export const BUDDY_GENERATE_NOT_AVAILABLE = "Creating isn't available right now."

/** The name as it would be saved, or null when it cannot be. */
export function buddyNameToSave(draft: string): string | null {
  const name = draft.trim()
  if (!name) return null
  return [...name].length > BUDDY_NAME_MAX_CHARS ? null : name
}

/**
 * What the default Buddy wears (plan 172 D5): Alive with the pack the app
 * ships with it, as a fresh install and Use on its official card give.
 */
function defaultBuddyAvatar(): CohostPersona['avatar'] {
  const alive = officialBuddy(BUDDY_DEFAULT_OFFICIAL_ID)?.alive
  return alive?.bundled ? { kind: 'alive', packId: alive.packId } : { kind: 'still' }
}

/** A fresh persona for "Start over": a new id, the default name and pack. */
export function freshBuddyPersona(id: string): CohostPersona {
  return {
    id,
    name: 'Buddy',
    personality: '',
    bubbleStyle: 'speech',
    images: {},
    source: 'default',
    avatar: defaultBuddyAvatar(),
    motion: { ...BUDDY_MOTION_DEFAULTS },
    reactions: {}
  }
}
