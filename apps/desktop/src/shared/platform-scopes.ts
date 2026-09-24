/**
 * Twitch permissions for follow alerts and the sub count in the Stream
 * Manager (plan 053, S6). Opt-in: adding them to the base set would make
 * every existing Twitch connection reconnect once. Kept out of `backend.ts`
 * so the main window's eager bundle does not carry them.
 */
export const TWITCH_AUDIENCE_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions'
] as const

export function hasTwitchAudienceScopes(scopes: readonly string[]): {
  followEvents: boolean
  subscriberCount: boolean
} {
  return {
    followEvents: scopes.includes(TWITCH_AUDIENCE_SCOPES[0]),
    subscriberCount: scopes.includes(TWITCH_AUDIENCE_SCOPES[1])
  }
}
