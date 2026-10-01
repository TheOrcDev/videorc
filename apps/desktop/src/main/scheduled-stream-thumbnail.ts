import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ScheduledThumbnail = { id: string; previewUrl: string; width: number; height: number }

/** A stored thumbnail never exceeds this; the backend validators agree. */
const STORED_MAX_BYTES = 2 * 1024 * 1024
/** A picked source may be larger (YouTube accepts 50 MB); it is fitted down. */
const SOURCE_MAX_BYTES = 50 * 1024 * 1024
const MAX_PIXELS = 20_000_000
/** JPEG qualities tried, best first, until the fitted image is under 2 MB. */
const FIT_QUALITIES = [90, 80, 70] as const

/**
 * Re-encode an image as a JPEG with at most a 1280 px long edge (keeping
 * aspect, never upscaling) at the given quality. Injected: Electron's
 * nativeImage in the app, a fake in tests.
 */
export type ThumbnailFit = (bytes: Buffer, quality: number) => Buffer

/** Format and pixel-count check from the header only, before any decode. */
function thumbnailHeaderFormat(bytes: Buffer): 'png' | 'jpg' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.includes(Buffer.from('acTL')))
      throw new Error('Animated thumbnails are not supported.')
    if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_PIXELS) {
      throw new Error('Thumbnail exceeds 20 megapixels.')
    }
    return 'png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2) break
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        const pixels = bytes.readUInt16BE(offset + 5) * bytes.readUInt16BE(offset + 7)
        if (!pixels || pixels > MAX_PIXELS) throw new Error('Thumbnail exceeds 20 megapixels.')
        return 'jpg'
      }
      offset += length + 2
    }
    throw new Error('Corrupt or unsupported JPEG thumbnail.')
  }
  throw new Error('Choose a JPEG or PNG image. The file contents must match the format.')
}

/** The stored form: header checks plus the 2 MB cap. */
export function thumbnailFormat(bytes: Buffer): 'png' | 'jpg' {
  if (bytes.length === 0 || bytes.length > STORED_MAX_BYTES) {
    throw new Error('Choose a thumbnail smaller than 2 MB.')
  }
  return thumbnailHeaderFormat(bytes)
}

async function readThumbnailBytes(sourcePath: string, maxBytes: number): Promise<Buffer> {
  const file = await open(sourcePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`Choose an image smaller than ${maxBytes / 1024 / 1024} MB.`)
    }
    // One byte past the stat size catches a file that grew after stat.
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** Fit an oversize source under 2 MB, stepping JPEG quality down. */
export function fitThumbnail(source: Buffer, fit: ThumbnailFit): Buffer {
  for (const quality of FIT_QUALITIES) {
    const fitted = fit(source, quality)
    if (fitted.length > 0 && fitted.length <= STORED_MAX_BYTES) return fitted
  }
  throw new Error('This image could not be reduced to 2 MB. Choose a smaller one.')
}

export async function importScheduledThumbnail(
  sourcePath: string,
  root: string,
  decode: (bytes: Buffer) => { width: number; height: number },
  register: (id: string, path: string) => Promise<unknown>,
  fit?: ThumbnailFit
): Promise<ScheduledThumbnail> {
  const source = await readThumbnailBytes(sourcePath, fit ? SOURCE_MAX_BYTES : STORED_MAX_BYTES)
  if (source.length === 0) throw new Error('Choose a thumbnail smaller than 2 MB.')
  thumbnailHeaderFormat(source)
  // At or under 2 MB the file is stored byte-identical; larger ones are fitted.
  const bytes = source.length > STORED_MAX_BYTES && fit ? fitThumbnail(source, fit) : source
  const extension = thumbnailFormat(bytes)
  const { width, height } = decode(bytes)
  if (!width || !height || width * height > MAX_PIXELS) {
    throw new Error('Thumbnail is corrupt or exceeds 20 megapixels.')
  }
  const id = createHash('sha256').update(bytes).digest('hex')
  await mkdir(root, { recursive: true })
  const path = join(root, `${id}.${extension}`)
  await writeFile(path, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    if (!bytes.equals(await readThumbnailBytes(path, STORED_MAX_BYTES)))
      throw new Error('Managed thumbnail contents changed. Choose another image.')
  })
  await register(id, path)
  return { id, previewUrl: `videorc-asset://scheduled-thumbnail/${id}`, width, height }
}
