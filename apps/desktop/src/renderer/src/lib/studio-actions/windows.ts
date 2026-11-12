// A window to the front: notes, comments or the preview. And the Stream
// Manager Screen key (plan 230): the Stream Manager to its other screen on a
// tap, and to the front or closed on a hold.

import type { StreamManagerScreenRefusal } from '@/lib/backend'
import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const windowFront: StudioActionExecutor = async (context, fields) => {
  const windowName = fields.window as string | undefined
  if (!windowName || !(await context.openWindow(windowName))) {
    return { ok: false, message: REMOTE_INTENT_COPY.windowMissing }
  }
  return { ok: true }
}

const SCREEN_REFUSAL_COPY: Record<StreamManagerScreenRefusal, string> = {
  'same-screen': REMOTE_INTENT_COPY.screensSame,
  'screen-missing': REMOTE_INTENT_COPY.screenMissing,
  'not-moved': REMOTE_INTENT_COPY.streamManagerNotMoved,
  wayland: REMOTE_INTENT_COPY.streamManagerWayland,
  unavailable: REMOTE_INTENT_COPY.windowMissing
}

export const streamManagerScreenSwap: StudioActionExecutor = async (context, fields) => {
  const { presentingScreen, monitorScreen } = fields
  if (typeof presentingScreen !== 'string' || typeof monitorScreen !== 'string') {
    return { ok: false, message: REMOTE_INTENT_COPY.windowMissing }
  }
  const result = await context.swapStreamManagerScreen?.({ presentingScreen, monitorScreen })
  if (!result) return { ok: false, message: REMOTE_INTENT_COPY.windowMissing }
  return result.ok ? { ok: true } : { ok: false, message: SCREEN_REFUSAL_COPY[result.reason] }
}

export const streamManagerFrontOrClose: StudioActionExecutor = async (context) => {
  const result = await context.frontOrCloseStreamManager?.()
  return result && result !== 'unavailable'
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.windowMissing }
}
