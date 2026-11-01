import type { PlatformAccount, StreamTargetSettings } from '@/lib/backend'
import { isStreamTargetReady, oauthUnavailableReason, streamServerUrlIssue } from '@/lib/capture'

/**
 * Whether a destination has what it needs to go live, in the words the
 * Livestream page uses (plan 080 S5/S7). Signed-in destinations need a
 * connected account; stream-key destinations need a saved key. The older
 * readiness count used the stored-key check for both, so a destination
 * connected by sign-in never counted as ready.
 */
export type DestinationSetup =
  | { ready: true }
  | {
      ready: false
      reason: 'sign-in' | 'reconnect' | 'stream-key' | 'server-url' | 'server-url-missing'
    }

export function destinationSetup(
  target: StreamTargetSettings,
  account: PlatformAccount | undefined
): DestinationSetup {
  const signIn =
    target.platform !== 'custom' &&
    target.authMode === 'oauth' &&
    !oauthUnavailableReason(target.platform)
  if (signIn) {
    if (!account) return { ready: false, reason: 'sign-in' }
    return account.status === 'connected' ? { ready: true } : { ready: false, reason: 'reconnect' }
  }
  if (target.urlMode !== 'full-url' && streamServerUrlIssue(target.serverUrl)) {
    return { ready: false, reason: 'server-url' }
  }
  const hasKey =
    target.streamKey.trim().length > 0 ||
    Boolean(target.streamKeySecretRef) ||
    target.streamKeyPresent
  if (target.urlMode !== 'full-url' && hasKey && !target.serverUrl.trim()) {
    // X, TikTok and Custom ship with an empty server URL. A pasted key with
    // no server used to read as "add a stream key"; it is the server that
    // is missing. With no key yet, the key is still asked for first.
    return { ready: false, reason: 'server-url-missing' }
  }
  return isStreamTargetReady(target) ? { ready: true } : { ready: false, reason: 'stream-key' }
}

/** One short phrase for a destination that is not ready yet. */
export function destinationSetupHint(setup: DestinationSetup): string | null {
  if (setup.ready) return null
  switch (setup.reason) {
    case 'sign-in':
      return 'sign in or add a stream key'
    case 'reconnect':
      return 'reconnect your account'
    case 'stream-key':
      return 'add a stream key'
    case 'server-url':
      return 'fix the server URL'
    case 'server-url-missing':
      return 'add the server URL'
  }
}
