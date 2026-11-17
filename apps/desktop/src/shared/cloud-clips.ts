import {
  arraySchema,
  booleanSchema,
  enumSchema,
  literalSchema,
  nullableSchema,
  objectSchema,
  optionalSchema,
  stringSchema
} from './runtime-schema'
export type CloudClipsStatus = {
  available: boolean
  enabled: boolean
  generation: string | null
  state: string
  reason: string
}
export type CloudClipJob = {
  id: string
  showId: string
  markerId: string
  state: string
  reason: string
  localSessionId: string | null
}
const text = stringSchema({ minLength: 1, maxLength: 2048 })
export const cloudClipsStatusSchema = objectSchema(
  {
    available: booleanSchema,
    enabled: booleanSchema,
    generation: nullableSchema(text),
    state: text,
    reason: text
  },
  { allowUnknown: false }
)
export const cloudClipJobSchema = objectSchema(
  {
    id: text,
    showId: text,
    markerId: text,
    state: enumSchema([
      'downloading',
      'trimming',
      'publishing',
      'complete',
      'interrupted',
      'cancelled'
    ]),
    reason: text,
    localSessionId: nullableSchema(text)
  },
  { allowUnknown: false }
)
export const cloudClipJobsSchema = arraySchema(cloudClipJobSchema, { maxLength: 16 })
export const cloudClipsEnableSchema = objectSchema(
  {
    showId: text,
    consent: literalSchema(true),
    outputDirectoryCapability: optionalSchema(text),
    outputDirectory: optionalSchema(text),
    orientation: enumSchema(['h', 'v']),
    requestId: stringSchema({ minLength: 36, maxLength: 36 })
  },
  { allowUnknown: false }
)
