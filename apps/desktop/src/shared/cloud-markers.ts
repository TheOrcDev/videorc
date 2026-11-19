import { cloudClipJobSchema, type CloudClipJob } from './cloud-clips'
import {
  arraySchema,
  enumSchema,
  literalSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  unionSchema
} from './runtime-schema'
import type { SessionMarker } from './session-markers'
export type MarkerTarget =
  | { kind: 'native-take'; sessionId: string }
  | { kind: 'cloud-show'; showId: string }
export type CloudMarkerCreate = {
  showId: string
  operationId: string
  label?: string
  kind?: 'marker' | 'clip'
  lookbackSeconds?: 30 | 60
}
/**
 * Why a clip mark kept no clip (L2): another clip was still saving (`busy`),
 * too many unfinished clips wait in Clips (`full`), or the cloud buffer could
 * not supply it (`failed`). The mark itself is saved either way.
 */
export const CLOUD_CLIP_REFUSALS = ['busy', 'full', 'failed'] as const
export type CloudClipRefusal = (typeof CLOUD_CLIP_REFUSALS)[number]
export type CloudMarker = {
  clipJob?: CloudClipJob
  clipRefused?: CloudClipRefusal
  id: string
  showId: string
  atSeconds: number
  kind: 'marker' | 'clip'
  label: string | null
  lookbackSeconds: 30 | 60 | null
  source: 'manual' | 'voice' | 'remote' | 'agent'
  authorUserId: string
  createdAt: string
  revision: number
  deleted: boolean
  target: {
    kind: 'cloud-show'
    showId: string
    liveIntervalId: string | null
    takeIds: string[]
    providerEgressIds: string[]
  }
  time: {
    basis: 'server-show-created-at'
    origin: string
    atSeconds: number
    observation: 'server-accepted'
    mediaUncertaintyMs: null
  }
  sourcePosition: {
    sourceId: string
    speechSessionId: string
    offsetSeconds: number
    uncertaintyMs: null
  } | null
  media: { status: 'unavailable'; reason: 'no-recording' | 'clock-unconfirmed'; extractable: false }
}
export type TimelineMarker = SessionMarker | CloudMarker
export type TimelineMarkerCreate =
  | import('./session-markers').CreateMarkerParams
  | CloudMarkerCreate
const id = stringSchema({ minLength: 1, maxLength: 160 }),
  strict = { allowUnknown: false },
  seconds = numberSchema({ min: 0, max: 1e9 })
export const cloudMarkerCreateSchema = objectSchema(
  {
    showId: id,
    operationId: stringSchema({ minLength: 36, maxLength: 36 }),
    label: optionalSchema(stringSchema({ maxLength: 120 })),
    kind: optionalSchema(enumSchema(['marker', 'clip'])),
    lookbackSeconds: optionalSchema(unionSchema([literalSchema(30), literalSchema(60)]))
  },
  strict
)
export const cloudMarkerParamsSchema = objectSchema({ showId: id, markerId: id }, strict)
export const cloudMarkerSchema = objectSchema(
  {
    clipJob: optionalSchema(cloudClipJobSchema),
    clipRefused: optionalSchema(enumSchema(CLOUD_CLIP_REFUSALS)),
    id,
    showId: id,
    atSeconds: seconds,
    kind: enumSchema(['marker', 'clip']),
    label: nullableSchema(stringSchema({ maxLength: 120 })),
    lookbackSeconds: nullableSchema(unionSchema([literalSchema(30), literalSchema(60)])),
    source: enumSchema(['manual', 'voice', 'remote', 'agent']),
    authorUserId: id,
    createdAt: id,
    revision: numberSchema({ integer: true, min: 1 }),
    deleted: literalSchema(false),
    target: objectSchema(
      {
        kind: literalSchema('cloud-show'),
        showId: id,
        liveIntervalId: nullableSchema(id),
        takeIds: arraySchema(id, { maxLength: 4 }),
        providerEgressIds: arraySchema(id, { maxLength: 4 })
      },
      strict
    ),
    time: objectSchema(
      {
        basis: literalSchema('server-show-created-at'),
        origin: id,
        atSeconds: seconds,
        observation: literalSchema('server-accepted'),
        mediaUncertaintyMs: literalSchema(null)
      },
      strict
    ),
    sourcePosition: nullableSchema(
      objectSchema(
        {
          sourceId: id,
          speechSessionId: id,
          offsetSeconds: seconds,
          uncertaintyMs: literalSchema(null)
        },
        strict
      )
    ),
    media: objectSchema(
      {
        status: literalSchema('unavailable'),
        reason: enumSchema(['no-recording', 'clock-unconfirmed']),
        extractable: literalSchema(false)
      },
      strict
    )
  },
  strict
)
export const cloudMarkerLookupSchema = unionSchema([
  objectSchema({ status: literalSchema('found'), marker: cloudMarkerSchema }, strict),
  objectSchema({ status: literalSchema('deleted') }, strict),
  objectSchema({ status: literalSchema('absent') }, strict)
])
export function markerTarget(m: TimelineMarker): MarkerTarget {
  return 'showId' in m
    ? { kind: 'cloud-show', showId: m.showId }
    : { kind: 'native-take', sessionId: m.sessionId }
}
export const CLOUD_MARKER_SAVED = 'Marker saved on the show timeline; no media to extract.'
