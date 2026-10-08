import type {
  PlatformAccount,
  PlatformConnectOptions,
  ScopeReconnectPlatform,
  StreamPlatform
} from './backend'

// Optional OAuth scopes (plan 055, S6; plan 140, S5). Opt-in: adding a scope
// to a platform's base set would make every existing connection reconnect
// once. Kept out of `backend.ts` so the main window's eager bundle does not
// carry them: only lazy surfaces (Livestream setup, the Orcle tab), the
// Stream Manager window and Electron main import this module.
//
// The optional lists mirror `optional_scopes_for` in
// `crates/videorc-backend/src/oauth.rs`, which refuses any scope it does not
// offer. `platform-scopes.test.ts` reads that table and fails on drift.

/** Twitch permissions for follow alerts and the sub count in the Stream Manager. */
export const TWITCH_AUDIENCE_SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions'
] as const

/** Twitch permissions for Power-ups paid with bits and channel point
 * redemptions in Activity (plan 162). Read only. */
export const TWITCH_BITS_POINTS_SCOPES = ['bits:read', 'channel:read:redemptions'] as const

/** Twitch `DELETE /helix/moderation/chat`: remove one chat message (plan 140). */
export const TWITCH_MODERATION_SCOPE = 'moderator:manage:chat_messages'
/** Kick `DELETE /public/v1/chat/{message_id}`: remove one chat message (plan 140). */
export const KICK_MODERATION_SCOPE = 'moderation:chat_message:manage'
/** YouTube's one base scope. It already covers `liveChatMessages.delete`. */
export const YOUTUBE_FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'

/**
 * Every optional Twitch scope. Every Twitch connect and reconnect asks for all
 * of them: the backend requests the base set plus only the optional scopes it
 * is passed (keeping the ones the account already holds), so a path that
 * passed a subset would never grant the rest.
 */
export const TWITCH_OPTIONAL_SCOPES = [
  ...TWITCH_AUDIENCE_SCOPES,
  TWITCH_MODERATION_SCOPE,
  ...TWITCH_BITS_POINTS_SCOPES
] as const
/** Every optional Kick scope (plan 140: optional, asked for only from its Reconnect row). */
export const KICK_OPTIONAL_SCOPES = [KICK_MODERATION_SCOPE] as const

/**
 * Every optional scope `platform` offers, exactly `optional_scopes_for` in
 * `oauth.rs`: what a permission row's Reconnect asks for ("Reconnect Twitch
 * to let Orcle remove messages", the Stream Manager's twin, Show who
 * followed). Never a hand-picked subset.
 */
export function permissionReconnectScopes(platform: StreamPlatform): readonly string[] {
  switch (platform) {
    case 'twitch':
      return TWITCH_OPTIONAL_SCOPES
    case 'kick':
      return KICK_OPTIONAL_SCOPES
    default:
      return []
  }
}

/**
 * The optional scopes an ordinary Connect or Reconnect of `platform` asks for.
 * Twitch asks for all of them, so Activity names followers and Orcle can
 * remove messages from the first stream. Kick asks for none: Kick can refuse a
 * scope its app settings don't enable, and that would fail every Kick connect,
 * so its moderation scope is asked for only from the "Remove messages" row.
 * The backend keeps the optional scopes an account already holds on every
 * reconnect (`retained_optional_scopes` in `main.rs`), so this never drops a
 * grant.
 */
export function connectOptionalScopes(platform: StreamPlatform): readonly string[] {
  return platform === 'twitch' ? TWITCH_OPTIONAL_SCOPES : []
}

function optionalScopesOptions(
  optionalScopes: readonly string[]
): PlatformConnectOptions | undefined {
  return optionalScopes.length ? { optionalScopes } : undefined
}

/**
 * What an ordinary Connect or Reconnect of `platform` passes to `onConnect`.
 * `undefined` for platforms that ask for nothing extra.
 */
export function platformConnectOptions(
  platform: StreamPlatform
): PlatformConnectOptions | undefined {
  return optionalScopesOptions(connectOptionalScopes(platform))
}

