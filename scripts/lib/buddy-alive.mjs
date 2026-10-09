// Plan 172 D1: the pure parts of `pnpm buddy:alive`, which makes the alive
// (animated) page-pet packs of Videorc's official Buddies with the creator's
// own pipeline: identity notes from the official idle, a pilot, then the
// eight sheets as image edits of that neutral, then the app's builder.
//
// The prompt words are a copy of videorc-web `lib/ai/cohost-pet-prompts.ts`
// (PET_PROMPT_VERSION below) and the identity request of
// `lib/ai/cohost-pet-identity-route.ts`, so an official pack is drawn exactly
// the way a streamer's own creation is. `checkWebPrompts` compares this copy
// with the web source before any generation; change both together and bump
// the version on both sides for any wording change.

import { join } from 'node:path'
import { BUDDY_HOUSE_STYLE } from './buddy-official.mjs'

export const PET_PROMPT_VERSION = 2
export const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-2.5-sunburst'
/** What videorc-web docs/ai-gateway.md names for VIDEORC_AI_PET_VISION_MODEL. */
export const DEFAULT_VISION_MODEL = 'openai/gpt-5.5'
export const STRIP_IMAGE_SIZE = '1536x1024'
export const PILOT_IMAGE_SIZE = '1024x1024'
export const MAX_PET_NOTE_ITEMS = 8
export const MAX_PET_NOTE_ITEM_CHARS = 60
export const MAX_PET_PROPORTIONS_CHARS = 400
export const MAX_PET_ASYMMETRIC_ITEMS = 12
export const MAX_PET_FEATURE_CHARS = 80

export const GAZE_ROWS = ['up2', 'up1', 'level', 'down1', 'down2']
export const PET_PILOT_CELLS = ['neutral', 'left', 'right', 'laugh']
export const PET_GAZE_CELLS = [
  'left-profile',
  'left-three-quarter',
  'front',
  'right-three-quarter',
  'right-profile'
]
export const PET_REACTIONS_A_CELLS = ['laugh', 'surprised', 'wink', 'kiss', 'blink', 'sleep']
export const PET_REACTIONS_B_CELLS = ['worried', 'annoyed', 'proud', 'confused', 'excited', 'calm']
export const PET_EXTRAS_CELLS = ['talk-a', 'talk-b', 'wave']

export const PET_SHEET_LAYOUTS = {
  extras: { cells: PET_EXTRAS_CELLS, columns: 3, rows: 1, size: STRIP_IMAGE_SIZE },
  gaze: { cells: PET_GAZE_CELLS, columns: 5, rows: 1, size: STRIP_IMAGE_SIZE },
  pilot: { cells: PET_PILOT_CELLS, columns: 2, rows: 2, size: PILOT_IMAGE_SIZE },
  'reactions-a': { cells: PET_REACTIONS_A_CELLS, columns: 3, rows: 2, size: STRIP_IMAGE_SIZE },
  'reactions-b': { cells: PET_REACTIONS_B_CELLS, columns: 3, rows: 2, size: STRIP_IMAGE_SIZE }
}

/** The sheets of one pack in atlas order (the builder's keys), the pilot first. */
export const SHEETS = [
  { key: 'pilot', kind: 'pilot' },
  ...GAZE_ROWS.map((row) => ({ key: `gaze-${row}`, kind: 'gaze', row })),
  { key: 'reactions-a', kind: 'reactions-a' },
  { key: 'reactions-b', kind: 'reactions-b' },
  { key: 'extras', kind: 'extras' }
]
export const ATLAS_SHEET_KEYS = SHEETS.filter((sheet) => sheet.kind !== 'pilot').map(
  (sheet) => sheet.key
)

export function sheetSpec(key) {
  const sheet = SHEETS.find((candidate) => candidate.key === key)
  if (!sheet) throw new Error(`Unknown sheet: ${key}`)
  return { ...sheet, ...PET_SHEET_LAYOUTS[sheet.kind] }
}

// ---------------------------------------------------------------------------
// Templates. Each string below is byte-for-byte a string or template literal
// of the web module, `${...}` placeholders included, so `checkWebPrompts` can
// find it there; `fill` substitutes the placeholders the way the web's
// template literals do.

