import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readCatalog } from './buddy-official.mjs'
import {
  ATLAS_SHEET_KEYS,
  PET_IDENTITY_INSTRUCTIONS,
  PET_PROMPT_VERSION,
  aliveBlock,
  alivePaths,
  buildSheetPrompt,
  checkWebPrompts,
  describeIdentity,
  fill,
  identityRequestBody,
  nextVersion,
  officialPackId,
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
  versionedName,
  webPromptFragments
} from './buddy-alive.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = readCatalog(repoRoot)

const NOTES = {
  asymmetric: [{ feature: 'a crack over the brow', side: 'left' }],
  materials: ['stone', 'moss'],
  palette: ['warm grey stone', 'moss green'],
  proportions: 'A big round head on a short sturdy body'
}

test('the sheets of a pack: the pilot, five gaze rows top to bottom, two reaction sheets, the extras', () => {
  assert.deepEqual(ATLAS_SHEET_KEYS, [
    'gaze-up2',
    'gaze-up1',
    'gaze-level',
    'gaze-down1',
    'gaze-down2',
    'reactions-a',
    'reactions-b',
    'extras'
  ])
  assert.deepEqual(
    [sheetSpec('pilot').size, sheetSpec('gaze-up2').size, sheetSpec('extras').size],
    ['1024x1024', '1536x1024', '1536x1024']
  )
  assert.equal(sheetSpec('gaze-down1').row, 'down1')
  assert.deepEqual([sheetSpec('reactions-b').columns, sheetSpec('reactions-b').rows], [3, 2])
  assert.throws(() => sheetSpec('gaze-sideways'), /Unknown sheet/)
})

test('fill substitutes every placeholder and refuses a missing value', () => {
  assert.equal(
    fill('Cell ${index + 1}: ${description}.', { 'index + 1': 3, description: 'x' }),
    'Cell 3: x.'
  )
  assert.throws(() => fill('${nope}', {}), /No value/)
})

test('identity notes: the web request shape and its normalisation', () => {
  const body = identityRequestBody({ model: 'openai/gpt-5.5', referenceBase64: 'AAAA' })
  assert.equal(body.max_output_tokens, 600)
  assert.equal(body.text.format.strict, true)
  assert.equal(body.text.format.name, 'videorc_pet_identity_notes')
  assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,AAAA')
  assert.match(PET_IDENTITY_INSTRUCTIONS, /at most 8\. Ignore the background\./)
  assert.match(PET_IDENTITY_INSTRUCTIONS, /At most 400 characters\./)
  assert.match(PET_IDENTITY_INSTRUCTIONS, /At most 12\./)

  assert.equal(
    responsesOutputText({
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '{"a":' },
            { type: 'output_text', text: '1}' }
          ]
        }
      ]
    }),
    '{"a":1}'
  )
  assert.equal(responsesOutputText({ output_text: 'x' }), 'x')
  assert.equal(responsesOutputText(null), '')

  const notes = readIdentityOutput({
    asymmetric: [
      { feature: '  a  crack ', side: ' LEFT ' },
      { feature: 'a crack', side: 'right' },
      { feature: 'a belt', side: 'centre' }
    ],
    materials: ['stone', 'Stone', ' moss '],
    palette: Array.from({ length: 10 }, (_, index) => `colour ${index}`),
    proportions: '  big   head '
  })
  assert.deepEqual(notes, {
    asymmetric: [{ feature: 'a crack', side: 'left' }],
    materials: ['stone', 'moss'],
    palette: Array.from({ length: 8 }, (_, index) => `colour ${index}`),
    proportions: 'big head'
  })
  assert.equal(readIdentityOutput({ proportions: '   ' }), null)
  assert.equal(readIdentityOutput([]), null)
})

