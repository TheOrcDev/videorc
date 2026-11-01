import { extname, join } from 'node:path'

// Plan 174 S3.10 (C-40): the Assets gallery drew every imported background
// from its full-resolution file, a 4K image per 200 px tile. An import now
// writes a small copy beside the managed file, and the tile reads that.

/** Wide enough for a tile on a Retina display. */
export const BACKGROUND_THUMBNAIL_WIDTH = 480

/** The thumbnail's size: the image scaled to the width, never enlarged. */
export function backgroundThumbnailSize(
  size: { width: number; height: number },
  maxWidth = BACKGROUND_THUMBNAIL_WIDTH
): { width: number; height: number } | null {
  if (!(size.width > 0 && size.height > 0)) return null
  const scale = Math.min(1, maxWidth / size.width)
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  }
}

/**
 * `<id>.thumb.png` for a PNG (it may carry transparency), `<id>.thumb.jpg`
 * otherwise. The second dot keeps it out of the managed-asset scans, which
 * read `<id>.<ext>` only.
 */
export function backgroundThumbnailFileName(id: string, sourcePath: string): string {
  return `${id}.thumb.${extname(sourcePath).toLowerCase() === '.png' ? 'png' : 'jpg'}`
}

interface ThumbnailImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): ThumbnailImage
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

/**
 * Writes the thumbnail and returns its file name, or null when the image
 * can't be decoded here (the tile then reads the full file, as before).
 */
export function writeBackgroundThumbnail(input: {
  id: string
  sourcePath: string
  directory: string
  image: ThumbnailImage
  write: (path: string, bytes: Buffer) => void
}): string | null {
  if (input.image.isEmpty()) return null
  const size = backgroundThumbnailSize(input.image.getSize())
  if (!size) return null
  const resized = input.image.resize({ ...size, quality: 'best' })
  const fileName = backgroundThumbnailFileName(input.id, input.sourcePath)
  input.write(
    join(input.directory, fileName),
    fileName.endsWith('.png') ? resized.toPNG() : resized.toJPEG(82)
  )
  return fileName
}