/** Replace every `${expression}` of `template` with `values[expression]`. */
export function fill(template, values) {
  return template.replace(/\$\{([^}]+)\}/g, (match, expression) => {
    if (!(expression in values)) throw new Error(`No value for \${${expression}}`)
    return String(values[expression])
  })
}

export const PET_IDENTITY_SCHEMA_NAME = 'videorc_pet_identity_notes'
export const PET_IDENTITY_MAX_OUTPUT_TOKENS = 600

export const PET_IDENTITY_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    asymmetric: {
      items: {
        additionalProperties: false,
        properties: {
          feature: { type: 'string' },
          side: { enum: ['left', 'right'], type: 'string' }
        },
        required: ['feature', 'side'],
        type: 'object'
      },
      type: 'array'
    },
    materials: { items: { type: 'string' }, type: 'array' },
    palette: { items: { type: 'string' }, type: 'array' },
    proportions: { type: 'string' }
  },
  required: ['palette', 'materials', 'proportions', 'asymmetric'],
  type: 'object'
}

const IDENTITY_INSTRUCTION_TEMPLATES = [
  "You write the identity notes for one illustrated character that will be redrawn in many poses for an animated sprite sheet. The image is the character's locked neutral reference, usually front-facing.",
  'Return only JSON matching the schema.',
  'palette: the character\'s main colours as short plain names (for example "moss green", "warm grey stone", "amber"), most prominent first, at most ${MAX_PET_NOTE_ITEMS}. Ignore the background.',
  'materials: what its surfaces are made of (stone, moss, fur, cloth, metal, glass, skin, scales, ...), at most ${MAX_PET_NOTE_ITEMS}.',
  'proportions: one or two plain sentences on body proportions and stance: head size against the body, limb length, overall shape, how it stands or sits, where its feet or base meet the ground. At most ${MAX_PET_PROPORTIONS_CHARS} characters.',
  "asymmetric: every feature that differs between the character's two sides, each with its ANATOMICAL side, meaning the character's own left or right, never the viewer's. In a front-facing reference the character's right side is on the viewer's left and its left side is on the viewer's right. Examples: a single fang, one larger eye, a crack, a patch, a held prop, a cape fastened on one shoulder, differently coloured feet. Leave the list empty when the design is symmetric. At most ${MAX_PET_ASYMMETRIC_ITEMS}.",
  'Describe only what is visible. No background, no text, no speculation about personality.'
]

const LIMITS = {
  MAX_PET_ASYMMETRIC_ITEMS,
  MAX_PET_NOTE_ITEMS,
  MAX_PET_PROPORTIONS_CHARS
}

export const PET_IDENTITY_INSTRUCTIONS = IDENTITY_INSTRUCTION_TEMPLATES.map((template) =>
  fill(template, LIMITS)
).join(' ')

export const PET_IDENTITY_INPUT = 'Write the identity notes for the character in this image.'

/** The Responses API body the web's identity route sends (AiGatewayClient.generateStructuredJson). */
export function identityRequestBody({ model, referenceBase64 }) {
  return {
    input: [
      {
        content: [
          { text: PET_IDENTITY_INPUT, type: 'input_text' },
          { image_url: `data:image/png;base64,${referenceBase64}`, type: 'input_image' }
        ],
        role: 'user'
      }
    ],
    instructions: PET_IDENTITY_INSTRUCTIONS,
    max_output_tokens: PET_IDENTITY_MAX_OUTPUT_TOKENS,
    model,
    text: {
      format: {
        name: PET_IDENTITY_SCHEMA_NAME,
        schema: PET_IDENTITY_JSON_SCHEMA,
        strict: true,
        type: 'json_schema'
      }
    }
  }
}

/** The answer text of a Responses API payload (the web's responsesApiOutputText). */
export function responsesOutputText(payload) {
  if (!payload) return ''
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text
  }
  if (!Array.isArray(payload.output)) return ''
  const parts = []
  for (const item of payload.output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }
  return parts.join('')
}

function normalizeItems(items, maxChars) {
  const seen = new Set()
  const result = []
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item !== 'string') continue
    const trimmed = item.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
    if (result.length === MAX_PET_NOTE_ITEMS) break
  }
  return result
}

