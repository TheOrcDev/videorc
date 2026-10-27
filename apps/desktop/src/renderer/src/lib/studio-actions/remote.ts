// Remote intents (Stream Deck, the phone): the relayed `remote.intent` event
// to its `remote.intent.ack`. Every kind on the wire (docs/remote-control.md)
// maps to one executor; the ack is `{intentId, ok, message?}`, with a message
// only when there is one, so a deck key can show the reason.

import { clipMark } from './clips'
import { commentHighlight, commentHighlightClear } from './comments'
import type { StudioActionContext, StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'
import { bannerHide, bannerShow, bannerToggle } from './banners'
import {
  micMute,
  micToggle,
  micUnmute,
  systemAudioOff,
  systemAudioOn,
  systemAudioToggle
} from './audio'
import { sceneApply, takeoverHide, takeoverShow } from './scene'
import { recordStart, recordStop, recordToggle, streamStart, streamStop } from './session'
import { soundPlay, soundStop } from './sounds'
import { windowFront } from './windows'

/** The Studio's executor for each remote intent kind on the wire. */
export const REMOTE_INTENT_EXECUTORS: Readonly<Record<string, StudioActionExecutor>> = {
  recordStart,
  recordStop,
  recordToggle,
  streamStart,
  streamStop,
  micMute,
  micUnmute,
  micToggle,
  systemAudioOn,
  systemAudioOff,
  systemAudioToggle,
  sceneApply,
  takeoverShow,
  takeoverHide,
  bannerShow,
  bannerHide,
  bannerToggle,
  soundPlay,
  soundStop,
  windowFront,
  commentHighlight,
  commentHighlightClear,
  clipMark
}

/** Executes a remote intent through the Studio's existing action handlers. */
export async function executeRemoteIntent(
  payload: unknown,
  context: StudioActionContext
): Promise<void> {
  const envelope = payload as {
    intentId?: string
    intent?: { kind?: string } & Record<string, unknown>
  } | null
  const intentId = envelope?.intentId
  const intent = envelope?.intent
  if (!intentId || !intent?.kind) return

  const ack = async (ok: boolean, message?: string): Promise<void> => {
    try {
      await context.client.request('remote.intent.ack', {
        intentId,
        ok,
        ...(message ? { message } : {})
      })
    } catch {
      // The remote client also observes state; a lost ack is non-fatal.
    }
  }

  try {
    const executor = Object.hasOwn(REMOTE_INTENT_EXECUTORS, intent.kind)
      ? REMOTE_INTENT_EXECUTORS[intent.kind]
      : undefined
    if (!executor) return void (await ack(false, REMOTE_INTENT_COPY.unsupported))
    const outcome = await executor(context, intent)
    await ack(outcome.ok, outcome.message)
  } catch (error) {
    // The raw error is for the console, never the phone (docs/ui-copy.md).
    console.error('[remote-control] intent failed', intent.kind, error)
    await ack(false, REMOTE_INTENT_COPY.failed)
  }
}
