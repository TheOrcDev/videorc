import type { CohostAvatarState, CohostPersona } from '@/lib/backend'
import idleUrl from '@/assets/golem/default/idle.webp'
import { golemAssetUrl } from '../../../shared/golem-assets'

/**
 * The bundled default pack (plan 164 D22): what a fresh install shows and
 * what `persona.source: 'default'` means. The owner's stone golem (the
 * master lives in `assets/brand/golem/`) is the idle image; the other states
 * fall back to it until matching art exists (D16 allows a pack with idle
 * only). Import this module only from lazy chunks (the Golem tab, the
 * overlay rasterizer), never from the eager shell.
 */
export const GOLEM_DEFAULT_PACK: Readonly<Record<CohostAvatarState, string>> = {
  idle: idleUrl,
  talk: idleUrl,
  laugh: idleUrl,
  think: idleUrl
}

/**
 * The URL a state tile shows for a persona: the persona's own image when it
 * has one (as a managed `videorc-asset://golem/...` URL), else the bundled
 * default for that state. Only `idle` is required (D16): a missing state
 * falls back to the persona's idle image before the default pack's state.
 */
export function golemStateImageUrl(
  persona: Pick<CohostPersona, 'images' | 'source'>,
  state: CohostAvatarState
): string {
  const own = persona.images[state] ?? persona.images.idle
  const url = own ? golemAssetUrl(own) : null
  return url ?? GOLEM_DEFAULT_PACK[state]
}

/** Whether the persona carries its own image for this state. */
export function golemHasOwnImage(
  persona: Pick<CohostPersona, 'images'>,
  state: CohostAvatarState
): boolean {
  return Boolean(persona.images[state])
}
