import { SOUND_MAX_COUNT, type Sound, type SoundMode } from '@/lib/backend'
import { plural } from '@/lib/format'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { OFFLINE_REASON, UserFacingError, type UserErrorContext } from '@/lib/user-error'
import type { SoundRelayAction } from '../../../shared/sound-commands'

// Plan 189: the soundboard's words and rules every surface shares (Studio,
// Assets, Sources, the Stream Manager relay, ⌘K and the remotes). Pure: no
// React, no backend client. Never imported statically by eager code: the
// shell's host loads it when a relayed press arrives.

/** The press modes in the words the streamer reads (plan 189 Copy). */
export const SOUND_MODE_LABELS: Readonly<Record<SoundMode, string>> = {
  oneShot: 'Play once',
  toggle: 'Play/stop',
  loop: 'Loop',
  hold: 'While held'
}

/** Import refused at the cap (plan 189 D8, `SOUND_MAX_COUNT`). */
export const SOUND_COUNT_LIMIT_REASON = 'You have 24 sounds. Remove one to add another.'
/** Import refused at the total (D8, `SOUND_TOTAL_MAX_DURATION_MS`). */
export const SOUND_TOTAL_LIMIT_REASON =
  'Your sounds add up to 5 minutes. Remove one to add another.'

/**
 * The backend's refusals, verbatim (plan 189 "Import"). Each one is "can't
 * now" or "not this file", so it shows as a warning with this sentence,
 * never as an error or the generic next step (plan 174 S2.4).
 */
export const SOUND_REFUSALS: readonly string[] = [
  'This file has no sound Videorc can play.',
  'Sounds can be up to 30 seconds. Trim this one and try again.',
  'This file is silent.',
  SOUND_COUNT_LIMIT_REASON,
  SOUND_TOTAL_LIMIT_REASON
]

/** The refusals that stop a batch: no later file can get in either. */
const LIMIT_REFUSALS = new Set([SOUND_COUNT_LIMIT_REASON, SOUND_TOTAL_LIMIT_REASON])

/** The refusal sentence a failed `sounds.*` call carries, or null for any other failure. */
export function soundRefusal(error: unknown): string | null {
  const raw = ipcErrorMessage(error)
  return SOUND_REFUSALS.find((sentence) => raw.includes(sentence)) ?? null
}

/** True for a refusal no later import in the same batch can get past. */
export function isSoundLimitRefusal(sentence: string | null): boolean {
  return sentence !== null && LIMIT_REFUSALS.has(sentence)
}

/**
 * A failed call as the error `toastUserError` reads: a refusal, or a sound
 * that is gone, keeps its own sentence as a warning; anything else stays as
 * it is, for the usual copy.
 */
export function soundActionError(error: unknown): unknown {
  const sentence =
    soundRefusal(error) ??
    (ipcErrorMessage(error).includes(SOUND_ACTION_COPY.missing) ? SOUND_ACTION_COPY.missing : null)
  return sentence ? new UserFacingError(sentence, 'warning') : error
}

/** What a play or stop says when it can't run, on every surface. */
export const SOUND_ACTION_COPY = {
  missing: "That sound isn't available anymore.",
  play: "Couldn't play the sound.",
  press: "Couldn't play the sound.",
  stop: "Couldn't stop the sound.",
  stopAll: "Couldn't stop the sounds."
} as const

/** The verb and object a failed action names: "Couldn't stop the sounds". */
export function soundActionContext(action: SoundRelayAction['action']): UserErrorContext {
  return action === 'stopAll'
    ? { action: 'stop', object: 'the sounds' }
    : { action: action === 'stop' ? 'stop' : 'play', object: 'the sound' }
}

type SoundActionClient = { request<T>(method: string, params?: unknown): Promise<T> }

/** The RPC for one action: `sounds.play`, `.press` or `.stop`; no id stops every sound. */
export function requestSoundAction(
  client: SoundActionClient,
  action: SoundRelayAction
): Promise<unknown> {
  return action.action === 'stopAll'
    ? client.request('sounds.stop', {})
    : client.request(`sounds.${action.action}`, { id: action.id })
}

