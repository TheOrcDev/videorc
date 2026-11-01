// A window to the front: notes, comments or the preview.

import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const windowFront: StudioActionExecutor = async (context, fields) => {
  const windowName = fields.window as string | undefined
  if (!windowName || !(await context.openWindow(windowName))) {
    return { ok: false, message: REMOTE_INTENT_COPY.windowMissing }
  }
  return { ok: true }
}
