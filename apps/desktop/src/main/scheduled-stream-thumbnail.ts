import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ScheduledThumbnail = { id: string; previewUrl: string; width: number; height: number }

export function thumbnailFormat(bytes: Buffer): 'png' | 'jpg' {
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
    throw new Error('Choose a thumbnail smaller than 2 MB.')
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.includes(Buffer.from('acTL')))
      throw new Error('Animated thumbnails are not supported.')
    if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 20_000_000) {
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
        if (!pixels || pixels > 20_000_000) throw new Error('Thumbnail exceeds 20 megapixels.')
        return 'jpg'
      }
      offset += length + 2
    }
    throw new Error('Corrupt or unsupported JPEG thumbnail.')
  }
  throw new Error('Choose a JPEG or PNG image. The file contents must match the format.')
}

async function readThumbnailBytes(sourcePath: string): Promise<Buffer> {
  const file = await open(sourcePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error('Choose an image smaller than 2 MB.')
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export async function importScheduledThumbnail(
  sourcePath: string,
  root: string,
  decode: (bytes: Buffer) => { width: number; height: number },
  register: (id: string, path: string) => Promise<unknown>
): Promise<ScheduledThumbnail> {
  const bytes = await readThumbnailBytes(sourcePath)
  const extension = thumbnailFormat(bytes)
  const { width, height } = decode(bytes)
  if (!width || !height || width * height > 20_000_000) {
    throw new Error('Thumbnail is corrupt or exceeds 20 megapixels.')
  }
  const id = createHash('sha256').update(bytes).digest('hex')
  await mkdir(root, { recursive: true })
  const path = join(root, `${id}.${extension}`)
  await writeFile(path, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    if (!bytes.equals(await readThumbnailBytes(path)))
      throw new Error('Managed thumbnail contents changed. Choose another image.')
  })
  await register(id, path)
  return { id, previewUrl: `videorc-asset://scheduled-thumbnail/${id}`, width, height }
}
