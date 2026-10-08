import type { AiCapabilities, CohostAvatarState, CohostBubbleStyle, CohostPersona } from './backend'
import type { EntitlementUiGate } from './entitlement-ui'

// The Golem creation screen (plan 164 S-A4): pure derivations the section
// and its tests share.

export const GOLEM_NAME_MAX_CHARS = 24
export const GOLEM_PERSONALITY_MAX_CHARS = 1200
export const GOLEM_PROMPT_MAX_CHARS = 600

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

/** The generation style presets the web route takes (⚑, plan 164 S-A4). */
export type GolemAvatarStyle = 'cartoon' | 'pixel' | 'painted' | 'sticker'
export const GOLEM_AVATAR_STYLES: readonly GolemAvatarStyle[] = [
  'cartoon',
  'pixel',
  'painted',
  'sticker'
]
export const GOLEM_AVATAR_STYLE_LABELS: Record<GolemAvatarStyle, string> = {
  cartoon: 'Cartoon',
  pixel: 'Pixel',
  painted: 'Painted',
  sticker: 'Sticker'
}

export const GOLEM_NAME_REQUIRED = 'The Golem needs a name.'
export const GOLEM_GENERATE_NOT_AVAILABLE = 'Not available yet'
export const GOLEM_GENERATE_SIGNED_OUT = 'Sign in to generate images.'
export const GOLEM_GENERATE_CONSENT_OFF = 'Allow cloud AI below to generate images.'
export const GOLEM_GENERATE_QUOTA = 'Daily avatar limit reached'
export const GOLEM_OPAQUE_HINT = 'No transparency, upload a PNG with alpha for a clean cut'

/** The name as it would be saved, or null when it cannot be. */
export function golemNameToSave(draft: string): string | null {
  const name = draft.trim()
  if (!name) return null
  return [...name].length > GOLEM_NAME_MAX_CHARS ? null : name
}

export interface GolemGenerateAvailability {
  /** The Generate buttons work. */
  allowed: boolean
  /** The one tertiary line under the tiles when they do not; null when they do. */
  reason: string | null
  /** Today's remaining generations, when the web reported them. */
  remaining: number | null
}

/**
 * Whether avatar generation is on for this account (plan 164 D6, D21):
 * signed in, Premium, cloud AI allowed, and a web that reports the route.
 * The checks run in the order a streamer can fix them.
 */
export function golemGenerateAvailability({
  signedIn,
  gate,
  consented,
  capabilities
}: {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): GolemGenerateAvailability {
  const avatar = capabilities?.cohost?.avatar
  const remaining = avatar?.enabled ? avatar.remainingToday : null
  if (!signedIn) return { allowed: false, reason: GOLEM_GENERATE_SIGNED_OUT, remaining }
  if (!gate.allowed) return { allowed: false, reason: gate.reason, remaining }
  if (!consented) return { allowed: false, reason: GOLEM_GENERATE_CONSENT_OFF, remaining }
  if (!avatar?.enabled) return { allowed: false, reason: GOLEM_GENERATE_NOT_AVAILABLE, remaining }
  if (avatar.remainingToday <= 0) return { allowed: false, reason: GOLEM_GENERATE_QUOTA, remaining }
  return { allowed: true, reason: null, remaining }
}

/** A fresh persona for "Start over": a new id, the default name and pack. */
export function freshGolemPersona(id: string): CohostPersona {
  return {
    id,
    name: 'Golem',
    personality: '',
    bubbleStyle: 'speech',
    images: {},
    source: 'default'
  }
}

/** The persona with one state image set (or cleared), and its source updated. */
export function withGolemImage(
  persona: CohostPersona,
  state: CohostAvatarState,
  path: string | null,
  source: Exclude<CohostPersona['source'], 'default'>
): CohostPersona {
  const images = { ...persona.images }
  if (path) images[state] = path
  else delete images[state]
  const any = Object.values(images).some(Boolean)
  return { ...persona, images, source: any ? source : 'default' }
}
