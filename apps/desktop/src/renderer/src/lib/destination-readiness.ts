import type { PlatformAccount, StreamTargetSettings } from '@/lib/backend'
import { isStreamTargetReady, oauthUnavailableReason } from '@/lib/capture'

/**
 * Whether a destination has what it needs to go live, in the words the
 * Livestream page uses (plan 080 S5/S7). Signed-in destinations need a
 * connected account; stream-key destinations need a saved key. The older
 * readiness count used the stored-key check for both, so a destination
 * connected by sign-in never counted as ready.
 */
export type DestinationSetup =
  | { ready: true }
  | { ready: false; reason: 'sign-in' | 'reconnect' | 'stream-key' }

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
  }
}