/**
 * The web's readCohostPetIdentityOutput: trimmed, de-duplicated, capped,
 * sides lower-cased, anything not left/right dropped. Null when unusable.
 */
export function readIdentityOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  const asymmetric = []
  const seenFeatures = new Set()
  for (const item of Array.isArray(output.asymmetric) ? output.asymmetric : []) {
    if (!item || typeof item.feature !== 'string' || typeof item.side !== 'string') continue
    const feature = item.feature.replace(/\s+/g, ' ').trim().slice(0, MAX_PET_FEATURE_CHARS).trim()
    const side = item.side.trim().toLowerCase()
    const key = feature.toLowerCase()
    if (!feature || seenFeatures.has(key)) continue
    if (side !== 'left' && side !== 'right') continue
    seenFeatures.add(key)
    asymmetric.push({ feature, side })
    if (asymmetric.length === MAX_PET_ASYMMETRIC_ITEMS) break
  }
  const proportions =
    typeof output.proportions === 'string'
      ? output.proportions.replace(/\s+/g, ' ').trim().slice(0, MAX_PET_PROPORTIONS_CHARS).trim()
      : ''
  if (!proportions) return null
  return {
    asymmetric,
    materials: normalizeItems(output.materials, MAX_PET_NOTE_ITEM_CHARS),
    palette: normalizeItems(output.palette, MAX_PET_NOTE_ITEM_CHARS),
    proportions
  }
}

// ---------------------------------------------------------------------------
// Sheet prompts.

const T = {
  palette: 'Palette: ${list(notes.palette)}.',
  materials: 'Materials: ${list(notes.materials)}.',
  proportions: 'Proportions: ${notes.proportions.replace(/\\.?$/, ".")}',
  asymmetricItem: "${item.feature} on the character's own ${item.side.toUpperCase()} side",
  asymmetric:
    "Asymmetric features, by the character's own anatomical side: ${features}. In the front view the character's left side is on the viewer's right. When the character faces the viewer's left, its own left side is nearest the camera and those features are in front; when it faces the viewer's right, its own right side is nearest. A feature never swaps sides, never duplicates and never changes hands; it hides behind the correct surface and returns on the same side.",
  symmetric:
    'The design is symmetric: both sides match in every view, and nothing appears on one side only.',
  identityLock:
    'Use the character in the provided image exactly as it is: the same creature, the same colours, the same materials, the same outfit and props, the same art style, line weight and shading. The art style is the house look, exactly as rendered in the provided image: ${BUDDY_HOUSE_STYLE}.',
  wholeCharacter:
    'Draw the whole character in every cell, head to feet, nothing cropped and nothing cut by the edge of the image.',
  sameScale:
    'Keep the same scale and apparent height, the same palette, materials and lighting in every cell, and keep the feet (or base) on one shared ground line at the same height all the way across the sheet; nothing floats and nothing sinks.',
  background:
    'Fully transparent background (PNG alpha): nothing behind or under the characters, no scenery, no floor, no shadows, no panels, no boxes, no grid lines, no borders, no colour fill.',
  noText:
    'No text, no letters, no numbers, no labels, no symbols, no watermark, no logo, no speech bubble.',
  turns:
    'Each direction is a real turn of the whole head and body that changes the silhouette and which features are visible, never a shift of the pupils alone. In three-quarter views the two eyes keep their anatomical order and the far eye becomes smaller or hidden as the turn increases; a nose or muzzle projects toward where the character looks; a prop stays in its original hand.',
  noDuplicates:
    'Every cell shows a visibly different pose or expression; never repeat a cell and never leave one empty.',
  gridRow: 'one row of ${count}',
  gridColumns:
    'a grid of ${layout.columns} columns and ${layout.rows} rows, reading left to right, then top to bottom',
  layout:
    'Arrange exactly ${count} drawings of the character as ${grid}, evenly spaced, each one centred in its own invisible cell, with a clear band of fully transparent empty space between every two drawings (around extended hands, props, hair and lips included): silhouettes never touch and never overlap.',
  cell: 'Cell ${index + 1}: ${description}.',
  gazeSweep:
    'The five cells are one smooth, monotonic sweep of the head and body from left profile to right profile, each turn clearly larger than the last.',
  gazePitch:
    'Every cell keeps the same pitch, ${GAZE_PITCH[params.row]}. The pitch comes from the tilt of the head and body, not from the eyelids or the pupils alone, and the camera stays fixed and level.',
  gazeExpression: 'Keep the calm neutral expression of the reference in every cell.',
  reactionFraming:
    'Every cell faces the viewer from the same camera, in the same stance and at the same scale as the reference; only the expression and the arms change, the torso and the feet stay where they are. Draw the actual expression and gesture, in the same style, not a label.'
}

