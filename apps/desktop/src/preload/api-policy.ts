import type { VideorcApi } from '../shared/backend'
import type { RendererRole } from '../shared/renderer-security-policy'

type VideorcApiKey = keyof VideorcApi

export const AUXILIARY_API_KEYS = {
  notes: [
    'getNotesWindowState',
    'setNotesWindowAlwaysOnTop',
    'saveNotesDocument',
    'onNotesFlushRequest',
    'onNotesWindowState'
  ],
  comments: [
    'sendCommentHighlight',
    'getCommentHighlightState',
    'onCommentHighlightState',
    'sendChatFromCommentsWindow',
    'clearComments',
    'getCommentsWindowState',
    'setCommentsWindowAlwaysOnTop',
    'onCommentsWindowState',
    'getCommentsSnapshot',
    'setCommentsViewMode',
    'onCommentsSnapshot',
    'onCommentsDelta',
    'getViewerSample',
    'onViewerSample'
  ],
  captions: [
    'getCaptionsWindowState',
    'setCaptionsWindowAlwaysOnTop',
    'onCaptionsWindowState',
    'getCaptionSnapshot',
    'onCaptionSnapshot'
  ]
} as const satisfies Record<Exclude<RendererRole, 'main'>, readonly VideorcApiKey[]>

export function apiForRendererRole(
  api: VideorcApi,
  role: RendererRole | null
): VideorcApi | Partial<VideorcApi> {
  if (role === 'main') {
    return api
  }
  if (!role) {
    return Object.freeze({})
  }
  const selected: Partial<VideorcApi> = {}
  for (const key of AUXILIARY_API_KEYS[role]) {
    Object.defineProperty(selected, key, {
      configurable: false,
      enumerable: true,
      value: api[key],
      writable: false
    })
  }
  return Object.freeze(selected)
}
