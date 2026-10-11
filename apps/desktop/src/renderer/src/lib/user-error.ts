import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { toast } from '@/lib/toast'

// Plan 174 S2.4 (J2-7, J2-14): raw error text never reaches a toast or a line.
// A caller names what it tried ("import", "the image") and this module turns
// any failure into copy the streamer can act on: a known cause gets its own
// sentence, Videorc offline says so, and anything else gets the one generic
// next step. The raw text goes to the console, which the support bundle
// collects. It duck-types errors (`code`, `name`) so a window without the
// backend client (Stream Manager) can use it without loading that client.

/** The one sentence for Videorc's own connection being down. */
export const OFFLINE_REASON = 'Videorc is reconnecting. Try again in a moment.'
/** The next step when Videorc doesn't know why something failed. */
export const UNKNOWN_REASON =
  'Try again. If it keeps happening, export a support bundle from Health.'

/** Thrown by a renderer call that needs Videorc's engine while it is down. */
export class VideorcOfflineError extends Error {
  readonly name = 'VideorcOfflineError'

  constructor() {
    super(OFFLINE_REASON)
  }
}

/** A renderer-written reason that already reads as copy; shown as is. */
export class UserFacingError extends Error {
  readonly name = 'UserFacingError'
}

/** The rejection for a call made while Videorc's engine is down. */
export function offlineError(): VideorcOfflineError {
  return new VideorcOfflineError()
}

// The transport texts BackendClient and older renderer code mint for a
// connection that is down; all of them mean "reconnecting". Patterns, not
// strings, so the copy guard reads them as code.
const OFFLINE_RAW = [
  /^Videorc is reconnecting\. Try again in a moment\.$/,
  /^Backend (?:socket|WebSocket|client|connection) (?:is not connected|is closed|closed)\.$/,
  /^Backend is not connected\.(?: Try again in a moment\.)?$/,
  /^Could not connect to the Rust backend\.$/,
  /^Backend request "[^"]+" timed out before it was sent\.$/,
  /^Could not send backend request/
]
const UNKNOWN_OUTCOME = /its outcome is unknown\.$/

const BUSY_REASON = "Videorc was busy and didn't do it. Try again in a moment."

/** Backend error codes with a cause the streamer can act on. */
const KNOWN_CODES: Readonly<Record<string, string>> = {
  'request-outcome-unknown':
    "Videorc didn't hear back in time. Check whether it worked before you try again.",
  'command-expired-before-dispatch': BUSY_REASON,
  'command-lane-full': BUSY_REASON,
  'command-not-applied': BUSY_REASON,
  'clean-cut-mutation-blocked':
    'Clean cut is still working on this recording. Try again when it finishes.',
  'noise-cleanup-mutation-blocked':
    'Noise cleanup is still working on this recording. Try again when it finishes.',
  'session-rename-invalid': 'A title needs 1 to 120 characters.',
  'youtube-quota-paused': "Videorc's daily YouTube API limit is used up. Try again after it resets."
}
const WARNING_CODES = new Set([
  'command-expired-before-dispatch',
  'command-lane-full',
  'command-not-applied',
  'clean-cut-mutation-blocked',
  'noise-cleanup-mutation-blocked'
])

export type UserErrorContext = {
  /** The verb the streamer asked for: "import", "rename", "turn on". */
  action: string
  /** What it acted on, with its article: "the image", "Buddy Live". */
  object?: string
}

export type UserError = {
  kind: 'offline' | 'known' | 'canceled' | 'unknown'
  /** The toast title: the outcome, no period ("Couldn't import the image"). */
  title: string
  /** Whole sentences: the cause when known, then the next step. */
  description: string
  /** One line for inline surfaces: title and description together. */
  text: string
  /** By meaning: offline or busy is a warning (can't now), the rest an error. */
  tone: 'error' | 'warning'
  /** The raw text without the IPC prefix: console and support bundle only. */
  raw: string
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null
}

/** "Couldn't import the image", or "Videorc hit a problem" without a context. */
export function couldNotTitle(context: UserErrorContext | undefined): string {
  if (!context) return 'Videorc hit a problem'
  return `Couldn't ${context.action}${context.object ? ` ${context.object}` : ''}`
}

/**
 * Pure: the copy for `error` when the streamer tried to `{action} {object}`.
 * Known causes keep their sentence; anything else gets the generic next step.
 */
export function userErrorMessage(error: unknown, context?: UserErrorContext): UserError {
  const raw = ipcErrorMessage(error).trim()
  const name = errorName(error)
  const code = errorCode(error)
  const shape = (
    kind: UserError['kind'],
    description: string,
    tone: UserError['tone'],
    offlineTitle = false
  ): UserError => {
    const title = offlineTitle && !context ? 'Videorc is reconnecting' : couldNotTitle(context)
    const body = offlineTitle && !context ? 'Try again in a moment.' : description
    return { kind, title, description: body, text: `${title}. ${body}`, tone, raw }
  }
  if (name === 'AbortError' || code === 'aborted') {
    return shape('canceled', 'It was canceled.', 'warning')
  }
  if (name === 'VideorcOfflineError' || OFFLINE_RAW.some((pattern) => pattern.test(raw))) {
    return shape('offline', OFFLINE_REASON, 'warning', true)
  }
  if (name === 'UserFacingError' && raw) return shape('known', raw, 'error')
  if (code && KNOWN_CODES[code]) {
    return shape('known', KNOWN_CODES[code], WARNING_CODES.has(code) ? 'warning' : 'error')
  }
  if (UNKNOWN_OUTCOME.test(raw)) {
    return shape('known', KNOWN_CODES['request-outcome-unknown'], 'error')
  }
  return shape('unknown', UNKNOWN_REASON, 'error')
}

export type UserErrorToastOptions = {
  id?: string | number
  duration?: number
  action?: { label: string; onClick: () => void }
}

/**
 * Shows `userErrorMessage(error, context)` as one toast (typed by meaning) and
 * logs the raw text. Returns the copy so the caller can mirror it inline.
 */
export function toastUserError(
  error: unknown,
  context?: UserErrorContext,
  options: UserErrorToastOptions = {}
): UserError {
  const copy = userErrorMessage(error, context)
  if (copy.kind === 'canceled') return copy
  console.warn(`[user-error] ${copy.title}:`, copy.raw || error)
  const show = copy.tone === 'warning' ? toast.warning : toast.error
  show(copy.title, { ...options, description: copy.description })
  return copy
}

/** One toast id for "Videorc is reconnecting", so it never stacks. */
export const OFFLINE_TOAST_ID = 'videorc-offline'

/** The one toast for an action that needs Videorc's engine while it is down. */
export function toastOffline(context?: UserErrorContext): void {
  toastUserError(offlineError(), context, { id: OFFLINE_TOAST_ID })
}