/** What a permission row's Reconnect passes to `onConnect`: every optional scope. */
export function permissionReconnectOptions(
  platform: StreamPlatform
): PlatformConnectOptions | undefined {
  return optionalScopesOptions(permissionReconnectScopes(platform))
}

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
 * Whether Videorc can remove a chat message on a platform, judged from the
 * account it would use (plan 140, S5). Meant to agree with the backend's
 * per-destination `moderate` state (S4), minus `paused`, which only the
 * backend knows (the YouTube quota):
 *
 * - `ready`: the platform delete will run.
 * - `missing-scope`: a reconnect fixes it. The account lacks the permission,
 *   needs a reconnect, or isn't connected. On X the fix is Authorize X Live.
 * - `unsupported`: the platform has no delete API (TikTok, Instagram, custom
 *   RTMP). Videorc can only hide the message locally.
 */
export type RemoveMessagesReadiness = 'ready' | 'missing-scope' | 'unsupported'

/**
 * - YouTube: ready with `youtube.force-ssl`, the base scope every connection
 *   holds.
 * - Twitch: ready with `moderator:manage:chat_messages`.
 * - Kick: ready with `moderation:chat_message:manage`.
 * - X: ready when the account is connected and Authorize X Live holds
 *   credentials for it (`XNativeLiveCapability.nativeAvailable`, passed as
 *   `xLiveAuthorized`). X deletes use those OAuth 1.0a credentials, not an
 *   OAuth 2 scope. Whether they can delete is still owed a live check.
 * - Any account that isn't `connected` is `missing-scope`, as the backend's
 *   chat `write` state treats it.
 */
export function removeMessagesReadiness(
  platform: StreamPlatform,
  account: Pick<PlatformAccount, 'scopes' | 'status'> | null | undefined,
  options: { xLiveAuthorized?: boolean } = {}
): RemoveMessagesReadiness {
  const connected = account?.status === 'connected'
  const holds = (scope: string): boolean => connected && Boolean(account?.scopes.includes(scope))
  switch (platform) {
    case 'youtube':
      return holds(YOUTUBE_FORCE_SSL_SCOPE) ? 'ready' : 'missing-scope'
    case 'twitch':
      return holds(TWITCH_MODERATION_SCOPE) ? 'ready' : 'missing-scope'
    case 'kick':
      return holds(KICK_MODERATION_SCOPE) ? 'ready' : 'missing-scope'
    case 'x':
      return connected && options.xLiveAuthorized === true ? 'ready' : 'missing-scope'
    case 'tiktok':
    case 'instagram':
    case 'custom':
      return 'unsupported'
  }
}

/**
 * Platforms whose missing permission one reconnect grants, from Livestream
 * setup or the Stream Manager. YouTube never lacks one (its base scope covers
 * deletes) and X authorizes through Authorize X Live instead.
 */
export const SCOPE_RECONNECT_PLATFORMS = [
  'twitch',
  'kick'
] as const satisfies readonly ScopeReconnectPlatform[]

export function isScopeReconnectPlatform(value: unknown): value is ScopeReconnectPlatform {
  return (SCOPE_RECONNECT_PLATFORMS as readonly unknown[]).includes(value)
}

const SCOPE_RECONNECT_LABELS: Record<ScopeReconnectPlatform, string> = {
  twitch: 'Twitch',
  kick: 'Kick'
}

/** The quiet sentence for a platform that can't remove messages until a reconnect. */
export function removeMessagesReconnectCopy(platform: ScopeReconnectPlatform): string {
  return `Reconnect ${SCOPE_RECONNECT_LABELS[platform]} to let Orcle remove messages.`
}

/**
 * The Stream Manager's reconnect rows: each Twitch or Kick chat whose
 * `moderate` state (the backend's, plan 140 S4) is `missing-scope`, once per
 * platform, in provider order. The parameter is structural so any provider
 * state carrying `moderate` fits.
 */
export function removeMessagesReconnectPlatforms(
  providers: readonly { platform: StreamPlatform; moderate?: string }[]
): ScopeReconnectPlatform[] {
  const platforms: ScopeReconnectPlatform[] = []
  for (const provider of providers) {
    if (provider.moderate !== 'missing-scope') continue
    const { platform } = provider
    if (isScopeReconnectPlatform(platform) && !platforms.includes(platform)) {
      platforms.push(platform)
    }
  }
  return platforms
}
