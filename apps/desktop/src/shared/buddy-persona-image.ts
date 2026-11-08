// The Buddy persona image path rule and its managed URL (plan 164 S-A3, D20;
// plan 169), alone in their own module: the eager shell shows the
// streamer's Buddy in the sidebar, and importing `buddy-assets.ts` there
// would carry every draft, pack and library rule into the eager bundle with
// it. `buddy-assets.ts` re-exports all of it.

import type { CohostAvatarState } from './backend'

export const BUDDY_IMAGE_EXTENSIONS = ['png', 'webp', 'jpg'] as const
export type BuddyImageExtension = (typeof BUDDY_IMAGE_EXTENSIONS)[number]
/** The managed protocol host the renderer loads persona images from. */
export const BUDDY_ASSET_HOST = 'buddy'

/**
 * A persona image path taken apart, or null for anything else:
 * `<personaId>/<state>.<ext>` (an upload from before plan 169) or
 * `<personaId>/<state>-<tag>.<ext>` (a kept look, plan 169: the tag is 8 hex
 * digits, so each kept look has its own path and no surface shows a cached
 * picture of the one before). `file` is the name inside the persona folder.
 */
export function parseBuddyAssetPath(relativePath: string): {
  personaId: string
  state: CohostAvatarState
  extension: BuddyImageExtension
  file: string
} | null {
  const match =
    /^([A-Za-z0-9_-]{1,128})\/((idle|talk|laugh|think)(?:-[0-9a-f]{8})?\.(png|webp|jpg))$/.exec(
      relativePath
    )
  if (!match) return null
  return {
    personaId: match[1]!,
    state: match[3] as CohostAvatarState,
    extension: match[4] as BuddyImageExtension,
    file: match[2]!
  }
}

/** The managed URL for a persona image (`parseBuddyAssetPath`), or null for
 * anything else: never a draft, and never a reach outside the root. */
export function buddyPersonaImageUrl(relativePath: string): string | null {
  return parseBuddyAssetPath(relativePath)
    ? `videorc-asset://${BUDDY_ASSET_HOST}/${relativePath}`
    : null
}
