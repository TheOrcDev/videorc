/**
 * Twitch permissions for follow alerts and the sub count in the Stream
 * Manager (plan 055, S6). Opt-in: adding them to the base set would make
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

/**
 * Optional scopes a connect asks for when the caller named none (plan 071,
 * S2). A first Twitch connection asks for the audience scopes, so Activity
 * names followers from the first stream; a reconnect keeps them when the
 * account already had them, instead of silently dropping follow names.
 * Other existing connections are never forced to reconnect.
 */
export function twitchAudienceScopesByDefault(
  platform: string,
  accounts: readonly { platform: string; scopes: readonly string[] }[]
): readonly string[] {
  if (platform !== 'twitch') return []
  const twitch = accounts.filter((account) => account.platform === 'twitch')
  if (twitch.length === 0) return TWITCH_AUDIENCE_SCOPES
  return twitch.some((account) => hasTwitchAudienceScopes(account.scopes).followEvents)
    ? TWITCH_AUDIENCE_SCOPES
    : []
}
