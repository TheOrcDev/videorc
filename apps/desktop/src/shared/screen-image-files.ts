export const SCREEN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

// Each import may take the backend's 20 s optimizer budget, so a full batch
// finishes inside SCREEN_IMAGE_CAPABILITY_TTL_MS, the backend's longest TTL.
export const SCREEN_IMAGE_BATCH_MAX = 32
export const SCREEN_IMAGE_CAPABILITY_TTL_MS = 15 * 60_000

export const SCREEN_IMAGE_REFUSALS = {
  tooMany: `Choose at most ${SCREEN_IMAGE_BATCH_MAX} images at a time.`,
  notImages: 'Only PNG, JPEG or WebP image files can become takeovers.'
} as const

export function isScreenImageRefusal(message: string): boolean {
  return (Object.values(SCREEN_IMAGE_REFUSALS) as string[]).includes(message)
}
