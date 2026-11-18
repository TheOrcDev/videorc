export const SCREEN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

export const SCREEN_IMAGE_BATCH_MAX = 32

// Main issues every capability in a batch up front, and the imports then run
// one at a time, each up to the backend's SCREEN_IMAGE_OPTIMIZER_TIMEOUT
// (20 s). So a capability lives the usual five minutes plus 20 s for each
// image in its batch, never past the backend's MAX_TTL (15 minutes). A
// single pick keeps about the lifetime every other picker gives.
const SCREEN_IMAGE_CAPABILITY_BASE_TTL_MS = 5 * 60_000
const SCREEN_IMAGE_CAPABILITY_PER_IMAGE_MS = 20_000
export const SCREEN_IMAGE_CAPABILITY_MAX_TTL_MS = 15 * 60_000

export function screenImageCapabilityTtlMs(batchSize: number): number {
  const images = Math.max(1, Math.min(SCREEN_IMAGE_BATCH_MAX, Math.floor(batchSize)))
  return Math.min(
    SCREEN_IMAGE_CAPABILITY_MAX_TTL_MS,
    SCREEN_IMAGE_CAPABILITY_BASE_TTL_MS + images * SCREEN_IMAGE_CAPABILITY_PER_IMAGE_MS
  )
}

export const SCREEN_IMAGE_REFUSALS = {
  tooMany: `Choose at most ${SCREEN_IMAGE_BATCH_MAX} images at a time.`,
  notImages: 'Only PNG, JPEG or WebP image files can become takeovers.'
} as const

export function isScreenImageRefusal(message: string): boolean {
  return (Object.values(SCREEN_IMAGE_REFUSALS) as string[]).includes(message)
}
