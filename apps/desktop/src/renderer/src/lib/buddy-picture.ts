import type { CohostPersona } from '@/lib/backend'
import { buddyPersonaImageUrl } from '../../../shared/buddy-persona-image'

/**
 * The streamer's own Buddy as one picture, for the slots that stand for it
 * outside the stream (the Buddy page's sidebar row and ⌘K entries, the Buddy
 * tab's header): its idle pose as a managed `videorc-asset://buddy/...` URL.
 * Null while the persona has no picture of its own (the untouched default,
 * the official golem, settings not loaded yet), so the slot keeps the bundled
 * golem. Safe for the eager shell: no bundled pack art, and only the persona
 * image rule (`buddy-persona-image.ts`), never the whole of `buddy-assets.ts`.
 */
export function buddyPictureUrl(
  persona: Pick<CohostPersona, 'images'> | null | undefined
): string | null {
  const idle = persona?.images.idle
  return idle ? buddyPersonaImageUrl(idle) : null
}
