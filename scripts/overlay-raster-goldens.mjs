// Plan 260 S1.2 (plan 220's goldens script, ported from videorc-rust): the
// backend overlay rasteriser's goldens, from the renderer.
//
// Launches the dev app (isolated profile, the host smoke lock), asks the
// renderer for each case in `crates/videorc-backend/tests/fixtures/
// overlay-raster/cases.json` through the `eval-js` smoke command, which
// imports `renderer/src/lib/overlay-golden.ts` from the dev server (the
// production painter's own PNG), writes `<id>.png` beside it and records
// where they were made (`made`: macOS and Chrome versions; the fonts are the
// host's, so a golden only holds on the OS it came from). Each PNG is
// re-encoded losslessly (the same RGBA, refiltered and deflated at level 9)
// to keep the fixtures small. A case's `images` (URL → file under images/)
// go to the renderer as bytes; it never fetches.
//
//   node scripts/overlay-raster-goldens.mjs             every case
//   node scripts/overlay-raster-goldens.mjs <id> ...    only these cases
//
// `cargo test -p videorc-backend --bin videorc-backend overlay_raster` draws the same cases in Rust
// and compares.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'

const fixtureDir = join(
  repoRoot,
  'crates',
  'videorc-backend',
  'tests',
  'fixtures',
  'overlay-raster'
)
const casesPath = join(fixtureDir, 'cases.json')
const fixture = JSON.parse(readFileSync(casesPath, 'utf8'))
const only = new Set(process.argv.slice(2).filter((arg) => arg !== '--'))
const unknown = [...only].filter((id) => !fixture.cases.some((entry) => entry.id === id))
if (unknown.length > 0) throw new Error(`No such case: ${unknown.join(', ')}`)
// `keptFromVideorcRust` (see the fixture's note): remade only when named.
const kept = new Set(fixture.keptFromVideorcRust ?? [])
const cases = fixture.cases.filter((entry) =>
  only.size === 0 ? !kept.has(entry.id) : only.has(entry.id)
)

// The renderer's own painter for one case (`overlay-golden.ts`, served by the
// dev server only).
const RENDER_GOLDEN = `
const { renderOverlayGoldenPng } = await import('/src/lib/overlay-golden.ts')
return renderOverlayGoldenPng(params.request)
`

const stateDir = mkdtempSync(join(tmpdir(), 'videorc-overlay-goldens-'))
let launched = null
try {
  launched = await launchDevApp({
    timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000),
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    env: {
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_SMOKE_OUTPUT_DIR: stateDir
    },
    onLine: (line) => {
      if (line.startsWith('[smoke:')) console.log(`[app] ${line}`)
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  const userAgent = (
    await requestSmokeCommand(smoke, 'eval-js', { code: 'return navigator.userAgent' })
  ).result
  let total = 0
  for (const entry of cases) {
    const reply = (
      await requestSmokeCommand(
        smoke,
        'eval-js',
        { code: RENDER_GOLDEN, request: withImages(entry) },
        { timeoutMs: 30_000 }
      )
    ).result
    if (typeof reply?.pngBase64 !== 'string' || reply.pngBase64.length < 32) {
      throw new Error(`${entry.id}: the renderer sent no PNG (${JSON.stringify(reply)}).`)
    }
    const path = join(fixtureDir, `${entry.id}.png`)
    const bytes = smallestPng(Buffer.from(reply.pngBase64, 'base64'))
    writeFileSync(path, bytes)
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    total += bytes.length
    console.log(`${entry.id}: ${width}x${height}, ${bytes.length} bytes`)
  }
  fixture.made = {
    date: new Date().toISOString(),
    macos: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    userAgent,
    rendererCommit: execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
  }
  writeFileSync(casesPath, `${JSON.stringify(fixture, null, 2)}\n`)
  const all = fixture.cases.reduce((sum, entry) => {
    try {
      return sum + statSync(join(fixtureDir, `${entry.id}.png`)).size
    } catch {
      return sum
    }
  }, 0)
  console.log(`Wrote ${cases.length} goldens (${total} bytes); the set is ${all} bytes.`)
} finally {
  await launched?.stop().catch(() => {})
  rmSync(stateDir, { force: true, recursive: true })
}

/** The case's request with its image files as base64 bytes by URL. */
function withImages(entry) {
  if (!entry.images) return entry.request
  const images = Object.fromEntries(
    Object.entries(entry.images).map(([url, file]) => [
      url,
      readFileSync(join(fixtureDir, 'images', file)).toString('base64')
    ])
  )
  return { ...entry.request, images }
}

/** The same 8-bit RGBA PNG with each row's filter chosen by the smallest sum
 * of absolute residuals and the stream deflated at level 9; nothing but the
 * header and the pixels kept. */
function smallestPng(png) {
  const chunks = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    chunks.push({
      type: png.toString('latin1', at + 4, at + 8),
      data: png.subarray(at + 8, at + 8 + length)
    })
    at += 12 + length
  }
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  if (header[8] !== 8 || header[9] !== 6 || header[12] !== 0) {
    throw new Error('Expected a non-interlaced 8-bit RGBA PNG.')
  }
  const filtered = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  )
  const stride = width * 4
  const rows = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)]
    const row = Buffer.from(filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0
      const up = previous[x]
      const upLeft = x >= 4 ? previous[x - 4] : 0
      row[x] = (row[x] + predict(filter, left, up, upLeft)) & 0xff
    }
    rows.push(row)
    previous = row
  }
  const out = []
  previous = Buffer.alloc(stride)
  for (const row of rows) {
    let best = null
    for (let filter = 0; filter <= 4; filter += 1) {
      const line = Buffer.alloc(stride + 1)
      line[0] = filter
      let cost = 0
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? row[x - 4] : 0
        const value =
          (row[x] - predict(filter, left, previous[x], x >= 4 ? previous[x - 4] : 0)) & 0xff
        line[x + 1] = value
        cost += value < 128 ? value : 256 - value
      }
      if (!best || cost < best.cost) best = { cost, line }
    }
    out.push(best.line)
    previous = row
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(out), { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function predict(filter, left, up, upLeft) {
  switch (filter) {
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4: {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    default:
      return 0
  }
}