const PILOT_DESCRIPTIONS = {
  laugh:
    'facing the viewer, laughing out loud: eyes squeezed shut or squinting, a big open grin, shoulders up',
  left: "the whole character turned to face the viewer's left in a three-quarter view (its own left side nearest the camera), the same calm neutral expression",
  neutral:
    'neutral, facing the viewer straight on, calm friendly expression, eyes on the viewer, the pose of the reference',
  right:
    "the whole character turned to face the viewer's right in a three-quarter view (its own right side nearest the camera), the same calm neutral expression"
}

export const GAZE_PITCH = {
  down1:
    'looking slightly down: the chin a little lowered, a hint of the crown or top of the head showing, the eyes aimed just below the viewer',
  down2:
    'looking strongly down: the head tipped well forward so the crown or top of the head is clearly exposed and the chin tucks away, the eyes aimed low beneath the viewer',
  level: "level: the head upright, the eyes at the viewer's own height",
  up1: 'looking slightly up: the chin a little raised, a hint of the underside of the chin or jaw showing, the eyes aimed just above the viewer',
  up2: 'looking strongly up: the head tilted well back so the chin and the underside of the jaw or muzzle are clearly exposed and the top of the head recedes, the eyes aimed high above the viewer'
}

const GAZE_DESCRIPTIONS = {
  front: 'front view, the whole character facing the viewer straight on',
  'left-profile':
    "left profile, the whole character facing fully to the viewer's left (its own left side nearest the camera, the far eye hidden)",
  'left-three-quarter':
    "left three-quarter view, the whole character turned halfway toward the viewer's left",
  'right-profile':
    "right profile, the whole character facing fully to the viewer's right (its own right side nearest the camera, the far eye hidden)",
  'right-three-quarter':
    "right three-quarter view, the whole character turned halfway toward the viewer's right"
}

export const REACTION_DESCRIPTIONS = {
  annoyed:
    'annoyed: half-lidded eyes, a flat or slightly pouting mouth, the head tilted a little away',
  blink:
    'blink: exactly the neutral pose and expression with both eyes fully closed and a calm mouth',
  calm: 'calm: soft relaxed eyes, a gentle closed-mouth smile, loose shoulders',
  confused:
    'confused: the head tilted, one brow raised, the mouth pulled to one side, eyes looking slightly up and away',
  excited:
    'excited: wide bright eyes, a big open smile, arms (or whatever limbs it has) thrown up in joy',
  kiss: 'kiss: lips puckered forward, eyes closed, a small lean toward the viewer',
  laugh: 'laugh: laughing out loud, eyes squeezed shut or squinting, a big open grin, shoulders up',
  proud:
    'proud: chest out, chin lifted, a confident closed-mouth smile, eyes half closed or closed',
  sleep:
    'sleep: fast asleep in the neutral stance, eyes closed, the head drooped forward or to one side, the mouth relaxed; clearly different from the blink',
  surprised: 'surprised: wide open eyes, the mouth open in a small o, a slight lean back',
  wink: 'wink: one eye closed, the other open and looking at the viewer, a small smile',
  worried:
    'worried: brows raised and drawn together, a small downturned mouth, the body slightly hunched'
}

const EXTRAS_DESCRIPTIONS = {
  'talk-a':
    'talking, mouth wide open as if in the middle of a word, otherwise exactly the neutral pose and expression of the reference, facing the viewer',
  'talk-b':
    'talking, mouth half open, otherwise exactly the neutral pose and expression of the reference, facing the viewer',
  wave: 'waving hello: facing the viewer with one free hand raised beside the head mid-wave (any held prop stays in its usual hand) and a friendly open smile'
}

