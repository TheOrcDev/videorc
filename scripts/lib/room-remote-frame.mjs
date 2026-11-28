// The backend room's returned pictures (plan 260 S1.8d): `GET /room/remote/latest.bmp`
// serves the latest frame of a person's camera (`source=camera`, the guest's
// identity) or of the runner's return (`source=monitor`, the Program monitor)
// as a top-down 32-bit BMP (a V4 header, BI_BITFIELDS, BGRA). These helpers read
// one and take its luma plane the way the smoke's receiver probes do (limited
// range BT.601), so `evaluateTilePlan` judges a returned picture like a received one.

/** @returns {{width:number,height:number,bgra:Buffer}} */
export function parseBgraBmp(bytes) {
  const bmp = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (bmp.length < 54 || bmp.subarray(0, 2).toString('ascii') !== 'BM') {
    throw new Error(`not a BMP (${bmp.length} bytes)`)
  }
  const pixelOffset = bmp.readUInt32LE(10)
  const width = bmp.readInt32LE(18)
  const signedHeight = bmp.readInt32LE(22)
  const height = Math.abs(signedHeight)
  const bitsPerPixel = bmp.readUInt16LE(28)
  const pixelBytes = width * height * 4
  if (width <= 0 || height <= 0 || bitsPerPixel !== 32 || bmp.length < pixelOffset + pixelBytes) {
    throw new Error(
      `unsupported BMP: ${width}x${signedHeight}, ${bitsPerPixel} bpp, ${bmp.length} bytes`
    )
  }
  const rows = bmp.subarray(pixelOffset, pixelOffset + pixelBytes)
  if (signedHeight < 0) return { width, height, bgra: Buffer.from(rows) }
  // Bottom-up: flip to top-down.
  const flipped = Buffer.allocUnsafe(pixelBytes)
  const stride = width * 4
  for (let row = 0; row < height; row += 1) {
    rows.copy(flipped, row * stride, (height - 1 - row) * stride, (height - row) * stride)
  }
  return { width, height, bgra: flipped }
}

/** The luma plane (`y`, `width`, `height`) of a BGRA picture, 16..235. */
export function lumaPlaneOfBgra({ width, height, bgra }) {
  const y = new Uint8Array(width * height)
  for (let i = 0; i < y.length; i += 1) {
    const b = bgra[i * 4]
    const g = bgra[i * 4 + 1]
    const r = bgra[i * 4 + 2]
    y[i] = Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b)
  }
  return { y, width, height }
}

/** The mean luma of the middle half of the picture (a solid-colour guest). */
export function centreMeanLuma(plane) {
  const { y, width, height } = plane
  const x0 = Math.floor(width / 4)
  const x1 = Math.ceil((width * 3) / 4)
  const y0 = Math.floor(height / 4)
  const y1 = Math.ceil((height * 3) / 4)
  let total = 0
  let count = 0
  for (let row = y0; row < y1; row += 1) {
    for (let col = x0; col < x1; col += 1) {
      total += y[row * width + col]
      count += 1
    }
  }
  return count ? total / count : Number.NaN
}

/**
 * Fetches one returned picture: `{ status: 200, plane }`, or `{ status }` for
 * 204 (nothing yet) and anything else.
 */
export async function fetchRoomRemoteFrame(connection, { identity = '', source }) {
  const url = new URL(`http://${connection.host}:${connection.port}/room/remote/latest.bmp`)
  url.searchParams.set('token', connection.token)
  url.searchParams.set('identity', identity)
  url.searchParams.set('source', source)
  const response = await fetch(url, { cache: 'no-store' })
  if (response.status !== 200) return { status: response.status }
  const plane = lumaPlaneOfBgra(parseBgraBmp(Buffer.from(await response.arrayBuffer())))
  return { status: 200, plane }
}
