// Record and stream, from a key or a tool. Plan 174 S3.1 made every start
// explicit: `recordStart` records and `streamStart` goes live, whatever mode
// was saved last, through the Studio's own starts; every stop takes the
// provider's one stop door, at once (plan 174 D2).

import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const recordStart: StudioActionExecutor = async (context) => {
  if (context.sessionActive) return { ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
  return (await context.startRecording())
    ? { ok: true }
    : { ok: false, message: context.recordBlockedReason ?? REMOTE_INTENT_COPY.recordDidNotStart }
}

export const recordStop: StudioActionExecutor = async (context) => {
  if (!context.sessionActive) return { ok: false, message: REMOTE_INTENT_COPY.notRunning }
  return (await context.stopSession())
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.didNotStop }
}

/** The same stop under the stream key's name: it stops whatever runs. */
export const streamStop: StudioActionExecutor = recordStop

export const recordToggle: StudioActionExecutor = async (context) => {
  const stopping = context.sessionActive
  const committed = stopping ? await context.stopSession() : await context.startRecording()
  return committed
    ? { ok: true }
    : {
        ok: false,
        message: (!stopping && context.recordBlockedReason) || REMOTE_INTENT_COPY.toggleFailed
      }
}

export const streamStart: StudioActionExecutor = async (context) => {
  if (context.sessionActive) return { ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
  return (await context.startLivestream())
    ? { ok: true }
    : {
        ok: false,
        message: context.liveStreamBlockedReason ?? REMOTE_INTENT_COPY.streamDidNotStart
      }
}