const list = (items) => items.join(', ')

/** The web's describeCohostPetIdentity. */
export function describeIdentity(notes) {
  const parts = []
  if (notes.palette.length > 0)
    parts.push(fill(T.palette, { 'list(notes.palette)': list(notes.palette) }))
  if (notes.materials.length > 0) {
    parts.push(fill(T.materials, { 'list(notes.materials)': list(notes.materials) }))
  }
  // The web's template holds a regex literal (`/\.?$/`), so it is filled by hand.
  parts.push(`Proportions: ${notes.proportions.replace(/\.?$/, '.')}`)
  if (notes.asymmetric.length > 0) {
    const features = notes.asymmetric
      .map((item) =>
        fill(T.asymmetricItem, {
          'item.feature': item.feature,
          'item.side.toUpperCase()': item.side.toUpperCase()
        })
      )
      .join('; ')
    parts.push(fill(T.asymmetric, { features }))
  } else {
    parts.push(T.symmetric)
  }
  return parts.join(' ')
}

const identityLock = () => fill(T.identityLock, { BUDDY_HOUSE_STYLE })

function layoutSentence(layout) {
  const count = layout.columns * layout.rows
  const grid =
    layout.rows === 1
      ? fill(T.gridRow, { count })
      : fill(T.gridColumns, { 'layout.columns': layout.columns, 'layout.rows': layout.rows })
  return fill(T.layout, { count, grid })
}

function cellSentences(descriptions) {
  return descriptions
    .map((description, index) => fill(T.cell, { 'index + 1': index + 1, description }))
    .join(' ')
}

const assemble = (parts) => parts.join(' ')

export function buildPilotPrompt(notes) {
  return assemble([
    identityLock(),
    describeIdentity(notes),
    layoutSentence(PET_SHEET_LAYOUTS.pilot),
    cellSentences(PET_PILOT_CELLS.map((cell) => PILOT_DESCRIPTIONS[cell])),
    T.turns,
    T.wholeCharacter,
    T.sameScale,
    T.noDuplicates,
    T.background,
    T.noText
  ])
}

export function buildGazePrompt({ notes, row }) {
  if (!GAZE_ROWS.includes(row)) throw new Error('A gaze strip needs a row.')
  return assemble([
    identityLock(),
    describeIdentity(notes),
    layoutSentence(PET_SHEET_LAYOUTS.gaze),
    T.gazeSweep,
    cellSentences(PET_GAZE_CELLS.map((cell) => GAZE_DESCRIPTIONS[cell])),
    fill(T.gazePitch, { 'GAZE_PITCH[params.row]': GAZE_PITCH[row] }),
    T.turns,
    T.gazeExpression,
    T.wholeCharacter,
    T.sameScale,
    T.noDuplicates,
    T.background,
    T.noText
  ])
}

function buildReactionsPrompt(notes, kind, cells) {
  return assemble([
    identityLock(),
    describeIdentity(notes),
    layoutSentence(PET_SHEET_LAYOUTS[kind]),
    cellSentences(cells.map((cell) => REACTION_DESCRIPTIONS[cell])),
    T.reactionFraming,
    T.wholeCharacter,
    T.sameScale,
    T.noDuplicates,
    T.background,
    T.noText
  ])
}

export function buildExtrasPrompt(notes) {
  return assemble([
    identityLock(),
    describeIdentity(notes),
    layoutSentence(PET_SHEET_LAYOUTS.extras),
    cellSentences(PET_EXTRAS_CELLS.map((cell) => EXTRAS_DESCRIPTIONS[cell])),
    T.reactionFraming,
    T.wholeCharacter,
    T.sameScale,
    T.noDuplicates,
    T.background,
    T.noText
  ])
}

