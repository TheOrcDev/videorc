/**
 * Plan 249 S5: why the worn avatar shows still on cloud outputs, in the
 * streamer's words (shown under the Program preview). Dependency-free so the
 * room hook can name a reason even when the atlas code itself failed to load.
 *
 * A `CloudAvatarAtlasRefusal` is a pack the cloud cannot animate within S4's
 * limits; its message is the copy. Anything else is a fault and reads as
 * `CLOUD_AVATAR_ATLAS_FAILED` (the detail goes to the console).
 */
export class CloudAvatarAtlasRefusal extends Error {}

export const CLOUD_AVATAR_ATLAS_FAILED =
  "Couldn't animate the avatar on cloud outputs. It shows still."

export function cloudAvatarAtlasReason(error: unknown): string {
  return error instanceof CloudAvatarAtlasRefusal ? error.message : CLOUD_AVATAR_ATLAS_FAILED
}
