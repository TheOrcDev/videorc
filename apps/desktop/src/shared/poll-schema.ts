import { POLL_MAX_OPTIONS, type PollStatus, type StreamPlatform } from './backend'
import type { PollRelayCommand } from './poll-relay'
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
  type RuntimeSchema
} from './runtime-schema'

// Plan 188 S2: the poll's runtime schemas, shared by the backend contract
// (`polls.*`, `polls.status`) and the Electron relay (`comments-window:poll*`)
// so the preload never loads the whole backend contract. Exact, like the
// pinned `poll` fixture: optional fields are absent, never `null` (the serde
// null trap); `poll: null` on the event is the one deliberate null.

const strict = { allowUnknown: false } as const

const pollPlatforms = [
  'youtube',
  'twitch',
  'kick',
  'x',
  'tiktok',
  'instagram',
  'custom'
] as const satisfies readonly StreamPlatform[]
const platformSchema = enumSchema(pollPlatforms) as RuntimeSchema<StreamPlatform>
const platformListSchema = arraySchema(platformSchema, { maxLength: pollPlatforms.length })
const count = numberSchema({ integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
const timestamp = stringSchema({ minLength: 1, maxLength: 128 })
/** Opaque ids: the backend mints a UUID; bounded, never parsed here. */
export const pollIdSchema = stringSchema({ minLength: 1, maxLength: 128 })
// The backend counts question and answer limits in Unicode scalar values and
// refuses with its own sentence; these bounds only keep the payload sane, so
// a too-long draft reaches the backend's refusal instead of a schema error.
const pollText = stringSchema({ minLength: 1, maxLength: 1_000 })
const draftText = stringSchema({ maxLength: 1_000 })

const pollPostSummarySchema = objectSchema(
  {
    phase: enumSchema(['sending', 'sent', 'partial', 'failed']),
    failedPlatforms: platformListSchema
  },
  strict
)

export const pollStatusSchema = objectSchema(
  {
    pollId: pollIdSchema,
    sessionId: stringSchema({ minLength: 1, maxLength: 4096 }),
    question: pollText,
    options: arraySchema(objectSchema({ label: pollText, votes: count }, strict), {
      maxLength: POLL_MAX_OPTIONS
    }),
    totalVotes: count,
    byPlatform: arraySchema(objectSchema({ platform: platformSchema, votes: count }, strict), {
      maxLength: pollPlatforms.length
    }),
    state: enumSchema(['open', 'counting', 'final', 'cancelled']),
    openedAt: timestamp,
    closesAt: optionalSchema(timestamp),
    endedAt: optionalSchema(timestamp),
    acceptUntil: optionalSchema(timestamp),
    finalAt: optionalSchema(timestamp),
    durationSeconds: optionalSchema(numberSchema({ integer: true, min: 0, max: 604_800 })),
    postInChat: booleanSchema,
    card: enumSchema(['shown', 'hidden']),
    cardLegs: objectSchema({ primary: booleanSchema, auxiliary: booleanSchema }, strict),
    cardAvailable: booleanSchema,
    winners: arraySchema(numberSchema({ integer: true, min: 0, max: POLL_MAX_OPTIONS - 1 }), {
      maxLength: POLL_MAX_OPTIONS
    }),
    countingPlatforms: platformListSchema,
    pausedPlatforms: platformListSchema,
    startPost: optionalSchema(pollPostSummarySchema),
    resultPost: optionalSchema(pollPostSummarySchema)
  },
  strict
) as RuntimeSchema<PollStatus>

/** `polls.current`, the Studio → Stream Manager push and main's cache. */
export const pollStatusOrNoneSchema = nullableSchema(pollStatusSchema)

/** `polls.status`: `{ poll: PollStatus | null }`, the null pinned on purpose. */
export const pollStatusEventSchema = objectSchema({ poll: pollStatusOrNoneSchema }, strict)

/** `polls.start`. `durationSeconds` is required: a number, or `null` for No timer. */
export const pollStartParamsSchema = objectSchema(
  {
    question: draftText,
    options: arraySchema(draftText, { maxLength: 16 }),
    durationSeconds: nullableSchema(numberSchema({ integer: true, min: 0, max: 604_800 })),
    postInChat: booleanSchema
  },
  strict
)

/** `polls.end`, `polls.cancel`, `polls.reshow`. */
export const pollIdParamsSchema = objectSchema({ pollId: pollIdSchema }, strict)

const relayRequestIdSchema = stringSchema({ minLength: 1, maxLength: 128 })

/** Stream Manager → main → Studio: one explicit poll action. */
export const pollRelayCommandSchema = unionSchema([
  objectSchema(
    {
      requestId: relayRequestIdSchema,
      action: literalSchema('start'),
      params: pollStartParamsSchema
    },
    strict
  ),
  objectSchema(
    {
      requestId: relayRequestIdSchema,
      action: enumSchema(['end', 'cancel', 'reshow']),
      pollId: pollIdSchema
    },
    strict
  )
]) as RuntimeSchema<PollRelayCommand>

/** Studio's answer: done, or the backend's sentence that says why not. */
export const pollRelayResolutionSchema = unionSchema([
  objectSchema(
    { requestId: relayRequestIdSchema, ok: literalSchema(true), value: literalSchema(true) },
    strict
  ),
  objectSchema(
    {
      requestId: relayRequestIdSchema,
      ok: literalSchema(false),
      error: stringSchema({ minLength: 1, maxLength: 2000 })
    },
    strict
  )
])
