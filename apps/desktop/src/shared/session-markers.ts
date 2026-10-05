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
}
export type MarkerRelayCommand = { requestId: string } & (
  | { action: 'create'; params: CreateMarkerParams }
  | { action: 'get'; params: MarkerParams }
  | { action: 'delete'; params: MarkerParams }
)
export type MarkerRelayResult = SessionMarker | MarkerLookup | MarkerChanged

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
      )
    },
    strict
  )
)
export const markerRelayCommandSchema = unionSchema([
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
  | { kind: 'help' }
  | { kind: 'error'; message: string }
/** Leading slash commands never reach a provider. Double slash escapes once. */
export function classifyComposerDraft(raw: string): ComposerCommand {
  const text = raw.trim()
  if (!text.startsWith('/')) return { kind: 'chat', text }
  if (text.startsWith('//')) return { kind: 'chat', text: text.slice(1) }
  if (/^\/help\s*$/i.test(text)) return { kind: 'help' }
  const match = /^\/marker(?: +([\s\S]*))?$/i.exec(text)
  if (match) {
    try {
      return { kind: 'marker', label: markerLabel(match[1] ?? '') }
    } catch (error) {
      return { kind: 'error', message: (error as Error).message }
    }
  }
  return {
    kind: 'error',
    message:
      'Unknown command. Use /marker [title] or /help. To send a literal slash, start with //.'
  }
}
export function markerTime(seconds: number): string {
  const total = Math.floor(seconds)
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((v) => String(v).padStart(2, '0'))
    .join(':')
}
