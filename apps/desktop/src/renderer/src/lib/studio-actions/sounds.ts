// Sounds (plan 189 S10): `soundPlay` is a press (the backend applies the
// sound's mode, like a key); `soundStop` without an id stops them all.

import { soundboard } from '@/lib/soundboard-store'
import { runSoundAction } from '@/lib/sounds'
import type {
  StudioActionContext,
  StudioActionExecutor,
  StudioActionFields,
  StudioActionOutcome
} from './context'
import { REMOTE_INTENT_COPY } from './copy'

async function runSoundIntent(
  context: StudioActionContext,
  verb: 'press' | 'stop',
  fields: StudioActionFields
): Promise<StudioActionOutcome> {
  const soundId = typeof fields.soundId === 'string' ? fields.soundId : undefined
  const sounds = context.sounds ?? soundboard.getSnapshot().board?.sounds ?? []
  if (soundId === undefined && verb === 'press') {
    return { ok: false, message: REMOTE_INTENT_COPY.soundMissing }
  }
  return runSoundAction(
    context.client,
    soundId === undefined ? { action: 'stopAll' } : { action: verb, id: soundId },
    sounds
  )
}

export const soundPlay: StudioActionExecutor = (context, fields) =>
  runSoundIntent(context, 'press', fields)
export const soundStop: StudioActionExecutor = (context, fields) =>
  runSoundIntent(context, 'stop', fields)
