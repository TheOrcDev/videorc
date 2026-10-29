import {
  arraySchema,
  booleanSchema,
  enumSchema,
  literalSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  unionSchema,
  runtimeSchema,
  RuntimeSchemaError
} from './runtime-schema'
import { formatTimecode } from './timecode'
import { DEFAULT_CLIP_SECONDS, LONG_CLIP_SECONDS, type ClipLength } from './clip-marks'
import {
  classifyBannerCommand,
  type BannerRelayAction,
  type BannerSummary
} from './banner-commands'
import { classifySoundCommand, type SoundRelayAction, type SoundSummary } from './sound-commands'
import { classifyBuddyCommand } from './buddy-act'

export interface SessionMarker {
  id: string
  sessionId: string
  atSeconds: number
  label?: string
  source: 'voice' | 'manual'
  createdAt: string
  revision: number
}
export interface CreateMarkerParams {
  operationId: string
  sessionId: string
  label?: string
}
export interface MarkerParams {
  sessionId: string
  markerId: string
}
export interface RenameMarkerParams extends MarkerParams {
  label?: string
}
export interface ListMarkersParams {
  sessionId: string
  cursor?: string
  limit?: number
}
export interface MarkerPage {
  markers: SessionMarker[]
  nextCursor?: string
}
export type MarkerLookup =
  | { status: 'found'; marker: SessionMarker }
  | { status: 'deleted'; revision: number }
  | { status: 'absent' }
export interface MarkerChanged {
  sessionId: string
  markerId: string
  revision: number
  deleted: boolean
  marker?: SessionMarker
}
export interface MarkerContext {
  sessionId?: string
  available: boolean
  reason?: string
  retryAvailable?: boolean
  lastMarker?: SessionMarker
  voice?: {
    state: 'off' | 'starting' | 'on' | 'blocked'
    reasonCode?: string
    message?: string
    remainingSeconds?: number
  }
  /** The Clip action (plan 181 R4), for the window's button and `/clip`. */
  clip?: ClipContext
}
export interface ClipContext {
  /** The ring holds frames or a recording runs: a press keeps something. */
  available: boolean
  /** The 30-second clip's length, for the words ("the last 0:30"). Plan
   * 199: never the ring's length, which is the minute. */
  seconds: number
  /** Plan 199: the 1-minute clip's length ("the last 1:00"). */
  longSeconds: number
  /** The Save a 30-second clip key as it reads on this platform ("⌥⌘C"), when bound. */
  shortcutLabel?: string
  /** Plan 199: the Save a 1-minute clip key, when bound. */
  longShortcutLabel?: string
  /** Why a press would keep nothing, when it would: the switch is off, the
   * backend keeps the default off on this computer, or the ring is still
   * starting. The window says it in words. */
  off?: 'switch' | 'blocked' | 'starting' | 'idle'
}
export type MarkerRelayCommand = { requestId: string } & (
  | { action: 'screenHide' | 'screenShow' }
  | { action: 'create'; params: CreateMarkerParams }
  | { action: 'get'; params: MarkerParams }
  | { action: 'delete'; params: MarkerParams }
)
export type MarkerRelayResult = SessionMarker | MarkerLookup | MarkerChanged | { hidden: boolean }

