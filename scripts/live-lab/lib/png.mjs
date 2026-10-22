import { deflateSync } from 'node:zlib'

// Plan 178 U9. A minimal PNG writer (8-bit RGB or RGBA, no interlace, filter
// 0) so frames and charts land in the run folder without a new dependency.
// The reader side lives in scripts/lib/image-stats.mjs (decodePng).

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let crcTable = null

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/**
 * Encodes packed pixels (`channels` 3 for RGB, 4 for RGBA) as a PNG buffer.
 */
export function encodePng(width, height, pixels, { channels = 3 } = {}) {
  if (![3, 4].includes(channels)) throw new Error('channels must be 3 or 4')
  if (!pixels || pixels.length < width * height * channels) {
    throw new Error(`pixels hold ${pixels?.length ?? 0} bytes, need ${width * height * channels}`)
  }
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  const source = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels.buffer, pixels.byteOffset)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    source.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