/**
 * One play, press or stop on Studio's backend connection, from a pad, a key,
 * the Stream Manager or a remote. A sound the board no longer has says so; a
 * refusal's own sentence comes back verbatim, any other failure the plain one.
 */
export async function runSoundAction(
  client: SoundActionClient,
  action: SoundRelayAction,
  sounds: readonly Pick<Sound, 'id'>[]
): Promise<{ ok: boolean; message?: string }> {
  if (action.action !== 'stopAll' && !sounds.some((sound) => sound.id === action.id)) {
    return { ok: false, message: SOUND_ACTION_COPY.missing }
  }
  try {
    await requestSoundAction(client, action)
    return { ok: true }
  } catch (error) {
    console.warn(`[sounds] ${action.action} failed:`, error)
    return { ok: false, message: soundRefusal(error) ?? SOUND_ACTION_COPY[action.action] }
  }
}

/** Why Stop all is off, in Studio and in the Stream Manager. */
export const STOP_ALL_IDLE_REASON = 'No sound is playing.'

/** Studio's line under Soundboard: where a press goes right now (plan 189 Copy). */
export function soundboardDescription(sessionActive: boolean, monitor: boolean): string {
  if (!sessionActive) return 'Only you hear sounds until you record or go live.'
  return monitor
    ? 'Sounds play in your recording and stream.'
    : "Sounds play in your recording and stream. You don't hear them yourself."
}

/**
 * Assets → Sounds: the count and the rules (plan 189 Copy, D8). Without a
 * count (the board hasn't loaded) it never claims none (J2-8).
 */
export function soundsSectionDescription(count: number | null): string {
  const rules = 'up to 30 seconds each · WAV, MP3, M4A, OGG or FLAC.'
  return count === null ? `Sounds ${rules}` : `${plural(count, 'sound')} · ${rules}`
}

/** A sound's length in Assets: "1.6 s", "30.0 s". */
export function formatSoundDuration(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)} s`
}

/** What the Import button is doing. */
export type SoundImportPhase = 'idle' | 'choosing' | 'importing'

export function soundImportLabel(phase: SoundImportPhase): string {
  return phase === 'choosing'
    ? 'Choosing sounds…'
    : phase === 'importing'
      ? 'Importing…'
      : 'Import sounds…'
}

/**
 * Why Import is off, or null when it can run. Recording or being live never
 * blocks it: only Videorc reconnecting, an import already running and the
 * 24-sound cap do.
 */
export function soundImportBlockedReason(state: {
  offline: boolean
  phase: SoundImportPhase
  count: number
}): string | null {
  if (state.offline) return OFFLINE_REASON
  if (state.phase !== 'idle') return 'Wait for this import to finish.'
  if (state.count >= SOUND_MAX_COUNT) return SOUND_COUNT_LIMIT_REASON
  return null
}

/**
 * Every id in board order after moving `id` to `targetIndex` (clamped), for
 * `sounds.reorder`; null when nothing moves.
 */
export function soundOrderAfterMove(
  sounds: readonly Pick<Sound, 'id'>[],
  id: string,
  targetIndex: number
): string[] | null {
  const ids = sounds.map((sound) => sound.id)
  const from = ids.indexOf(id)
  const to = Math.max(0, Math.min(ids.length - 1, targetIndex))
  if (from === -1 || from === to) return null
  ids.splice(from, 1)
  ids.splice(to, 0, id)
  return ids
}

/** The starter slugs the board no longer has, in the manifest's order. */
export function missingStarterSlugs(
  starters: readonly { slug: string }[],
  sounds: readonly Pick<Sound, 'starter'>[]
): string[] {
  const present = new Set(sounds.map((sound) => sound.starter).filter(Boolean))
  return starters.map((starter) => starter.slug).filter((slug) => !present.has(slug))
}

/** "Play Airhorn", or "Stop Airhorn" when a press stops it: the pad's accessible name. */
export function soundPadLabel(name: string, stops: boolean): string {
  return `${stops ? 'Stop' : 'Play'} ${name}`
}
