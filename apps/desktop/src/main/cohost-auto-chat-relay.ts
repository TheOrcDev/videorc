import type { CohostAutoChatRelayPatch, CohostTalkMode } from '../shared/backend'

const TALK_MODES: readonly CohostTalkMode[] = ['off', 'bubble', 'suggest']

/**
 * The Stream Manager's `autoChat` relay block (plan 164 S-D6, plan 211 D3):
 * a partial of `talk` and the three switches. `undefined` when absent,
 * `false` when malformed, else the validated block.
 *
 * The renderer writes only `talk`; the legacy `mode` is the backend's
 * projection and is refused here, so no window can put `auto` (or anything
 * else) back into the stored block through the relay.
 */
export function cohostAutoChatRelayPatch(
  value: unknown
): CohostAutoChatRelayPatch | undefined | false {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const block = value as Record<string, unknown>
  if ('mode' in block) return false
  const patch: CohostAutoChatRelayPatch = {}
  if (block.talk !== undefined) {
    const talk = TALK_MODES.find((mode) => mode === block.talk)
    if (!talk) return false
    patch.talk = talk
  }
  for (const key of ['greetings', 'answers', 'banter'] as const) {
    if (block[key] === undefined) continue
    if (typeof block[key] !== 'boolean') return false
    patch[key] = block[key]
  }
  return patch
}
