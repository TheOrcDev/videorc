// Plan 170 Phase B: the pure parts of `pnpm golem:official`, which draws
// Videorc's official Golem characters (protocol-fixtures/golem-official-catalog.json)
// in the house look and exports them for the app and the website.
//
// The prompt words are a copy of videorc-web `lib/ai/golem-look.ts`
// (GOLEM_LOOK_VERSION 1), so an official character is drawn exactly the way a
// streamer's own Golem is. Change both together.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GOLEM_LOOK_VERSION = 1
export const DEFAULT_MODEL = 'openai/gpt-image-2.5-sunburst'
export const POSE_STATES = ['idle', 'talk', 'laugh', 'think']
export const EDIT_STATES = ['talk', 'laugh', 'think']

export const GOLEM_HOUSE_STYLE =
  'a stylised 3D cartoon character render: soft rounded chunky forms, smooth matte materials with subtle surface texture, warm soft studio lighting, gentle ambient occlusion, a clean readable silhouette, big friendly expressive eyes, sturdy proportions with a large head'

export const GOLEM_STRUCTURE_RULES =
  'one single character, full body from head to feet, standing upright, facing the viewer, centred, about 80 % of the frame height, feet on one baseline near the bottom, fully transparent background, no floor, no shadow, no frame, no text'

export const GOLEM_STATE_DIRECTIONS = {
  laugh:
    'laughing out loud: eyes squeezed into happy curves, a big wide open grin, head tilted back a little, shoulders up, one fist near the belly',
  talk: 'mid-sentence and talking to the viewer: mouth clearly open as if speaking, eyebrows lifted, friendly and animated, one hand slightly raised in a small gesture',
  think:
    'thinking hard: eyes looking up and to the side, one brow raised, a hand under the chin, a small puzzled mouth'
}

const TRANSPARENT_BACKGROUND =
  'Fully transparent background (PNG alpha): nothing behind the character, no scenery, no floor, no shadow, no frame, no colour fill.'
const NO_TEXT = 'No text, no letters, no watermark, no speech bubble.'

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** The idle of a new character: an image edit whose image 1 is the style anchor. */
export function buildCreatePrompt(description) {
  const words = collapse(description ?? '')
  if (!words) throw new Error('An official character needs a description.')
  return [
    'Image 1 is the house art style reference: art style only, not the character. Match its 3D render look, surface finish and lighting, but do not copy its creature, its body or its face.',
    `Draw a NEW character: ${words}.`,
    `Art style: ${GOLEM_HOUSE_STYLE}.`,
    `Composition: ${GOLEM_STRUCTURE_RULES}.`,
    'The character is calm and relaxed with a neutral friendly expression, looking at the viewer, arms relaxed at its sides.',
    TRANSPARENT_BACKGROUND,
    NO_TEXT
  ].join(' ')
}

/** talk, laugh and think: an image edit of the idle that keeps all but the face and arms. */
export function buildStatePrompt(state) {
  const direction = GOLEM_STATE_DIRECTIONS[state]
  if (!direction) throw new Error(`Unknown edit state: ${state}`)
  return [
    'Use the character in the provided image exactly as it is: the same character, colours, materials and the same 3D cartoon render style and lighting.',
    'Keep the full body in view, the same size, the same position in the frame, standing on the same spot with both feet on the same baseline.',
    `Change only the facial expression and the arms so that the character is ${direction}.`,
    TRANSPARENT_BACKGROUND,
    NO_TEXT
  ].join(' ')
}

export function readCatalog(repoRoot) {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, 'protocol-fixtures/golem-official-catalog.json'), 'utf8')
  )
  return raw.avatars
}

/** Where each file of an official character lives, relative to the repo root. */
export function officialPaths(slug) {
  return {
    masterDir: join('assets/brand/golem/official', slug),
    master: (state) => join('assets/brand/golem/official', slug, `${state}-master.png`),
    appWebp: (state) =>
      join('apps/desktop/src/renderer/src/assets/golem/official', slug, `${state}.webp`)
  }
}

/**
 * `--slug orc,goblin` (or `all`), `--states idle,talk` (default all four),
 * `--export-only`, `--model <id>`. Talk, laugh and think are edits of the
 * character's committed idle master, so redoing one state keeps the character.
 */
export function parseArgs(argv, catalog) {
  const generated = catalog.filter((entry) => entry.description)
  const options = { slugs: [], states: [...POSE_STATES], exportOnly: false, model: DEFAULT_MODEL }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--export-only') {
      options.exportOnly = true
    } else if (flag === '--slug' && value) {
      options.slugs =
        value === 'all' ? generated.map((entry) => entry.slug) : value.split(',').filter(Boolean)
      index += 1
    } else if (flag === '--states' && value) {
      options.states = value.split(',').filter(Boolean)
      index += 1
    } else if (flag === '--model' && value) {
      options.model = value
      index += 1
    } else {
      throw new Error(`Unknown or incomplete option: ${flag}`)
    }
  }
  if (options.slugs.length === 0) throw new Error('Pass --slug <slug,...> or --slug all.')
  for (const slug of options.slugs) {
    const entry = catalog.find((candidate) => candidate.slug === slug)
    if (!entry) throw new Error(`No official character "${slug}" in the catalog.`)
    if (!entry.description) throw new Error(`"${slug}" is hand-made art; it is never generated.`)
  }
  for (const state of options.states) {
    if (!POSE_STATES.includes(state)) throw new Error(`Unknown state: ${state}`)
  }
  return options
}