/** The web's buildCohostPetSheetPrompt, by builder sheet key: `{ prompt, size }`. */
export function buildSheetPrompt(key, notes) {
  const spec = sheetSpec(key)
  switch (spec.kind) {
    case 'pilot':
      return { prompt: buildPilotPrompt(notes), size: spec.size }
    case 'gaze':
      return { prompt: buildGazePrompt({ notes, row: spec.row }), size: spec.size }
    case 'reactions-a':
      return {
        prompt: buildReactionsPrompt(notes, 'reactions-a', PET_REACTIONS_A_CELLS),
        size: spec.size
      }
    case 'reactions-b':
      return {
        prompt: buildReactionsPrompt(notes, 'reactions-b', PET_REACTIONS_B_CELLS),
        size: spec.size
      }
    default:
      return { prompt: buildExtrasPrompt(notes), size: spec.size }
  }
}

/** The images/edits body the web's sheet route sends (AiGatewayClient.generateImage). */
export function sheetRequestBody({ model, prompt, size, referenceBase64 }) {
  return {
    images: [{ image_url: `data:image/png;base64,${referenceBase64}` }],
    model,
    n: 1,
    prompt,
    ...(model.startsWith('openai/')
      ? { providerOptions: { openai: { background: 'transparent', output_format: 'png' } } }
      : {}),
    response_format: 'b64_json',
    size
  }
}

// ---------------------------------------------------------------------------
// The copy check against videorc-web.

/** Every literal this module copied, as it appears in the web source. */
export function webPromptFragments() {
  return [
    ...IDENTITY_INSTRUCTION_TEMPLATES,
    PET_IDENTITY_INPUT,
    PET_IDENTITY_SCHEMA_NAME,
    ...Object.values(T),
    ...Object.values(PILOT_DESCRIPTIONS),
    ...Object.values(GAZE_PITCH),
    ...Object.values(GAZE_DESCRIPTIONS),
    ...Object.values(REACTION_DESCRIPTIONS),
    ...Object.values(EXTRAS_DESCRIPTIONS)
  ]
}

/**
 * What differs between this copy and the web: `promptsSource` is
 * `lib/ai/cohost-pet-prompts.ts`, `lookSource` is `lib/ai/buddy-look.ts`,
 * `petSource` is `lib/ai/cohost-pet.ts`. Empty when they match.
 */
export function checkWebPrompts({ promptsSource, lookSource, petSource }) {
  const problems = []
  const version = /export const PET_PROMPT_VERSION = (\d+);/.exec(promptsSource)?.[1]
  if (Number(version) !== PET_PROMPT_VERSION) {
    problems.push(
      `PET_PROMPT_VERSION is ${version ?? 'missing'} on the web and ${PET_PROMPT_VERSION} here`
    )
  }
  for (const fragment of webPromptFragments()) {
    if (!promptsSource.includes(fragment)) {
      problems.push(`not in cohost-pet-prompts.ts: ${fragment.slice(0, 90)}`)
    }
  }
  if (!lookSource.includes(`"${BUDDY_HOUSE_STYLE}"`)) {
    problems.push('BUDDY_HOUSE_STYLE differs from buddy-look.ts')
  }
  for (const [name, value] of [
    ['COHOST_PET_STRIP_IMAGE_SIZE', STRIP_IMAGE_SIZE],
    ['COHOST_PET_PILOT_IMAGE_SIZE', PILOT_IMAGE_SIZE],
    ['MAX_PET_NOTE_ITEMS', MAX_PET_NOTE_ITEMS],
    ['MAX_PET_NOTE_ITEM_CHARS', MAX_PET_NOTE_ITEM_CHARS],
    ['MAX_PET_PROPORTIONS_CHARS', MAX_PET_PROPORTIONS_CHARS],
    ['MAX_PET_ASYMMETRIC_ITEMS', MAX_PET_ASYMMETRIC_ITEMS],
    ['MAX_PET_FEATURE_CHARS', MAX_PET_FEATURE_CHARS]
  ]) {
    const literal = typeof value === 'string' ? `"${value}"` : String(value)
    if (!petSource.includes(`export const ${name} = ${literal};`)) {
      problems.push(`${name} differs from cohost-pet.ts`)
    }
  }
  if (!/PET_IDENTITY_MAX_OUTPUT_TOKENS = 600;/.test(promptsSource)) {
    problems.push('PET_IDENTITY_MAX_OUTPUT_TOKENS differs from cohost-pet-prompts.ts')
  }
  return problems
}

// ---------------------------------------------------------------------------
// Files.

/** `gaze-up1-v3.png`, the creator's versioned source name. */
export const versionedName = (key, version) => `${key}-v${version}.png`

