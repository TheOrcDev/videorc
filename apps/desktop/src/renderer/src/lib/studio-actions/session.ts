// Record and stream, from a key or a tool. Plan 174 S3.1 made every start
// explicit: `recordStart` records and `streamStart` goes live, whatever mode
// was saved last, through the Studio's own starts; every stop takes the
// provider's one stop door, at once (plan 174 D2).

import type { StudioActionContext, StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

function active(context: StudioActionContext, output: 'recording' | 'live'): boolean {
  return context.outputFacts?.owner === 'cloud-room'
    ? context.outputFacts[output]
    : context.sessionActive
}
function stop(context: StudioActionContext, output: 'recording' | 'live'): Promise<boolean> {
  return context.outputFacts?.owner === 'cloud-room' && context.stopOutput
    ? context.stopOutput(output)
    : context.stopSession()
}

export const recordStart: StudioActionExecutor = async (context) => {
  if (active(context, 'recording')) return { ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
  return (await context.startRecording())
    ? { ok: true }
    : { ok: false, message: context.recordBlockedReason ?? REMOTE_INTENT_COPY.recordDidNotStart }
}

export const recordStop: StudioActionExecutor = async (context) => {
  if (!active(context, 'recording')) return { ok: false, message: REMOTE_INTENT_COPY.notRunning }
  return (await stop(context, 'recording'))
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.didNotStop }
}

/** Cloud outputs stop independently; native sessions keep their existing stop. */
export const streamStop: StudioActionExecutor = async (context) => {
  if (!active(context, 'live')) return { ok: false, message: REMOTE_INTENT_COPY.notRunning }
  return (await stop(context, 'live'))
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.didNotStop }
}

export const recordToggle: StudioActionExecutor = async (context) => {
  const stopping = active(context, 'recording')
  const committed = stopping ? await stop(context, 'recording') : await context.startRecording()
  return committed
    ? { ok: true }
    : {
        ok: false,
        message: (!stopping && context.recordBlockedReason) || REMOTE_INTENT_COPY.toggleFailed
      }
}

export const streamStart: StudioActionExecutor = async (context) => {
  if (active(context, 'live')) return { ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
  return (await context.startLivestream())
    ? { ok: true }
    : {
        ok: false,
        message: context.liveStreamBlockedReason ?? REMOTE_INTENT_COPY.streamDidNotStart
      }
}