test('the identity lock names anatomical sides, or says the design is symmetric', () => {
  const described = describeIdentity(NOTES)
  assert.match(
    described,
    /^Palette: warm grey stone, moss green\. Materials: stone, moss\. Proportions: A big round head on a short sturdy body\./
  )
  assert.match(described, /a crack over the brow on the character's own LEFT side/)
  assert.match(
    describeIdentity({ ...NOTES, asymmetric: [], proportions: 'Round.' }),
    /Proportions: Round\. The design is symmetric/
  )
})

test('sheet prompts: the house look, the layout, the cells in order, the row pitch', () => {
  const gaze = buildSheetPrompt('gaze-up2', NOTES)
  assert.equal(gaze.size, '1536x1024')
  assert.match(gaze.prompt, /^Use the character in the provided image exactly as it is/)
  assert.match(gaze.prompt, /a stylised 3D cartoon character render/)
  assert.match(gaze.prompt, /Arrange exactly 5 drawings of the character as one row of 5,/)
  const order = [
    'Cell 1: left profile',
    'Cell 2: left three-quarter',
    'Cell 3: front view',
    'Cell 4: right three-quarter',
    'Cell 5: right profile'
  ]
  const positions = order.map((cell) => gaze.prompt.indexOf(cell))
  assert.ok(
    positions.every((position, index) => position > (positions[index - 1] ?? -1)),
    positions.join()
  )
  assert.match(gaze.prompt, /Every cell keeps the same pitch, looking strongly up:/)
  assert.match(buildSheetPrompt('gaze-down1', NOTES).prompt, /same pitch, looking slightly down:/)

  const reactions = buildSheetPrompt('reactions-a', NOTES).prompt
  assert.match(
    reactions,
    /as a grid of 3 columns and 2 rows, reading left to right, then top to bottom,/
  )
  assert.match(reactions, /Cell 6: sleep: fast asleep/)
  const pilot = buildSheetPrompt('pilot', NOTES)
  assert.equal(pilot.size, '1024x1024')
  assert.match(pilot.prompt, /Cell 1: neutral, facing the viewer straight on/)
  assert.match(buildSheetPrompt('extras', NOTES).prompt, /Cell 3: waving hello/)
  for (const key of ['pilot', ...ATLAS_SHEET_KEYS]) {
    const { prompt } = buildSheetPrompt(key, NOTES)
    assert.equal(/\$\{/.test(prompt), false, `${key} has an unfilled placeholder`)
    assert.match(
      prompt,
      /No text, no letters, no numbers, no labels, no symbols, no watermark, no logo, no speech bubble\.$/
    )
  }
})

test('the images/edits body: one reference, a transparent PNG for openai models', () => {
  const body = sheetRequestBody({
    model: 'openai/gpt-image-2.5-sunburst',
    prompt: 'p',
    size: '1536x1024',
    referenceBase64: 'QQ=='
  })
  assert.deepEqual(body, {
    images: [{ image_url: 'data:image/png;base64,QQ==' }],
    model: 'openai/gpt-image-2.5-sunburst',
    n: 1,
    prompt: 'p',
    providerOptions: { openai: { background: 'transparent', output_format: 'png' } },
    response_format: 'b64_json',
    size: '1536x1024'
  })
  assert.equal(
    'providerOptions' in
      sheetRequestBody({ model: 'bfl/x', prompt: 'p', size: 's', referenceBase64: '' }),
    false
  )
})

test('the web check passes on a source holding every fragment and names each drift', () => {
  const promptsSource = [
    'export const PET_PROMPT_VERSION = 2;',
    'export const PET_IDENTITY_MAX_OUTPUT_TOKENS = 600;',
    ...webPromptFragments()
  ].join('\n')
  const lookSource =
    'export const BUDDY_HOUSE_STYLE =\n  "a stylised 3D cartoon character render: soft rounded chunky forms, smooth matte materials with subtle surface texture, warm soft studio lighting, gentle ambient occlusion, a clean readable silhouette, big friendly expressive eyes, sturdy proportions with a large head";'
  const petSource = [
    'export const COHOST_PET_STRIP_IMAGE_SIZE = "1536x1024";',
    'export const COHOST_PET_PILOT_IMAGE_SIZE = "1024x1024";',
    'export const MAX_PET_NOTE_ITEMS = 8;',
    'export const MAX_PET_NOTE_ITEM_CHARS = 60;',
    'export const MAX_PET_PROPORTIONS_CHARS = 400;',
    'export const MAX_PET_ASYMMETRIC_ITEMS = 12;',
    'export const MAX_PET_FEATURE_CHARS = 80;'
  ].join('\n')
  assert.deepEqual(checkWebPrompts({ promptsSource, lookSource, petSource }), [])
  const drifted = checkWebPrompts({
    promptsSource: promptsSource
      .replace('PET_PROMPT_VERSION = 2;', 'PET_PROMPT_VERSION = 3;')
      .replace('nothing floats and nothing sinks', 'nothing floats'),
    lookSource: lookSource.replace('large head', 'huge head'),
    petSource: petSource.replace('= 8;', '= 9;')
  })
  assert.equal(drifted.length, 4, drifted.join('\n'))
  assert.match(drifted[0], /PET_PROMPT_VERSION is 3 on the web and 2 here/)
})

// The copy must equal the web module itself. Runs when a videorc-web checkout
// is at VIDEORC_WEB_DIR (CI has none; `pnpm buddy:alive` checks it too).
const webDir = process.env.VIDEORC_WEB_DIR
const webPrompts = webDir ? join(webDir, 'lib/ai/cohost-pet-prompts.ts') : null
test('the prompt copy equals videorc-web', { skip: !webPrompts || !existsSync(webPrompts) }, () => {
  const read = (name) => readFileSync(join(webDir, 'lib/ai', name), 'utf8')
  assert.deepEqual(
    checkWebPrompts({
      promptsSource: read('cohost-pet-prompts.ts'),
      lookSource: read('buddy-look.ts'),
      petSource: read('cohost-pet.ts')
    }),
    []
  )
  assert.equal(PET_PROMPT_VERSION, 2)
})

test('versioned sources: the creator names, the next version, unknown files ignored', () => {
  assert.equal(versionedName('gaze-up1', 3), 'gaze-up1-v3.png')
  const files = [
    'gaze-up1-v1.png',
    'gaze-up1-v3.png',
    'reference.png',
    'pilot-v1.png',
    'notes.txt',
    'gaze-up9-v1.png',
    'extras-v0.png'
  ]
  assert.deepEqual(sourceVersions(files), { 'gaze-up1': [1, 3], pilot: [1] })
  assert.equal(nextVersion(files, 'gaze-up1'), 4)
  assert.equal(nextVersion(files, 'extras'), 1)
})

test('paths: sources outside the repo, masters from the brand folder, official pack ids', () => {
  const paths = alivePaths({ slug: 'orc', home: '/Users/me', reviewRoot: '/tmp/review' })
  assert.equal(paths.sources, '/Users/me/videorc-assets/buddy-alive/orc/sources')
  assert.equal(paths.review, '/tmp/review/orc')
  assert.equal(referenceMaster('golem'), 'assets/brand/buddy/golem-master.png')
  assert.equal(referenceMaster('robot'), 'assets/brand/buddy/official/robot/idle-master.png')
  for (const entry of catalog)
    assert.ok(existsSync(join(repoRoot, referenceMaster(entry.slug))), entry.slug)
  assert.equal(officialPackId('golem'), 'bundled:buddy')
  assert.equal(officialPackId('pirate'), 'official:pirate')
})

test('the catalog alive block lists the three served files and only the Golem is bundled', () => {
  const files = [
    { name: 'manifest.json', bytes: 10, sha256: 'a'.repeat(64) },
    { name: 'mascot.webp', bytes: 20, sha256: 'b'.repeat(64) },
    { name: 'buddy.json', bytes: 30, sha256: 'c'.repeat(64) },
    { name: 'build-report.json', bytes: 40, sha256: 'd'.repeat(64) }
  ]
  assert.deepEqual(aliveBlock({ slug: 'golem', cellSize: 640, frames: 40, files }), {
    version: 1,
    packId: 'bundled:buddy',
    bundled: true,
    cellSize: 640,
    frames: 40,
    files: files.slice(0, 3)
  })
  assert.equal(aliveBlock({ slug: 'goblin', cellSize: 512, frames: 40, files }).bundled, false)
  assert.throws(
    () => aliveBlock({ slug: 'orc', cellSize: 640, frames: 40, files: files.slice(1) }),
    /no manifest\.json/
  )
})

test('review: each gaze cell names the direction it should look; the preview sweeps then reacts', () => {
  assert.deepEqual(
    reviewCells('gaze-up2').map((cell) => cell.id),
    ['gaze-0-0', 'gaze-1-0', 'gaze-2-0', 'gaze-3-0', 'gaze-4-0']
  )
  assert.match(reviewCells('gaze-up2')[0].label, /left profile, strongly up$/)
  assert.match(reviewCells('gaze-level')[4].label, /right profile, level$/)
  assert.deepEqual(
    reviewCells('extras').map((cell) => cell.id),
    ['talk-a', 'talk-b', 'wave']
  )
  const frames = previewFrames()
  const gaze = frames.slice(0, 25).map(([id]) => id)
  assert.equal(new Set(gaze).size, 25)
  assert.deepEqual(
    gaze.slice(4, 6),
    ['gaze-4-0', 'gaze-4-1'],
    'the sweep turns back at the row end'
  )
  for (const id of ['laugh', 'calm', 'talk-a', 'talk-b', 'wave'])
    assert.ok(
      frames.some(([frame]) => frame === id),
      id
    )
})

test('cost from token usage and the model prices; null without usage', () => {
  const pricing = { input: '0.000005', output: '0.00003', input_cache_read: '0.00000125' }
  assert.equal(
    usageCostUsd(
      { input_tokens: 1000, output_tokens: 2000, input_tokens_details: { cached_tokens: 200 } },
      pricing
    ).toFixed(6),
    (800 * 0.000005 + 200 * 0.00000125 + 2000 * 0.00003).toFixed(6)
  )
  assert.equal(usageCostUsd(null, pricing), null)
  assert.equal(usageCostUsd({ input_tokens: 0, output_tokens: 0 }, pricing), null)
})

test('arguments: one official character, known sheets, the ship variants', () => {
  const options = parseArgs(['--slug', 'golem'], catalog)
  assert.equal(options.slug, 'golem')
  assert.equal(options.model, 'openai/gpt-image-2.5-sunburst')
  assert.equal(options.visionModel, 'openai/gpt-5.5')
  assert.deepEqual(parseArgs(['--slug', 'orc', '--sheets', 'gaze-up2,extras'], catalog).sheets, [
    'gaze-up2',
    'extras'
  ])
  assert.equal(parseArgs(['--slug', 'orc', '--until', 'pilot'], catalog).until, 'pilot')
  assert.equal(
    parseArgs(['--slug', 'orc', '--build-only', '--ship', 'q92-512'], catalog).ship,
    'q92-512'
  )
  assert.throws(() => parseArgs([], catalog), /Pass --slug/)
  assert.throws(() => parseArgs(['--slug', 'dragon'], catalog), /No official character/)
  assert.throws(
    () => parseArgs(['--slug', 'orc', '--sheets', 'gaze-sideways'], catalog),
    /Unknown sheet/
  )
  assert.throws(() => parseArgs(['--slug', 'orc', '--until', 'build'], catalog), /--until takes/)
  assert.throws(() => parseArgs(['--slug', 'orc', '--ship', 'lossy'], catalog), /--ship takes/)
  assert.throws(
    () => parseArgs(['--slug', 'orc', '--build-only', '--sheets', 'extras'], catalog),
    /generates nothing/
  )
  assert.throws(() => parseArgs(['--slug'], catalog), /incomplete option/)
  assert.throws(() => parseArgs(['--slug', 'orc', '--concurrency', '0'], catalog), /--concurrency/)
})
