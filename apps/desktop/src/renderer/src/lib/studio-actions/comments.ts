// A comment on stream: an explicit show by message id, and a clear. The
// Studio's handlers resolve the refusal sentence (the backend's eligibility
// reason verbatim), so these only check the id is there.

import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const commentHighlight: StudioActionExecutor = async (context, fields) => {
  const messageId = fields.messageId as string | undefined
  if (!messageId) return { ok: false, message: REMOTE_INTENT_COPY.messageMissing }
  return context.showCommentHighlight(messageId)
}

export const commentHighlightClear: StudioActionExecutor = async (context) =>
  context.clearCommentHighlight()