/** `{ key: [versions ascending] }` from the file names of a sources folder. */
export function sourceVersions(fileNames) {
  const known = new Set([...SHEETS.map((sheet) => sheet.key), 'reference'])
  const versions = {}
  for (const name of fileNames) {
    const match = /^(.+)-v([1-9]\d*)\.png$/.exec(name)
    if (!match || !known.has(match[1])) continue
    ;(versions[match[1]] ??= []).push(Number(match[2]))
  }
  for (const key of Object.keys(versions)) versions[key].sort((a, b) => a - b)
  return versions
}

export function nextVersion(fileNames, key) {
  const versions = sourceVersions(fileNames)[key] ?? []
  return versions.length === 0 ? 1 : versions[versions.length - 1] + 1
}

/** Where a character's alive work lives: sources outside the repo, review in the scratchpad. */
export function alivePaths({ slug, home, reviewRoot }) {
  const root = join(home, 'videorc-assets', 'buddy-alive', slug)
  return {
    root,
    sources: join(root, 'sources'),
    identity: join(root, 'identity.json'),
    generations: join(root, 'generations.jsonl'),
    pack: join(root, 'pack'),
    pack512: join(root, 'pack-512'),
    ship: join(root, 'ship'),
    review: join(reviewRoot, slug)
  }
}

/** The official master an official character's reference is made from. */
export function referenceMaster(slug) {
  return slug === 'golem'
    ? 'assets/brand/buddy/golem-master.png'
    : join('assets/brand/buddy/official', slug, 'idle-master.png')
}

/** The pack id of an official character (plan 172 shapes). */
export const officialPackId = (slug) => (slug === 'golem' ? 'bundled:buddy' : `official:${slug}`)

/** The catalog's `alive` block for one official pack (files: the three the web serves). */
export function aliveBlock({ slug, version = 1, cellSize, frames, files }) {
  const served = ['manifest.json', 'mascot.webp', 'buddy.json']
  const byName = new Map(files.map((file) => [file.name, file]))
  return {
    version,
    packId: officialPackId(slug),
    bundled: slug === 'golem',
    cellSize,
    frames,
    files: served.map((name) => {
      const file = byName.get(name)
      if (!file) throw new Error(`${slug}: the pack has no ${name}`)
      return { name, bytes: file.bytes, sha256: file.sha256 }
    })
  }
}

// ---------------------------------------------------------------------------
// Review.

const GAZE_COLUMN_WORDS = ['left profile', 'left 3/4', 'front', 'right 3/4', 'right profile']
const GAZE_COLUMN_ARROWS = ['←←', '←', '•', '→', '→→']
const GAZE_ROW_WORDS = {
  up2: 'strongly up',
  up1: 'slightly up',
  level: 'level',
  down1: 'slightly down',
  down2: 'strongly down'
}
const GAZE_ROW_ARROWS = { up2: '↑↑', up1: '↑', level: '', down1: '↓', down2: '↓↓' }

/**
 * The intended pose of every cell of a sheet, for the contact sheets:
 * `{ id, label }` with the direction a gaze cell should look (viewer's left
 * and right, as page-pet's x: negative is the viewer's left).
 */
export function reviewCells(key) {
  const spec = sheetSpec(key)
  if (spec.kind === 'gaze') {
    const rowIndex = GAZE_ROWS.indexOf(spec.row)
    return PET_GAZE_CELLS.map((_, column) => ({
      id: `gaze-${column}-${rowIndex}`,
      label: `${GAZE_COLUMN_ARROWS[column]}${GAZE_ROW_ARROWS[spec.row]} ${GAZE_COLUMN_WORDS[column]}, ${GAZE_ROW_WORDS[spec.row]}`
    }))
  }
  return spec.cells.map((cell) => ({ id: cell, label: cell }))
}

/**
 * The preview's frame order: the 25 gaze cells as one continuous sweep
 * (each row left to right, then right to left), back to the neutral, every
 * reaction, a few talk cycles and the wave. `[id, milliseconds]` pairs.
 */