export const MARKER_LABEL_MAX_CHARS = 120
export function markerLabel(raw: string): string | undefined {
  if (
    [...raw].some((character) => {
      const code = character.codePointAt(0)!
      return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
    })
  )
    throw new Error('A marker title must be one line without control characters.')
  const label = raw.trim()
  if ([...label].length > MARKER_LABEL_MAX_CHARS)
    throw new Error('A marker title can have at most 120 characters.')
  return label || undefined
}
const id = stringSchema({ minLength: 1, maxLength: 128 })
const strict = { allowUnknown: false }
const uuid = runtimeSchema<string>('a canonical UUID', (value, path) => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    throw new RuntimeSchemaError(path, 'a canonical UUID')
  return value
})
const label = runtimeSchema<string>('a marker title', (value, path) => {
  if (typeof value !== 'string') throw new RuntimeSchemaError(path, 'a marker title')
  try {
    markerLabel(value)
  } catch {
    throw new RuntimeSchemaError(path, 'a single-line title of at most 120 characters')
  }
  return value
})
export const createMarkerParamsSchema = objectSchema(
  { operationId: uuid, sessionId: id, label: optionalSchema(label) },
  strict
)
export const markerParamsSchema = objectSchema({ sessionId: id, markerId: id }, strict)
export const renameMarkerParamsSchema = objectSchema(
  { sessionId: id, markerId: id, label: optionalSchema(label) },
  strict
)
export const listMarkersParamsSchema = objectSchema(
  {
    sessionId: id,
    cursor: optionalSchema(id),
    limit: optionalSchema(numberSchema({ integer: true, min: 1, max: 500 }))
  },
  strict
)
export const sessionMarkerSchema = objectSchema(
  {
    id,
    sessionId: id,
    atSeconds: numberSchema({ min: 0, max: 1_000_000_000 }),
    label: optionalSchema(label),
    source: enumSchema(['voice', 'manual']),
    createdAt: stringSchema({ minLength: 1, maxLength: 128 }),
    revision: numberSchema({ integer: true, min: 1 })
  },
  strict
)
export const markerPageSchema = objectSchema(
  { markers: arraySchema(sessionMarkerSchema, { maxLength: 500 }), nextCursor: optionalSchema(id) },
  strict
)
export const markerLookupSchema = unionSchema([
  objectSchema({ status: literalSchema('found'), marker: sessionMarkerSchema }, strict),
  objectSchema(
    { status: literalSchema('deleted'), revision: numberSchema({ integer: true, min: 1 }) },
    strict
  ),
  objectSchema({ status: literalSchema('absent') }, strict)
])
export const markerChangedSchema = objectSchema(
  {
    sessionId: id,
    markerId: id,
    revision: numberSchema({ integer: true, min: 0 }),
    deleted: booleanSchema,
    marker: optionalSchema(sessionMarkerSchema)
  },
  strict
)
export const markerContextSchema = nullableSchema(
  objectSchema(
    {
      sessionId: optionalSchema(id),
      available: booleanSchema,
      retryAvailable: optionalSchema(booleanSchema),
      lastMarker: optionalSchema(sessionMarkerSchema),
      reason: optionalSchema(stringSchema({ maxLength: 1000 })),
      voice: optionalSchema(
        objectSchema(
          {
            state: enumSchema(['off', 'starting', 'on', 'blocked']),
            reasonCode: optionalSchema(id),
            message: optionalSchema(stringSchema({ maxLength: 2000 })),
            remainingSeconds: optionalSchema(numberSchema({ min: 0 }))
          },
          strict
        )
      ),
      clip: optionalSchema(
        objectSchema(
          {
            available: booleanSchema,
            seconds: numberSchema({ integer: true, min: 0, max: 3600 }),
            longSeconds: numberSchema({ integer: true, min: 0, max: 3600 }),
            shortcutLabel: optionalSchema(stringSchema({ maxLength: 160 })),
            longShortcutLabel: optionalSchema(stringSchema({ maxLength: 160 })),
            off: optionalSchema(enumSchema(['switch', 'blocked', 'starting', 'idle']))
          },
          strict
        )
      )
    },
    strict
  )
)
export const markerRelayCommandSchema = unionSchema([
  objectSchema({ requestId: id, action: enumSchema(['screenHide', 'screenShow']) }, strict),
  objectSchema(
    { requestId: id, action: literalSchema('create'), params: createMarkerParamsSchema },
    strict
  ),
  objectSchema({ requestId: id, action: literalSchema('get'), params: markerParamsSchema }, strict),
  objectSchema(
    { requestId: id, action: literalSchema('delete'), params: markerParamsSchema },
    strict
  )
])
export const markerRelayResultSchema = unionSchema([
  objectSchema({ hidden: booleanSchema }, strict),
  sessionMarkerSchema,
  markerLookupSchema,
  markerChangedSchema
])
export const markerRelayResolutionSchema = unionSchema([
  objectSchema({ requestId: id, ok: literalSchema(true), value: markerRelayResultSchema }, strict),
  objectSchema(
    { requestId: id, ok: literalSchema(false), error: stringSchema({ maxLength: 2000 }) },
    strict
  )
])

