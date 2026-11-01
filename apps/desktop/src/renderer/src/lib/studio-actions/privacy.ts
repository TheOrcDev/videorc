import type { ScreenPrivacy } from '@/lib/backend'
import type { StudioActionOutcome } from './context'
export type PrivacyCaller = 'you' | 'remote' | 'agent' | 'buddy'
export const SCREEN_HIDE_UNAVAILABLE =
  "Hide screen isn't available on this recording. Stop and record again."
export async function screenPrivacyAction(
  client: { request<T>(method: string, params?: unknown): Promise<T> },
  mode: 'hide' | 'show' | 'toggle',
  caller: PrivacyCaller,
  reason: 'you' | 'password-manager' = 'you'
): Promise<StudioActionOutcome & { privacy?: ScreenPrivacy }> {
  const showing =
    mode === 'show' ||
    (mode === 'toggle' && (await client.request<ScreenPrivacy>('screen.privacy.get')).hidden)
  if (showing && (caller === 'agent' || caller === 'buddy'))
    return { ok: false, message: 'Only you can show your screen again.' }
  try {
    const privacy = await client.request<ScreenPrivacy>(
      showing ? 'screen.show' : 'screen.hide',
      showing ? undefined : { reason }
    )
    return { ok: true, privacy }
  } catch (error) {
    if ((error as { code?: string })?.code === 'screen-hide-unavailable')
      return { ok: false, message: SCREEN_HIDE_UNAVAILABLE }
    throw error
  }
}
