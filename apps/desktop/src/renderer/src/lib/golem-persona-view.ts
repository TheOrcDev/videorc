import type { CohostAvatarState, CohostBubbleStyle, CohostPersona } from './backend'
import { GOLEM_MOTION_DEFAULTS } from '../../../shared/golem-pet'

// The Golem creation screen (plan 164 S-A4): pure derivations the section
// and its tests share. The look's own derivations live in golem-look-view.ts
// (plan 169).

export const GOLEM_NAME_MAX_CHARS = 24
export const GOLEM_PERSONALITY_MAX_CHARS = 1200

export const GOLEM_STATE_LABELS: Record<CohostAvatarState, string> = {
  idle: 'Idle',
  talk: 'Talking',
  laugh: 'Laughing',
  think: 'Thinking'
}

export const GOLEM_BUBBLE_STYLES: readonly CohostBubbleStyle[] = ['speech', 'thought', 'shout']
export const GOLEM_BUBBLE_LABELS: Record<CohostBubbleStyle, string> = {
  speech: 'Speech',
  thought: 'Thought',
  shout: 'Shout'
}

/** Three personalities one click away (⚑ copy, plan 164 S-A4). */
export const GOLEM_PERSONALITY_EXAMPLES: readonly string[] = [
  'Grumpy old orc who secretly loves chat',
  'Cheerful goblin merchant',
  'Deadpan stone golem'
]

export const GOLEM_NAME_REQUIRED = 'The Golem needs a name.'
/** The look's hints (plan 164 S-A4, kept by plan 169 D13). */
export const GOLEM_GENERATE_NOT_AVAILABLE = 'Not available yet'
export const GOLEM_GENERATE_SIGNED_OUT = 'Sign in to generate images.'
export const GOLEM_GENERATE_CONSENT_OFF = 'Allow cloud AI below to generate images.'
export const GOLEM_GENERATE_QUOTA = 'Daily avatar limit reached'

/** The name as it would be saved, or null when it cannot be. */
export function golemNameToSave(draft: string): string | null {
  const name = draft.trim()
  if (!name) return null
  return [...name].length > GOLEM_NAME_MAX_CHARS ? null : name
}

/** A fresh persona for "Start over": a new id, the default name and pack. */
export function freshGolemPersona(id: string): CohostPersona {
  return {
    id,
    name: 'Golem',
    personality: '',
    bubbleStyle: 'speech',
    images: {},
    source: 'default',
    avatar: { kind: 'still' },
    motion: { ...GOLEM_MOTION_DEFAULTS },
    reactions: {}
  }
}
