import type { AnimatorAvatarState, AnimatorEvent } from './buddy-animator'

/**
 * Plan 249 S5: `cohost.pet.animator`, the backend's public projection of an
 * animator input (`buddy_sprite::PublicAnimatorEvent`). Plan 164's state
 * and/or one event; never text, prompts or the persona's reaction table.
 * Dependency-free so the eager contract stays small.
 */
export interface CohostPetAnimatorEvent {
  avatarState?: AnimatorAvatarState
  event?: AnimatorEvent
}

const STATES = new Set(['idle', 'talk', 'laugh', 'think'])
const MOODS = new Set(['talk', 'laugh', 'think'])
const BARE = new Set(['utterance-end', 'think', 'think-settle', 'highlight-idle', 'chat'])
const REACTION_ID = /^[a-z0-9-]{1,40}$/
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))

function parseEvent(v: unknown): AnimatorEvent | null {
  if (!isObject(v) || typeof v.kind !== 'string') return null
  if (BARE.has(v.kind)) return keys(v, ['kind']) ? ({ kind: v.kind } as AnimatorEvent) : null
  switch (v.kind) {
    case 'utterance':
      return keys(v, ['kind', 'mood', 'chars', 'bubbleSeconds']) &&
        MOODS.has(v.mood as string) &&
        Number.isSafeInteger(v.chars) &&
        inRange(v.chars, 0, 4000) &&
        inRange(v.bubbleSeconds, 0, 120)
        ? {
            kind: 'utterance',
            mood: v.mood as 'talk',
            chars: v.chars as number,
            bubbleSeconds: v.bubbleSeconds
          }
        : null
    case 'reaction':
      return keys(v, ['kind', 'chain', 'activity']) &&
        Array.isArray(v.chain) &&
        v.chain.length <= 8 &&
        v.chain.every((id) => typeof id === 'string' && REACTION_ID.test(id)) &&
        typeof v.activity === 'boolean'
        ? { kind: 'reaction', chain: [...(v.chain as string[])], activity: v.activity }
        : null
    case 'highlight':
      return keys(v, ['kind', 'ttlSeconds']) && inRange(v.ttlSeconds, 0, 600)
        ? { kind: 'highlight', ttlSeconds: v.ttlSeconds }
        : null
    case 'settings': {
      const s = v.settings
      return keys(v, ['kind', 'settings']) &&
        isObject(s) &&
        keys(s, ['intensity', 'sleepAfterSeconds', 'breathing']) &&
        inRange(s.intensity, 0, 1) &&
        Number.isSafeInteger(s.sleepAfterSeconds) &&
        inRange(s.sleepAfterSeconds, 0, 1800) &&
        typeof s.breathing === 'boolean'
        ? {
            kind: 'settings',
            settings: {
              intensity: s.intensity,
              sleepAfterSeconds: s.sleepAfterSeconds,
              breathing: s.breathing
            }
          }
        : null
    }
    default:
      return null
  }
}

export function parseCohostPetAnimatorEvent(value: unknown): CohostPetAnimatorEvent | null {
  if (!isObject(value) || !keys(value, ['avatarState', 'event'])) return null
  const out: CohostPetAnimatorEvent = {}
  if (value.avatarState !== undefined) {
    if (!STATES.has(value.avatarState as string)) return null
    out.avatarState = value.avatarState as AnimatorAvatarState
  }
  if (value.event !== undefined) {
    const event = parseEvent(value.event)
    if (!event) return null
    out.event = event
  }
  return out.avatarState || out.event ? out : null
}
