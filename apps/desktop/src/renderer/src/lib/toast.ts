import { toast as sonner, type ExternalToast } from 'sonner'

import { stripIpcPrefix } from '@/lib/ipc-error-message'

// Plan 094 (S3): the one door to sonner for Videorc's renderer. Every toast
// text passes `guardToastText` first, so a provider's raw error can never
// reach the streamer as HTML, escaped entities or a JSON blob (the owner's
// Stop toast on 2026-10-02 showed Google's envelope, `<a href=…>` included).
// This is defence in depth behind typed backend copy; the raw text goes to
// the renderer console, which the support bundle collects.

export const TOAST_DETAILS_IN_DIAGNOSTICS = 'Details are in diagnostics.'

const HTML_TAG = /<\/?[a-zA-Z!][^>]*>/g
const ESCAPED_ENTITY = /&(?:lt|gt|quot|amp|apos|#\d+|#x[0-9a-fA-F]+);/g
const JSON_BLOB = /[{[]\s*["'][^"']*["']\s*:|"error"\s*:|\\"[a-zA-Z]+\\"\s*:/

const ENTITY_VALUES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&amp;': '&',
  '&apos;': "'"
}

function decodeEntity(entity: string): string {
  const known = ENTITY_VALUES[entity]
  if (known) return known
  const numeric = /^&#(x?)([0-9a-fA-F]+);$/.exec(entity)
  if (!numeric) return entity
  const code = parseInt(numeric[2], numeric[1] ? 16 : 10)
  return Number.isFinite(code) ? String.fromCodePoint(code) : entity
}

export type GuardedToastText = {
  text: string
  /** The raw text when it was altered, for the diagnostics log; null otherwise. */
  withheld: string | null
}

/**
 * Pure. Strips HTML tags, decodes escaped entities, and replaces anything that
 * still looks like a JSON blob with "Details are in diagnostics.".
 */
export function guardToastText(raw: string): GuardedToastText {
  // Plan 174 S2.4: a backstop behind `userErrorMessage`. The wrapper is
  // transport noise ("Error invoking remote method 'x': Error: …").
  let text = stripIpcPrefix(raw)
  let altered = text !== raw
  if (HTML_TAG.test(text)) {
    text = text.replace(HTML_TAG, ' ')
    altered = true
  }
  HTML_TAG.lastIndex = 0
  if (ESCAPED_ENTITY.test(text)) {
    text = text.replace(ESCAPED_ENTITY, decodeEntity)
    altered = true
  }
  ESCAPED_ENTITY.lastIndex = 0
  // Decoding may have revealed tags (`&lt;a href…&gt;`): strip once more.
  if (HTML_TAG.test(text)) {
    text = text.replace(HTML_TAG, ' ')
    altered = true
  }
  HTML_TAG.lastIndex = 0
  if (JSON_BLOB.test(text) || /[{}]/.test(text)) {
    text = TOAST_DETAILS_IN_DIAGNOSTICS
    altered = true
  } else {
    text = text.replace(/\s+/g, ' ').trim()
    if (altered && !text) text = TOAST_DETAILS_IN_DIAGNOSTICS
  }
  return { text, withheld: altered ? raw : null }
}

type ToastTitle = Parameters<typeof sonner>[0]

/** How long a toast with a description stays up at least (plan 174 S2.4). */
export const TOAST_WITH_DESCRIPTION_MS = 8_000

/**
 * Pure. Plan 174 S2.4's durations: a one-liner keeps sonner's 4 s, a toast with
 * a description stays at least 8 s, and one with an action stays until it is
 * acted on or closed. An explicit duration always wins.
 */
export function defaultToastDuration(options: ExternalToast | undefined): number | undefined {
  if (!options || options.duration !== undefined) return options?.duration
  if (options.action || options.cancel) return Infinity
  if (options.description) return TOAST_WITH_DESCRIPTION_MS
  return undefined
}

function guardOptions(
  title: ToastTitle,
  options: ExternalToast | undefined,
  timed: boolean
): { title: ToastTitle; options: ExternalToast | undefined } {
  let nextTitle = title
  let nextOptions = options
  const duration = timed ? defaultToastDuration(options) : options?.duration
  if (options && duration !== options.duration) nextOptions = { ...options, duration }
  if (typeof title === 'string') {
    const guarded = guardToastText(title)
    if (guarded.withheld !== null) {
      console.warn('[toast] withheld raw provider text from a toast title:', guarded.withheld)
      nextTitle = guarded.text
    }
  }
  if (options && typeof options.description === 'string') {
    const guarded = guardToastText(options.description)
    if (guarded.withheld !== null) {
      console.warn('[toast] withheld raw provider text from a toast description:', guarded.withheld)
      nextOptions = { ...nextOptions, description: guarded.text }
    }
  }
  return { title: nextTitle, options: nextOptions }
}

type Show = (title: ToastTitle, options?: ExternalToast) => string | number

// Call with exactly the arguments the caller gave: a trailing `undefined`
// would change what tests that spy on sonner observe.
// A loading toast never times out on its own, so it takes no default duration.
function guarded(show: Show, timed = true): Show {
  return (title, options) => {
    const next = guardOptions(title, options, timed)
    return next.options === undefined ? show(next.title) : show(next.title, next.options)
  }
}

const base = guarded((...args) => sonner(...args))

/** sonner's `toast`, with every string title and description guarded. */
export const toast = Object.assign(base, {
  success: guarded((...args) => sonner.success(...args)),
  error: guarded((...args) => sonner.error(...args)),
  warning: guarded((...args) => sonner.warning(...args)),
  info: guarded((...args) => sonner.info(...args)),
  message: guarded((...args) => sonner.message(...args)),
  loading: guarded((...args) => sonner.loading(...args), false),
  dismiss: (id?: string | number) => sonner.dismiss(id)
})
