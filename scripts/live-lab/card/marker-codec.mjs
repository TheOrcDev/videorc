// Plan 178 U7. The marker encoding shared by the test card (browser, draws
// the markers) and the frame decoder (Node, `lib/card-markers.mjs`). One
// module, so the card and the decoder can never disagree on a bit.
//
// No DOM, no Node APIs: the card imports this file as a plain ES module.

/**
 * A code region is one row of square cells:
 *   guard 1 | data bits, most significant first | even parity | guard 0
 * The guards prove the row is aligned (a white cell first, a black cell
 * last); the parity bit catches a single flipped cell.
 */
export function encodeCode(value, dataBits) {
  const limit = 2 ** dataBits
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new RangeError(`code value ${value} must be an integer in 0..${limit - 1}`)
  }
  const data = []
  for (let bit = dataBits - 1; bit >= 0; bit -= 1) data.push((value >> bit) & 1)
  const parity = data.reduce((sum, bit) => sum + bit, 0) % 2
  return [1, ...data, parity, 0]
}

/** Inverse of encodeCode. Returns { value } or { error }. */
export function decodeCode(bits, dataBits) {
  if (!Array.isArray(bits) || bits.length !== dataBits + 3) {
    return { error: `expected ${dataBits + 3} cells, got ${bits?.length ?? 0}` }
  }
  if (bits[0] !== 1 || bits[bits.length - 1] !== 0) return { error: 'guard cells do not match' }
  const data = bits.slice(1, 1 + dataBits)
  const parity = data.reduce((sum, bit) => sum + bit, 0) % 2
  if (parity !== bits[1 + dataBits]) return { error: 'parity check failed' }
  return { value: data.reduce((value, bit) => value * 2 + bit, 0) }
}

/** Step numbers wrap so any step index fits the code. */
export function stepCodeValue(spec, stepIndex) {
  const limit = 2 ** spec.codes.step.dataBits
  const index = Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : 0
  return index % limit
}

export function sceneCodeValue(spec, sceneId) {
  const limit = 2 ** spec.codes.scene.dataBits
  return Number.isInteger(sceneId) && sceneId >= 0 && sceneId < limit ? sceneId : 0
}

/** Normalized rect [x, y, w, h] to integer pixel edges inside a card rect. */
export function pixelRect(rect, card) {
  const [nx, ny, nw, nh] = rect
  const left = card.x + Math.round(nx * card.width)
  const top = card.y + Math.round(ny * card.height)
  const right = card.x + Math.round((nx + nw) * card.width)
  const bottom = card.y + Math.round((ny + nh) * card.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Cell `col,row` of a grid laid over a pixel rect, with integer edges. */
export function cellRect(region, columns, rows, col, row) {
  const left = region.x + Math.round((col * region.width) / columns)
  const right = region.x + Math.round(((col + 1) * region.width) / columns)
  const top = region.y + Math.round((row * region.height) / rows)
  const bottom = region.y + Math.round(((row + 1) * region.height) / rows)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function parseBits(text) {
  return [...text].map((char) => (char === '1' ? 1 : 0))
}

/**
 * Every marker region as a list of named grids with expected bits. Both the
 * card (to draw) and the decoder (to compare) walk this list.
 */
export function markerRegions(spec, { sceneId = 0, stepIndex = 0 } = {}) {
  const regions = []
  for (const [name, fiducial] of Object.entries(spec.fiducials)) {
    regions.push({
      name: `fiducial.${name}`,
      rect: fiducial.rect,
      columns: fiducial.grid[0],
      rows: fiducial.grid[1],
      bits: parseBits(fiducial.bits)
    })
  }
  regions.push({
    name: 'scene',
    rect: spec.codes.scene.rect,
    columns: spec.codes.scene.dataBits + 3,
    rows: 1,
    bits: encodeCode(sceneCodeValue(spec, sceneId), spec.codes.scene.dataBits)
  })
  regions.push({
    name: 'step',
    rect: spec.codes.step.rect,
    columns: spec.codes.step.dataBits + 3,
    rows: 1,
    bits: encodeCode(stepCodeValue(spec, stepIndex), spec.codes.step.dataBits)
  })
  return regions
}

/**
 * The exact rectangles to paint, in pixels: a black plate (quiet zone) around
 * each region, then one rect per cell. Integer edges only, so the browser and
 * the synthetic test renderer paint identical pixels.
 */
export function markerPaintList(spec, card, state = {}) {
  const paint = []
  const black = spec.colors.zero
  const white = spec.colors.one
  for (const region of markerRegions(spec, state)) {
    const box = pixelRect(region.rect, card)
    const cellWidth = box.width / region.columns
    const pad = Math.max(2, Math.round(cellWidth * spec.quietZone))
    paint.push({
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
      color: black
    })
    for (let row = 0; row < region.rows; row += 1) {
      for (let col = 0; col < region.columns; col += 1) {
        const bit = region.bits[row * region.columns + col]
        if (bit !== 1) continue
        paint.push({ ...cellRect(box, region.columns, region.rows, col, row), color: white })
      }
    }
  }
  return paint
}
