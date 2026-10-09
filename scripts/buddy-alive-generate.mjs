#!/usr/bin/env node
// Plan 172 D1: makes the alive (animated) page-pet pack of one official
// Buddy with the creator's own pipeline, headless:
//
//   pnpm buddy:alive --slug golem --web ../videorc-web    # identity, pilot, the 8 sheets, build, review
//   pnpm buddy:alive --slug golem --until pilot           # stop after the pilot to look at it
//   pnpm buddy:alive --slug orc --sheets gaze-up2,extras  # redo those sheets as new versions
//   pnpm buddy:alive --slug orc --build-only              # build and review what is there
//   pnpm buddy:alive --slug orc --build-only --compare    # D3 side-by-side of the ship variants
//   pnpm buddy:alive --slug orc --build-only --ship q92   # write the shipped copy (lossless, q92, q92-512)
//
// 1. The reference: the official idle master (`golem-master.png` for Buddy
//    the Golem) trimmed onto a transparent 1024 px canvas, as the house-look
//    style anchor is made; the generated masters lose their faint haze first.
// 2. Identity notes: the web's identity request (Responses API, strict JSON
//    schema) to the vision model.
// 3. The pilot (2 x 2), then the eight sheets (five gaze strips, two reaction
//    sheets, the extras strip), each an image edit of the reference with the
//    web's exact prompt and size, several at once (the web allows parallel
//    sheets of one build).
// 4. The app's builder through `cargo run --example buddy_pack`, which also
//    loads the result with the app's pack loader.
// 5. Review: a contact sheet per gaze row and per reaction sheet with each
//    cell's intended pose, the gaze grid, the pilot, and an animated WebP.
//
// Sources stay outside the repo in ~/videorc-assets/buddy-alive/<slug>/
// (`sources/<sheet>-v<n>.png`, versioned, never overwritten; `accepted.json`
// pins an older version of a sheet); the pack's provenance.json records their
// SHA-256. Review files go to $VIDEORC_BUDDY_REVIEW_DIR (default
// <tmp>/videorc-buddy-alive-review). The key comes from AI_GATEWAY_API_KEY
// or ~/.config/videorc/ai-gateway-key and is never printed. Before any call
// the prompt copy is compared with the web module (--web <videorc-web> or
// VIDEORC_WEB_DIR). CI never runs this; the owner approves every row (D6).

import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCatalog } from './lib/buddy-official.mjs'
import {
  ATLAS_SHEET_KEYS,
  GAZE_ROWS,
  PET_PROMPT_VERSION,
  aliveBlock,
  alivePaths,
  buildSheetPrompt,
  checkWebPrompts,
  identityRequestBody,
  nextVersion,
  parseArgs,
  previewFrames,
  readIdentityOutput,
  referenceMaster,
  responsesOutputText,
  reviewCells,
  sheetRequestBody,
  sheetSpec,
  sourceVersions,
  usageCostUsd,
  versionedName
} from './lib/buddy-alive.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATEWAY = 'https://ai-gateway.vercel.sh/v1'
const IDENTITY_TIMEOUT_MS = 120_000
const SHEET_TIMEOUT_MS = 300_000
const LABEL_FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
const REVIEW_CELL = 400
/** On-stream check (D3): the character about 240 px tall, so the 0.65-occupancy cell is ~370 px. */
const ON_STREAM_CELL = 370

