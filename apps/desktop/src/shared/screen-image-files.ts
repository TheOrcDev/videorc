export const SCREEN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

// Main issues every capability up front, and each import can run up to the
// backend's SCREEN_IMAGE_OPTIMIZER_TIMEOUT (20 s), so a full batch ends
// inside SCREEN_IMAGE_CAPABILITY_TTL_MS, the backend's MAX_TTL.
export const SCREEN_IMAGE_BATCH_MAX = 32
export const SCREEN_IMAGE_CAPABILITY_TTL_MS = 15 * 60_000

export const SCREEN_IMAGE_REFUSALS = {
  tooMany: `Choose at most ${SCREEN_IMAGE_BATCH_MAX} images at a time.`,
  notImages: 'Only PNG, JPEG or WebP image files can become takeovers.'
} as const

export function isScreenImageRefusal(message: string): boolean {
  return (Object.values(SCREEN_IMAGE_REFUSALS) as string[]).includes(message)
}
