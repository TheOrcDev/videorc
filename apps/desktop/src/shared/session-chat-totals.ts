import type { SessionChatTotals } from './backend'
import {
  arraySchema,
  enumSchema,
  literalSchema,
  numberSchema,
  objectSchema,
  RuntimeSchemaError,
  runtimeSchema,
  stringSchema,
  unionSchema
} from './runtime-schema'

const count = numberSchema({ integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
export const sessionChatIdentifierSchema = stringSchema({ minLength: 1, maxLength: 4096 })
const sessionId = sessionChatIdentifierSchema
const shape = unionSchema([
  objectSchema(
    {
      status: literalSchema('available'),
      sessionId,
      revision: count,
      messageCount: count,
      chatters: count,
      follows: count,
      supporters: count,
      bits: count,
      raids: count,
      platforms: arraySchema(
        enumSchema(['youtube', 'twitch', 'kick', 'x', 'tiktok', 'instagram', 'custom']),
        { maxLength: 7 }
      ),
      tips: arraySchema(
        objectSchema(
          { currency: stringSchema({ maxLength: 64 }), amountMicros: count },
          { allowUnknown: false }
        ),
        { maxLength: 256 }
      )
    },
    { allowUnknown: false }
  ),
  objectSchema({ status: literalSchema('legacy-unavailable'), sessionId }, { allowUnknown: false })
])

/** This DTO contains only bounded accounting facts, never whole-session rows. */
export const sessionChatTotalsSchema = runtimeSchema<SessionChatTotals>(
  'confirmed session chat totals',
  (value, path) => {
    const totals = shape.parse(value, path) as SessionChatTotals
    if (
      totals.status === 'available' &&
      (new Set(totals.platforms).size !== totals.platforms.length ||
        new Set(totals.tips.map((tip) => tip.currency)).size !== totals.tips.length)
    )
      throw new RuntimeSchemaError(path, 'unique accounting platforms and currencies')
    return totals
  }
)
