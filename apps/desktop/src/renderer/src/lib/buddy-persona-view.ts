import type { CohostAvatarState, CohostBubbleStyle, CohostPersona } from './backend'
import { BUDDY_MOTION_DEFAULTS } from '../../../shared/buddy-pet'

// The Golem creation screen (plan 164 S-A4): pure derivations the section
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

export const BUDDY_NAME_REQUIRED = 'The Golem needs a name.'
/** The look's hints (plan 164 S-A4, kept by plan 169 D13). */
export const BUDDY_GENERATE_NOT_AVAILABLE = 'Not available yet'
export const BUDDY_GENERATE_SIGNED_OUT = 'Sign in to generate images.'
export const BUDDY_GENERATE_CONSENT_OFF = 'Allow cloud AI below to generate images.'
export const BUDDY_GENERATE_QUOTA = 'Daily avatar limit reached'

/** The name as it would be saved, or null when it cannot be. */
export function buddyNameToSave(draft: string): string | null {
  const name = draft.trim()
  if (!name) return null
  return [...name].length > BUDDY_NAME_MAX_CHARS ? null : name
}

/** A fresh persona for "Start over": a new id, the default name and pack. */
export function freshBuddyPersona(id: string): CohostPersona {
  return {
    id,
    name: 'Golem',
    personality: '',
    bubbleStyle: 'speech',
    images: {},
    source: 'default',
    avatar: { kind: 'still' },
    motion: { ...BUDDY_MOTION_DEFAULTS },
    reactions: {}
  }
}