export type ComposerCommand =
  | { kind: 'chat'; text: string }
  | { kind: 'marker'; label?: string }
  /** Plan 181 R4: save the last seconds as a clip (the Clip button's action).
   * Plan 199 D6: `/clip` (or `/clip 30`) is 30 s, `/clip 60` the minute. */
  | { kind: 'clip'; seconds: ClipLength }
  /** Plan 186: show or hide a banner; never posts to chat. */
  | { kind: 'banner'; action: BannerRelayAction }
  /** Plan 189: press a sound or stop them all; never posts to chat. */
  | { kind: 'sound'; action: SoundRelayAction }
  /** Plan 209 S20: ask Buddy to do something; never posts to chat. */
  | { kind: 'buddy'; sentence: string }
  | { kind: 'privacy'; hidden: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }
/**
 * Leading slash commands never reach a provider. Double slash escapes once.
 * `banners` and `sounds` are what the window knows (plans 186, 189):
 * `/banner <name>` and `/sound <name>` resolve against them.
 */
export function classifyComposerDraft(
  raw: string,
  banners: readonly BannerSummary[] = [],
  sounds: readonly SoundSummary[] = []
): ComposerCommand {
  const text = raw.trim()
  if (!text.startsWith('/')) return { kind: 'chat', text }
  if (text.startsWith('//')) return { kind: 'chat', text: text.slice(1) }
  if (/^\/hide\s*$/i.test(text)) return { kind: 'privacy', hidden: true }
  if (/^\/show\s*$/i.test(text)) return { kind: 'privacy', hidden: false }
  if (/^\/help\s*$/i.test(text)) return { kind: 'help' }
  const clip = /^\/clip(?:\s+([\s\S]*))?$/i.exec(text)
  if (clip) return classifyClipCommand(clip[1]?.trim() ?? '')
  const match = /^\/marker(?: +([\s\S]*))?$/i.exec(text)
  if (match) {
    try {
      return { kind: 'marker', label: markerLabel(match[1] ?? '') }
    } catch (error) {
      return { kind: 'error', message: (error as Error).message }
    }
  }
  const banner = /^\/banner(?:\s+([\s\S]*))?$/i.exec(text)
  if (banner) return classifyBannerCommand(banner[1] ?? '', banners)
  const sound = /^\/sound(?:\s+([\s\S]*))?$/i.exec(text)
  if (sound) return classifySoundCommand(sound[1] ?? '', sounds)
  const buddy = /^\/buddy(?:\s+([\s\S]*))?$/i.exec(text)
  if (buddy) return classifyBuddyCommand(buddy[1] ?? '')
  return {
    kind: 'error',
    message:
      'Unknown command. Use /hide, /show, /marker [title], /clip, /banner [name], /sound [name], /buddy [words], or /help. To send a literal slash, start with //.'
  }
}
/** Plan 199 D6: what `/clip` says when it is given a length nobody offers. */
export const CLIP_COMMAND_LENGTH_ERROR = 'A clip is 30 seconds or 1 minute: /clip or /clip 60.'

function classifyClipCommand(length: string): ComposerCommand {
  if (length === '' || length === String(DEFAULT_CLIP_SECONDS)) {
    return { kind: 'clip', seconds: DEFAULT_CLIP_SECONDS }
  }
  if (length === String(LONG_CLIP_SECONDS)) return { kind: 'clip', seconds: LONG_CLIP_SECONDS }
  return { kind: 'error', message: CLIP_COMMAND_LENGTH_ERROR }
}

/** A marker's place in the recording as the one timecode: "2:05", "1:02:05" (plan 174 S1.4). */
export function markerTime(seconds: number): string {
  return formatTimecode(seconds * 1000)
}