function readKey() {
  const fromEnv = process.env.AI_GATEWAY_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const file = join(homedir(), '.config/videorc/ai-gateway-key')
  if (!existsSync(file)) {
    throw new Error(
      'No AI Gateway key: set AI_GATEWAY_API_KEY or write ~/.config/videorc/ai-gateway-key.'
    )
  }
  return readFileSync(file, 'utf8').trim()
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const log = (slug, message) => console.log(`${slug}: ${message}`)
const magick = (args) => execFileSync('magick', args, { maxBuffer: 64 * 1024 * 1024 })

function checkWeb(options) {
  if (options.skipWebCheck) {
    console.warn(
      'buddy:alive: the prompt copy was NOT compared with videorc-web (--skip-web-check)'
    )
    return
  }
  const web = options.web ?? process.env.VIDEORC_WEB_DIR
  if (!web) {
    throw new Error(
      'Pass --web <videorc-web checkout> (or set VIDEORC_WEB_DIR) so the prompt copy is checked, or --skip-web-check.'
    )
  }
  const read = (name) => readFileSync(join(resolve(web), 'lib/ai', name), 'utf8')
  const { problems, owed } = checkWebPrompts({
    promptsSource: read('cohost-pet-prompts.ts'),
    lookSource: read('buddy-look.ts'),
    petSource: read('cohost-pet.ts')
  })
  for (const item of owed) console.warn(`buddy:alive: WEB MIRROR OWED: ${item}`)
  if (problems.length > 0) {
    throw new Error(
      `The prompt copy differs from ${web} (PET_PROMPT_VERSION ${PET_PROMPT_VERSION} here):\n  ${problems.join('\n  ')}`
    )
  }
}

async function gatewayJson(key, path, { body, timeoutMs = 60_000 } = {}) {
  const started = Date.now()
  const response = await fetch(`${GATEWAY}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  const ms = Date.now() - started
  if (!response.ok) {
    const error = new Error(`AI Gateway ${path} answered ${response.status}: ${text.slice(0, 300)}`)
    error.status = response.status
    error.ms = ms
    throw error
  }
  return {
    payload: JSON.parse(text),
    ms,
    requestId: response.headers.get('x-request-id'),
    headers: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => /cost|usage|credit|generation/i.test(name))
    )
  }
}

async function totalUsed(key) {
  try {
    const { payload } = await gatewayJson(key, 'credits')
    const value = Number(payload.total_used)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function modelPricing(key, ids) {
  const { payload } = await gatewayJson(key, 'models')
  const pricing = {}
  for (const id of ids) {
    const model = payload.data?.find((entry) => entry.id === id)
    if (!model) throw new Error(`The AI Gateway does not list ${id}.`)
    pricing[id] = model.pricing ?? null
  }
  return pricing
}

/** The reference every call edits: the official master, trimmed onto a 1024 px transparent canvas. */
function prepareReference(slug, paths) {
  const out = join(paths.sources, 'reference.png')
  if (existsSync(out)) return out
  const haze = slug === 'golem' ? [] : ['-channel', 'A', '-fx', 'u<0.06?0:u', '+channel']
  magick([
    join(repoRoot, referenceMaster(slug)),
    ...haze,
    '-background',
    'none',
    '-trim',
    '+repage',
    '-resize',
    '900x900',
    '-gravity',
    'center',
    '-extent',
    '1024x1024',
    `PNG32:${out}`
  ])
  return out
}

function pngInfo(bytes) {
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const colorType = bytes[25]
  return { width, height, hasAlphaChannel: colorType === 4 || colorType === 6 }
}

/** Share of pixels with alpha under 50 % (the web's transparentPixelShare). */
function alphaShare(path) {
  const out = magick([
    path,
    '-alpha',
    'extract',
    '-threshold',
    '50%',
    '-format',
    '%[fx:1-mean]',
    'info:'
  ])
  return Number(Number(out.toString().trim()).toFixed(4))
}

async function readIdentity({ slug, key, options, paths, referencePath, pricing }) {
  const referenceBytes = readFileSync(referencePath)
  const before = await totalUsed(key)
  const result = await gatewayJson(key, 'responses', {
    body: identityRequestBody({
      model: options.visionModel,
      referenceBase64: referenceBytes.toString('base64')
    }),
    timeoutMs: IDENTITY_TIMEOUT_MS
  })
  const after = await totalUsed(key)
  const text = responsesOutputText(result.payload)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const notes = readIdentityOutput(parsed)
  const record = {
    model: options.visionModel,
    responseModel: result.payload.model ?? null,
    status: result.payload.status ?? null,
    incomplete: result.payload.incomplete_details ?? null,
    notes,
    usage: result.payload.usage ?? null,
    costUsd: usageCostUsd(result.payload.usage, pricing[options.visionModel]),
    creditsDeltaUsd: before !== null && after !== null ? after - before : null,
    wallMs: result.ms,
    gatewayRequestId: result.requestId ?? result.payload.id ?? null,
    referenceSha256: sha256(referenceBytes),
    promptVersion: PET_PROMPT_VERSION,
    at: new Date().toISOString()
  }
  if (!notes) {
    writeFileSync(join(paths.root, 'identity-failed.json'), `${JSON.stringify(record, null, 2)}\n`)
    throw new Error(
      `${slug}: the vision model gave no usable identity notes (status ${record.status}, ${JSON.stringify(record.incomplete)}); see identity-failed.json`
    )
  }
  writeFileSync(paths.identity, `${JSON.stringify(record, null, 2)}\n`)
  log(slug, `identity notes in ${record.wallMs} ms: ${JSON.stringify(notes)}`)
  return record
}

async function generateSheet({
  slug,
  key,
  sheetKey,
  options,
  paths,
  referencePath,
  notes,
  pricing
}) {
  const { prompt, size } = buildSheetPrompt(sheetKey, notes)
  const body = sheetRequestBody({
    model: options.model,
    prompt,
    size,
    referenceBase64: readFileSync(referencePath).toString('base64')
  })
  let result = null
  for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
    try {
      result = await gatewayJson(key, 'images/edits', { body, timeoutMs: SHEET_TIMEOUT_MS })
    } catch (error) {
      const transient = error.status === undefined || error.status >= 500 || error.status === 429
      if (attempt === 1 && transient) {
        log(slug, `${sheetKey}: ${error.message.slice(0, 160)}; trying the call once more`)
        continue
      }
      throw error
    }
  }
  const b64 = result.payload?.data?.[0]?.b64_json
  if (!b64) throw new Error(`${slug}: ${sheetKey}: the AI Gateway returned no image.`)
  const png = Buffer.from(b64, 'base64')
  const version = nextVersion(readdirSync(paths.sources), sheetKey)
  const file = join(paths.sources, versionedName(sheetKey, version))
  writeFileSync(file, png, { flag: 'wx' })
  const info = pngInfo(png)
  const record = {
    sheet: sheetKey,
    version,
    file: versionedName(sheetKey, version),
    sha256: sha256(png),
    model: options.model,
    responseModel: result.payload.model ?? null,
    promptVersion: PET_PROMPT_VERSION,
    promptSha256: sha256(Buffer.from(prompt)),
    requestedSize: size,
    width: info.width,
    height: info.height,
    hasAlphaChannel: info.hasAlphaChannel,
    alphaShare: alphaShare(file),
    bytes: png.length,
    wallMs: result.ms,
    usage: result.payload.usage ?? null,
    costUsd: usageCostUsd(result.payload.usage, pricing[options.model]),
    costHeaders: result.headers,
    gatewayRequestId: result.requestId ?? result.payload.id ?? null,
    at: new Date().toISOString()
  }
  appendFileSync(paths.generations, `${JSON.stringify(record)}\n`)
  log(
    slug,
    `${sheetKey} v${version}: ${info.width}x${info.height}, alpha share ${record.alphaShare}, ${record.wallMs} ms, ${record.costUsd === null ? 'cost n/a' : `$${record.costUsd.toFixed(3)}`}`
  )
  return record
}

async function pool(items, limit, run) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function runExample(args) {
  const result = spawnSync(
    'cargo',
    ['run', '-q', '-p', 'videorc-backend', '--example', 'buddy_pack', '--', ...args, '--json'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  const line = result.stdout.trim().split('\n').pop()
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(
      `buddy_pack gave no verdict (exit ${result.status}):\n${result.stderr.slice(-2000)}`
    )
  }
}

function buildPack({ slug, entry, paths, cellSize = 640, out = paths.pack }) {
  const verdict = runExample([
    paths.sources,
    out,
    '--name',
    entry.name,
    '--cell-size',
    String(cellSize),
    '--created-at',
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  ])
  const record = out === paths.pack ? 'build.json' : `build-${cellSize}.json`
  writeFileSync(join(paths.root, record), `${JSON.stringify(verdict, null, 2)}\n`)
  if (verdict.ok) {
    const atlas = verdict.files.find((file) => file.name === 'mascot.webp')
    log(
      slug,
      `built ${verdict.frames} frames at ${verdict.cellSize} px, atlas ${verdict.atlasSize.join('x')}, mascot.webp ${(atlas.bytes / 1e6).toFixed(2)} MB; loader ok`
    )
  } else {
    log(
      slug,
      `BUILD REFUSED [${verdict.error?.code}] ${verdict.error?.message ?? JSON.stringify(verdict.loader)}`
    )
  }
  return verdict
}

// --- Review ------------------------------------------------------------------------------

function frameRects(packDir) {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))
  return new Map(manifest.frames.map((frame) => [frame.id, frame.rect]))
}

function decodeAtlas(packDir, workDir, name = 'atlas.png') {
  const out = join(workDir, name)
  execFileSync('dwebp', ['-quiet', join(packDir, 'mascot.webp'), '-o', out])
  return out
}

/** magick arguments for one labelled cell on a checkerboard (leaves one image on the stack). */
function cellArgs(
  atlasPng,
  rect,
  label,
  size = REVIEW_CELL,
  background = 'checker',
  pointsize = 17
) {
  const [x, y, w, h] = rect
  const back =
    background === 'checker'
      ? ['-size', `${size}x${size}`, 'pattern:checkerboard', '-fill', '#d8d8d8', '-colorize', '35%']
      : ['-size', `${size}x${size}`, `xc:${background}`]
  return [
    '(',
    ...back,
    '(',
    atlasPng,
    '+gravity',
    '-crop',
    `${w}x${h}+${x}+${y}`,
    '+repage',
    '-filter',
    'Lanczos',
    '-resize',
    `${size}x${size}`,
    ')',
    '-compose',
    'over',
    '-composite',
    ...(label === null
      ? []
      : [
          '(',
          '-background',
          '#16181c',
          '-fill',
          '#f2f2f2',
          '-font',
          LABEL_FONT,
          '-pointsize',
          String(pointsize),
          '-size',
          `${size}x34`,
          '-gravity',
          'center',
          `label:${label}`,
          ')',
          '-append'
        ]),
    ')'
  ]
}

function titleArgs(text, width) {
  return [
    '(',
    '-background',
    '#0d0e10',
    '-fill',
    '#ffffff',
    '-font',
    LABEL_FONT,
    '-pointsize',
    '20',
    '-size',
    `${width}x40`,
    '-gravity',
    'west',
    `label:  ${text}`,
    ')'
  ]
}

function contactSheet({ atlasPng, rects, key, title, out, sourcePath }) {
  const spec = sheetSpec(key)
  const cells = reviewCells(key)
  const rows = []
  for (let row = 0; row < spec.rows; row += 1) {
    const rowCells = cells.slice(row * spec.columns, (row + 1) * spec.columns)
    rows.push([
      '(',
      ...rowCells.flatMap((cell) =>
        cellArgs(atlasPng, rects.get(cell.id), `${cell.id}  ${cell.label}`)
      ),
      '+append',
      ')'
    ])
  }
  const width = REVIEW_CELL * spec.columns
  const source = sourcePath
    ? [
        '(',
        '(',
        '-size',
        `${width}x${REVIEW_CELL}`,
        'pattern:checkerboard',
        '-fill',
        '#d8d8d8',
        '-colorize',
        '35%',
        ')',
        '(',
        sourcePath,
        '-resize',
        `${width}x${REVIEW_CELL}`,
        ')',
        '-gravity',
        'center',
        '-compose',
        'over',
        '-composite',
        ')'
      ]
    : []
  magick([
    ...titleArgs(title, width),
    ...rows.flat(),
    ...(sourcePath ? titleArgs('the generated sheet as it came back', width) : []),
    ...source,
    '-background',
    '#0d0e10',
    '-append',
    '-depth',
    '8',
    out
  ])
}

function gazeGrid({ atlasPng, rects, title, out }) {
  const size = 240
  const rows = GAZE_ROWS.map((row) => [
    '(',
    ...reviewCells(`gaze-${row}`).flatMap((cell) =>
      cellArgs(atlasPng, rects.get(cell.id), cell.label, size, 'checker', 13)
    ),
    '+append',
    ')'
  ])
  magick([
    ...titleArgs(title, size * 5),
    ...rows.flat(),
    '-background',
    '#0d0e10',
    '-append',
    '-depth',
    '8',
    out
  ])
}

/**
 * The 25 heads at full atlas resolution (the upper middle of each cell, where
 * the neutral's head sits): the turn and the pitch are judged here.
 */
function gazeHeads({ atlasPng, rects, title, out }) {
  const tile = (rect, label) => {
    const [x, y, w, h] = rect
    const crop = [Math.round(w * 0.6), Math.round(h * 0.36)]
    const at = [x + Math.round(w * 0.2), y + Math.round(h * 0.2)]
    return [
      '(',
      '(',
      '-size',
      `${crop[0]}x${crop[1]}`,
      'xc:#8a8d93',
      '(',
      atlasPng,
      '+gravity',
      '-crop',
      `${crop[0]}x${crop[1]}+${at[0]}+${at[1]}`,
      '+repage',
      ')',
      '-compose',
      'over',
      '-composite',
      ')',
      '(',
      '-background',
      '#16181c',
      '-fill',
      '#f2f2f2',
      '-font',
      LABEL_FONT,
      '-pointsize',
      '16',
      '-size',
      `${crop[0]}x28`,
      '-gravity',
      'center',
      `label:${label}`,
      ')',
      '-append',
      ')'
    ]
  }
  const width = Math.round([...rects.values()][0][2] * 0.6) * 5
  const rows = GAZE_ROWS.map((row) => [
    '(',
    ...reviewCells(`gaze-${row}`).flatMap((cell) => tile(rects.get(cell.id), cell.label)),
    '+append',
    ')'
  ])
  magick([
    ...titleArgs(title, width),
    ...rows.flat(),
    '-background',
    '#0d0e10',
    '-append',
    '-depth',
    '8',
    out
  ])
}

function pilotSheet({ pilotPath, title, out }) {
  const width = 900
  magick([
    ...titleArgs(title, width),
    '(',
    '(',
    '-size',
    `${width}x${width}`,
    'pattern:checkerboard',
    '-fill',
    '#d8d8d8',
    '-colorize',
    '35%',
    ')',
    '(',
    pilotPath,
    '-resize',
    `${width}x${width}`,
    ')',
    '-gravity',
    'center',
    '-compose',
    'over',
    '-composite',
    ')',
    '-background',
    '#0d0e10',
    '-append',
    '-depth',
    '8',
    out
  ])
}

function animatedPreview({ atlasPng, rects, out, workDir }) {
  const frames = previewFrames()
  const files = new Map()
  for (const [id] of frames) {
    if (files.has(id)) continue
    const file = join(workDir, `frame-${id}.png`)
    magick([...cellArgs(atlasPng, rects.get(id), null, REVIEW_CELL, '#2b2d31'), file])
    files.set(id, file)
  }
  execFileSync('img2webp', [
    '-loop',
    '0',
    '-lossy',
    '-q',
    '80',
    ...frames.flatMap(([id, ms]) => ['-d', String(ms), files.get(id)]),
    '-o',
    out
  ])
}

function writeReview({ slug, entry, paths, verdict }) {
  mkdirSync(paths.review, { recursive: true })
  const workDir = mkdtempSync(join(tmpdir(), 'buddy-alive-review-'))
  try {
    const versions = sourceVersions(readdirSync(paths.sources))
    const used = new Map((verdict.sources ?? []).map((source) => [source.key, source.file]))
    const pilot = used.get('pilot')
    if (pilot) {
      pilotSheet({
        pilotPath: join(paths.sources, pilot),
        title: `${entry.name} · pilot (${pilot}) · neutral | left | right / laugh`,
        out: join(paths.review, pilot)
      })
    }
    if (!verdict.ok) return []
    const atlasPng = decodeAtlas(paths.pack, workDir)
    const rects = frameRects(paths.pack)
    const written = []
    for (const key of ATLAS_SHEET_KEYS) {
      const file = used.get(key)
      const out = join(paths.review, `${key}.png`)
      contactSheet({
        atlasPng,
        rects,
        key,
        title: `${entry.name} · ${key} · ${file} (versions ${versions[key]?.join(', ')}) · builder ok`,
        out,
        sourcePath: join(paths.sources, file)
      })
      written.push(out)
    }
    const grid = join(paths.review, 'gaze-grid.png')
    gazeGrid({
      atlasPng,
      rects,
      title: `${entry.name} · the 25 gaze cells (viewer's left is ←)`,
      out: grid
    })
    const heads = join(paths.review, 'gaze-heads.png')
    gazeHeads({
      atlasPng,
      rects,
      title: `${entry.name} · the 25 heads at atlas resolution: does each one look where its label says?`,
      out: heads
    })
    const preview = join(paths.review, 'preview.webp')
    animatedPreview({ atlasPng, rects, out: preview, workDir })
    log(slug, `review in ${paths.review}`)
    return [...written, grid, heads, preview]
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// --- Ship variants (D3) ----------------------------------------------------------------------

function lossyAtlas(fromPack, toPack) {
  mkdirSync(toPack, { recursive: true })
  for (const name of ['manifest.json', 'buddy.json', 'build-report.json', 'provenance.json']) {
    copyFileSync(join(fromPack, name), join(toPack, name))
  }
  const workDir = mkdtempSync(join(tmpdir(), 'buddy-alive-lossy-'))
  try {
    const png = decodeAtlas(fromPack, workDir)
    execFileSync('cwebp', [
      '-quiet',
      '-q',
      '92',
      '-m',
      '6',
      '-alpha_q',
      '100',
      '-alpha_filter',
      'best',
      png,
      '-o',
      join(toPack, 'mascot.webp')
    ])
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function variantDir({ variant, paths, entry, slug }) {
  if (variant === 'lossless') return paths.pack
  const dir = join(paths.root, `variant-${variant}`)
  rmSync(dir, { recursive: true, force: true })
  if (variant === 'q92') {
    lossyAtlas(paths.pack, dir)
  } else {
    rmSync(paths.pack512, { recursive: true, force: true })
    const verdict = buildPack({ slug, entry, paths, cellSize: 512, out: paths.pack512 })
    if (!verdict.ok) throw new Error(`${slug}: the 512 px build was refused`)
    lossyAtlas(paths.pack512, dir)
  }
  const verified = runExample(['--verify', dir])
  if (!verified.ok)
    throw new Error(
      `${slug}: the ${variant} copy does not load: ${JSON.stringify(verified.loader)}`
    )
  return dir
}

function compareVariants({ slug, entry, paths }) {
  const ids = ['gaze-2-2', 'gaze-0-2', 'gaze-4-0', 'laugh', 'excited', 'talk-a']
  const workDir = mkdtempSync(join(tmpdir(), 'buddy-alive-compare-'))
  try {
    const rows = []
    const sizes = []
    for (const variant of ['lossless', 'q92', 'q92-512']) {
      const dir = variantDir({ variant, paths, entry, slug })
      const bytes = statSync(join(dir, 'mascot.webp')).size
      sizes.push({ variant, bytes })
      const atlasPng = decodeAtlas(dir, workDir, `atlas-${variant}.png`)
      const rects = frameRects(dir)
      const cells = ids.flatMap((id, index) =>
        cellArgs(
          atlasPng,
          rects.get(id),
          index === 0 ? `${variant} ${(bytes / 1e6).toFixed(2)} MB` : id,
          ON_STREAM_CELL,
          index % 2 ? '#2b2d31' : '#e9e6df'
        )
      )
      // The face of the neutral at 2x of its on-stream size, where colour loss shows first.
      const rect = rects.get('gaze-2-2')
      const face = [
        '(',
        atlasPng,
        '+gravity',
        '-crop',
        `${Math.round(rect[2] * 0.5)}x${Math.round(rect[3] * 0.4)}+${rect[0] + Math.round(rect[2] * 0.25)}+${rect[1] + Math.round(rect[3] * 0.18)}`,
        '+repage',
        '-resize',
        `${Math.round(ON_STREAM_CELL * 1.0)}x`,
        '-background',
        '#2b2d31',
        '-flatten',
        '-gravity',
        'center',
        '-extent',
        `${ON_STREAM_CELL}x${ON_STREAM_CELL + 34}`,
        ')'
      ]
      rows.push(['(', ...cells, ...face, '+append', ')'])
    }
    const out = join(paths.review, 'size-compare.png')
    magick([
      ...titleArgs(
        `${entry.name} · D3: lossless 640 / lossy q92 640 / lossy q92 512, at on-stream size (character ~240 px); last column: the face at 2x`,
        ON_STREAM_CELL * 7
      ),
      ...rows.flat(),
      '-background',
      '#0d0e10',
      '-append',
      '-depth',
      '8',
      out
    ])
    writeFileSync(join(paths.review, 'size-compare.json'), `${JSON.stringify(sizes, null, 2)}\n`)
    log(
      slug,
      `sizes: ${sizes.map((size) => `${size.variant} ${(size.bytes / 1e6).toFixed(2)} MB`).join(', ')}; ${out}`
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function writeShip({ slug, entry, paths, variant, verdict }) {
  const from = variantDir({ variant, paths, entry, slug })
  rmSync(paths.ship, { recursive: true, force: true })
  mkdirSync(paths.ship, { recursive: true })
  for (const name of [
    'manifest.json',
    'mascot.webp',
    'buddy.json',
    'build-report.json',
    'provenance.json'
  ]) {
    copyFileSync(join(from, name), join(paths.ship, name))
  }
  const verified = runExample(['--verify', paths.ship])
  if (!verified.ok) throw new Error(`${slug}: the shipped copy does not load`)
  const block = aliveBlock({
    slug,
    cellSize: verified.loader.cellSize,
    frames: verified.loader.frames,
    files: verified.files
  })
  writeFileSync(
    join(paths.ship, 'ship.json'),
    `${JSON.stringify({ variant, alive: block, builtFrom: verdict.sources }, null, 2)}\n`
  )
  log(slug, `shipped copy (${variant}) in ${paths.ship}: ${JSON.stringify(block.files)}`)
}

// --- Main ------------------------------------------------------------------------------------

async function main() {
  const catalog = readCatalog(repoRoot)
  const options = parseArgs(process.argv.slice(2), catalog)
  const slug = options.slug
  const entry = catalog.find((candidate) => candidate.slug === slug)
  const paths = alivePaths({
    slug,
    home: homedir(),
    reviewRoot: process.env.VIDEORC_BUDDY_REVIEW_DIR ?? join(tmpdir(), 'videorc-buddy-alive-review')
  })
  mkdirSync(paths.sources, { recursive: true })

  if (!options.buildOnly) {
    checkWeb(options)
    const key = readKey()
    const pricing = await modelPricing(key, [options.model, options.visionModel])
    const referencePath = prepareReference(slug, paths)
    log(slug, `reference ${referencePath} (${sha256(readFileSync(referencePath)).slice(0, 12)})`)

    let identity = existsSync(paths.identity)
      ? JSON.parse(readFileSync(paths.identity, 'utf8'))
      : null
    if (!identity || options.identity) {
      identity = await readIdentity({ slug, key, options, paths, referencePath, pricing })
    }
    if (options.until === 'identity') return

    const present = sourceVersions(readdirSync(paths.sources))
    let wanted
    if (options.sheets) {
      wanted = options.sheets
    } else {
      wanted = present.pilot ? [] : ['pilot']
      if (options.until !== 'pilot') {
        wanted.push(...ATLAS_SHEET_KEYS.filter((sheetKey) => !present[sheetKey]))
      }
    }
    const pilotFirst = wanted.includes('pilot') && !present.pilot
    const generate = (sheetKey) =>
      generateSheet({
        slug,
        key,
        sheetKey,
        options,
        paths,
        referencePath,
        notes: identity.notes,
        pricing
      })
    const failures = []
    const before = await totalUsed(key)
    const started = Date.now()
    if (pilotFirst) {
      const [pilot] = await pool(['pilot'], 1, generate)
      if (pilot.status === 'rejected') failures.push(['pilot', pilot.reason])
      wanted = wanted.filter((sheetKey) => sheetKey !== 'pilot')
    }
    if (options.until !== 'pilot' || options.sheets) {
      const results = await pool(wanted, options.concurrency, generate)
      results.forEach((result, index) => {
        if (result.status === 'rejected') failures.push([wanted[index], result.reason])
      })
    }
    const after = await totalUsed(key)
    if (before !== null && after !== null) {
      log(
        slug,
        `this run: ${((Date.now() - started) / 1000).toFixed(0)} s, credits used $${(after - before).toFixed(3)}`
      )
    }
    for (const [sheetKey, reason] of failures) {
      console.error(`${slug}: ${sheetKey} FAILED: ${reason?.message ?? reason}`)
      process.exitCode = 1
    }
    if (options.until === 'pilot') {
      const pilot = sourceVersions(readdirSync(paths.sources)).pilot
      if (pilot) {
        mkdirSync(paths.review, { recursive: true })
        const file = versionedName('pilot', pilot[pilot.length - 1])
        pilotSheet({
          pilotPath: join(paths.sources, file),
          title: `${entry.name} · pilot (${file}) · neutral | left | right / laugh`,
          out: join(paths.review, file)
        })
        log(slug, `pilot review in ${join(paths.review, file)}`)
      }
      return
    }
    if (options.until === 'sheets') return
  }

  const present = sourceVersions(readdirSync(paths.sources))
  const missing = ATLAS_SHEET_KEYS.filter((sheetKey) => !present[sheetKey])
  if (missing.length > 0) {
    throw new Error(`${slug}: cannot build yet, missing ${missing.join(', ')}`)
  }
  const verdict = buildPack({ slug, entry, paths })
  writeReview({ slug, entry, paths, verdict })
  if (!verdict.ok) {
    process.exitCode = 1
    return
  }
  if (options.compare) compareVariants({ slug, entry, paths })
  if (options.ship) writeShip({ slug, entry, paths, variant: options.ship, verdict })
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
