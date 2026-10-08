import type { CohostAvatarState, CohostPersona } from '@/lib/backend'
import idleUrl from '@/assets/golem/default/idle.svg'
import laughUrl from '@/assets/golem/default/laugh.svg'
import talkUrl from '@/assets/golem/default/talk.svg'
import thinkUrl from '@/assets/golem/default/think.svg'
import { golemAssetUrl } from '../../../shared/golem-assets'

/**
 * The bundled default pack (plan 164 D22): what a fresh install shows and
 * what `persona.source: 'default'` means. Placeholder art, owner to replace
 * (see the folder's README). Import this module only from lazy chunks (the
 * Golem tab, later the overlay rasterizer), never from the eager shell.
 */
export const GOLEM_DEFAULT_PACK: Readonly<Record<CohostAvatarState, string>> = {
  idle: idleUrl,
  talk: talkUrl,
  laugh: laughUrl,
  think: thinkUrl
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
