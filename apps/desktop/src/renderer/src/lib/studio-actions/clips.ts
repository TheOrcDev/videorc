// A clip: the last seconds whenever the ring holds frames, and a mark while
// recording (plan 181 R4). Plan 199: 30 or 60 seconds, or no length (today's
// 30 s); any other length is refused with the backend's own sentence.

import { INVALID_CLIP_LENGTH_MESSAGE, isClipLength } from '../../../../shared/clip-lengths'
import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const clipMark: StudioActionExecutor = async (context, fields) => {
  const seconds = fields.seconds ?? undefined
  if (seconds !== undefined && !isClipLength(seconds)) {
    return { ok: false, message: INVALID_CLIP_LENGTH_MESSAGE }
  }
  if (!context.sessionActive && !context.replayOn) {
    return { ok: false, message: REMOTE_INTENT_COPY.clipsOff }
  }
  return context.markClip(seconds)
}