export function previewFrames() {
  const frames = []
  GAZE_ROWS.forEach((_, row) => {
    const columns = [0, 1, 2, 3, 4]
    if (row % 2 === 1) columns.reverse()
    for (const column of columns) frames.push([`gaze-${column}-${row}`, 180])
  })
  frames.push(['gaze-2-2', 700])
  for (const id of [...PET_REACTIONS_A_CELLS, ...PET_REACTIONS_B_CELLS]) {
    frames.push([id, 650])
    frames.push(['gaze-2-2', 250])
  }
  for (let cycle = 0; cycle < 4; cycle += 1) {
    frames.push(['talk-a', 130], ['talk-b', 130], ['gaze-2-2', 130])
  }
  frames.push(['gaze-2-2', 300], ['wave', 900], ['gaze-2-2', 900])
  return frames
}

/** Cost in USD of one image call from its `usage` and the model's per-token prices. */
export function usageCostUsd(usage, pricing) {
  if (!usage || !pricing) return null
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0)
  if (!Number.isFinite(input) || !Number.isFinite(output) || input + output === 0) return null
  const price = (name) => Number(pricing[name] ?? 0)
  const cachedPrice =
    pricing.input_cache_read !== undefined ? price('input_cache_read') : price('input')
  return (input - cached) * price('input') + cached * cachedPrice + output * price('output')
}

// ---------------------------------------------------------------------------
// Arguments.

export const SHIP_VARIANTS = ['lossless', 'q92', 'q92-512']

/**
 * `--slug <slug>` (one character), then what to run:
 *   (default)            identity (once), the pilot (once), every missing sheet, build, review
 *   --until <step>       stop after identity, pilot or sheets
 *   --sheets <k,...>     generate these sheets again as new versions (pilot included), then build and review
 *   --identity           read the identity notes again
 *   --build-only         no generation: build and review what is there
 *   --ship <variant>     lossless, q92 or q92-512: write the shipped copy of the built pack
 *   --compare            side-by-side of the ship variants at on-stream size (review only)
 *   --model / --vision-model <id>, --concurrency <n>, --web <dir>, --skip-web-check
 */
export function parseArgs(argv, catalog) {
  const options = {
    slug: null,
    until: null,
    sheets: null,
    identity: false,
    buildOnly: false,
    ship: null,
    compare: false,
    model: DEFAULT_IMAGE_MODEL,
    visionModel: DEFAULT_VISION_MODEL,
    concurrency: 4,
    web: null,
    skipWebCheck: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    const takes = () => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Unknown or incomplete option: ${flag}`)
      }
      index += 1
      return value
    }
    switch (flag) {
      case '--slug':
        options.slug = takes()
        break
      case '--until':
        options.until = takes()
        break
      case '--sheets':
        options.sheets = takes().split(',').filter(Boolean)
        break
      case '--identity':
        options.identity = true
        break
      case '--build-only':
        options.buildOnly = true
        break
      case '--ship':
        options.ship = takes()
        break
      case '--compare':
        options.compare = true
        break
      case '--model':
        options.model = takes()
        break
      case '--vision-model':
        options.visionModel = takes()
        break
      case '--concurrency':
        options.concurrency = Number(takes())
        break
      case '--web':
        options.web = takes()
        break
      case '--skip-web-check':
        options.skipWebCheck = true
        break
      default:
        throw new Error(`Unknown or incomplete option: ${flag}`)
    }
  }
  if (!options.slug) throw new Error('Pass --slug <slug>.')
  if (!catalog.some((entry) => entry.slug === options.slug)) {
    throw new Error(`No official character "${options.slug}" in the catalog.`)
  }
  if (options.until && !['identity', 'pilot', 'sheets'].includes(options.until)) {
    throw new Error(`--until takes identity, pilot or sheets, not ${options.until}`)
  }
  for (const key of options.sheets ?? []) sheetSpec(key)
  if (options.ship && !SHIP_VARIANTS.includes(options.ship)) {
    throw new Error(`--ship takes ${SHIP_VARIANTS.join(', ')}, not ${options.ship}`)
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency takes a whole number of at least 1')
  }
  if (options.buildOnly && (options.sheets || options.identity || options.until)) {
    throw new Error('--build-only generates nothing; drop --sheets, --identity and --until')
  }
  return options
}
