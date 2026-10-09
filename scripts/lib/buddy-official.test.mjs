import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  POSE_STATES,
  buildCreatePrompt,
  buildStatePrompt,
  officialPaths,
  parseArgs,
  readCatalog
} from './buddy-official.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = readCatalog(repoRoot)

test('the official catalog: five characters, the Buddy first, every field in the app limits', () => {
  assert.deepEqual(
    catalog.map((entry) => entry.slug),
    ['golem', 'orc', 'goblin', 'pirate', 'robot']
  )
  for (const entry of catalog) {
    assert.equal(entry.id, `official:${entry.slug}`)
    assert.ok(entry.name.length >= 1 && entry.name.length <= 24, entry.name)
    assert.ok(entry.personality.length <= 1200)
    assert.ok(entry.tagline.length > 0)
    assert.equal(/\u2014/.test(JSON.stringify(entry)), false, 'no em-dashes in copy')
  }
  assert.equal(catalog[0].description, null, "Buddy the Golem is the owner's original art")
  assert.equal(catalog.find((entry) => entry.slug === 'orc').name, 'Golmar')
})

test('a create prompt anchors the style, never the character, and carries the description', () => {
  const prompt = buildCreatePrompt('  a burly   friendly orc ')
  assert.match(
    prompt,
    /^Image 1 is the house art style reference: art style only, not the character\./
  )
  assert.match(prompt, /Draw a NEW character: a burly friendly orc\./)
  assert.match(prompt, /Fully transparent background/)
  assert.throws(() => buildCreatePrompt('   '), /needs a description/)
})

test('a state prompt keeps the character and changes only the face and arms', () => {
  for (const state of ['talk', 'laugh', 'think']) {
    const prompt = buildStatePrompt(state)
    assert.match(prompt, /exactly as it is/)
    assert.match(prompt, /Change only the facial expression and the arms/)
  }
  assert.throws(() => buildStatePrompt('idle'), /Unknown edit state/)
})

test('arguments: all means every generated character, never the hand-made Buddy', () => {
  assert.deepEqual(parseArgs(['--slug', 'all'], catalog).slugs, [
    'orc',
    'goblin',
    'pirate',
    'robot'
  ])
  assert.deepEqual(parseArgs(['--slug', 'orc'], catalog).states, POSE_STATES)
  assert.deepEqual(parseArgs(['--slug', 'orc', '--states', 'laugh'], catalog).states, ['laugh'])
  assert.equal(parseArgs(['--slug', 'orc', '--export-only'], catalog).exportOnly, true)
  assert.throws(() => parseArgs(['--slug', 'golem'], catalog), /hand-made art/)
  assert.throws(() => parseArgs(['--slug', 'dragon'], catalog), /No official character/)
  assert.throws(() => parseArgs(['--slug', 'orc', '--states', 'dance'], catalog), /Unknown state/)
  assert.throws(() => parseArgs([], catalog), /Pass --slug/)
  assert.throws(() => parseArgs(['--slug'], catalog), /Unknown or incomplete option/)
})

test('paths: masters outside the bundle, exports in the renderer assets', () => {
  const paths = officialPaths('orc')
  assert.equal(paths.master('idle'), 'assets/brand/buddy/official/orc/idle-master.png')
  assert.equal(
    paths.appWebp('talk'),
    'apps/desktop/src/renderer/src/assets/buddy/official/orc/talk.webp'
  )
})
