import type { VideorcApi } from '../shared/backend'
import type { RendererRole } from '../shared/renderer-security-policy'

type VideorcApiKey = keyof VideorcApi

export const AUXILIARY_API_KEYS = {
  notes: [
    'getNotesWindowState',
    // The document used to be baked into the Notes data URL; the renderer
    // window reads it on mount (plan 050 S4).
    'getNotesDocument',
    'setNotesWindowAlwaysOnTop',
    'saveNotesDocument',
    'onNotesFlushRequest',
    'onNotesWindowState'
  ],
  comments: [
    'cacheChatAvatar',
    'readChatAvatar',
    // Open link on a chat row (plan 151).
    'openChatLink',
    'sendCommentHighlight',
    'getCommentHighlightState',
    'onCommentHighlightState',
    'sendChatFromCommentsWindow',
    'clearComments',
    // Mark clip from the Stream Manager (plan 068 D6): relayed, like clear.
    'markClipFromCommentsWindow',
    // Show who followed (plan 071, S2): main starts the Twitch reconnect.
    'showFollowNamesFromCommentsWindow',
    // Reconnect Twitch or Kick so Orcle can remove messages (plan 140, S5).
    'reconnectScopesFromCommentsWindow',
    // Remove from chat and Orcle's removal cards (plan 140, S6): relayed.
    'moderateFromCommentsWindow',
    'getCommentsWindowState',
    'setCommentsWindowAlwaysOnTop',
    'setCommentsWindowHighlightAnchor',
    'onCommentsWindowState',
    'getCommentsSnapshot',
    'setCommentsViewMode',
    'onCommentsSnapshot',
    'onCommentsDelta',
    'getViewerSample',
    'onViewerSample',
    // Stream Manager dashboard (plan 055, S7): read and follow only.
    'getDashboard',
    'onDashboard',
    // The status bar's Open Preview hint (plan 055, decision 4).
    'openPreviewWindow',
    // Co-host presence: the window renders the relayed state and can act on it
    // (dismiss/answer, and — presence W2 — turn the engine on). Without these
    // the Comments window silently had no co-host at all.
    'getCohostWindowState',
    'onCohostWindowState',
    'sendCohostAction',
    // Answers to Orcle's voice command cards (plan 140, S6 part B).
    'sendCohostCommand',
    'sendCohostEnable'
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
