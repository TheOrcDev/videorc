import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  STARTER_MANIFEST,
  STARTER_SOUNDS_DIR,
  encodeArguments,
  licencesMarkdown,
  manifestProblems,
  sha256Hex
} from './starter-sounds.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(join(root, STARTER_MANIFEST), 'utf8'))

describe('starter sounds (plan 189 S1)', () => {
  it('ships a valid manifest: CC0 only, freesound sources, unique slugs and keys', () => {
    assert.deepEqual(manifestProblems(manifest), [])
    assert.equal(manifest.sounds.length, 12)
    assert.deepEqual(
      manifest.sounds.filter((sound) => sound.hotkey).map((sound) => sound.hotkey),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9']
    )
  })

  it('ships exactly the files the manifest names, byte for byte', () => {
    for (const sound of manifest.sounds) {
      const path = join(root, STARTER_SOUNDS_DIR, sound.file)
      assert.ok(existsSync(path), `${sound.file} is missing`)
      assert.equal(sha256Hex(readFileSync(path)), sound.sha256, `${sound.file} changed`)
    }
    const shipped = readdirSync(join(root, STARTER_SOUNDS_DIR)).filter((name) =>
      name.endsWith('.ogg')
    )
    assert.deepEqual(shipped.sort(), manifest.sounds.map((sound) => sound.file).sort())
  })

  it('keeps LICENSES.md generated from the manifest', () => {
    assert.equal(
      readFileSync(join(root, STARTER_SOUNDS_DIR, 'LICENSES.md'), 'utf8'),
      licencesMarkdown(manifest)
    )
  })

  it('refuses a sound that is not CC0, from elsewhere, or keyed twice', () => {
    const [first, second] = manifest.sounds
    const problems = manifestProblems({
      sounds: [
        { ...first, licence: 'CC-BY-4.0' },
        { ...second, hotkey: first.hotkey, sourceUrl: 'https://example.com/x/' }
      ]
    })
    assert.ok(problems.some((problem) => problem.includes('licence must be CC0-1.0')))
    assert.ok(problems.some((problem) => problem.includes('hotkey is used twice')))
    assert.ok(problems.some((problem) => problem.includes('freesound.org sound page')))
    assert.deepEqual(manifestProblems({}), ['The manifest needs a "sounds" array.'])
  })

  it('cuts a long sound with a 300 ms fade and only fades the edges of a short one', () => {
    const long = encodeArguments({
      input: 'in',
      output: 'out',
      durationSeconds: 12.5,
      maxSeconds: 5
    })
    const longFilters = long[long.indexOf('-af') + 1]
    assert.match(longFilters, /atrim=end=5,afade=t=out:st=4\.700:d=0\.3$/)
    const short = encodeArguments({
      input: 'in',
      output: 'out',
      durationSeconds: 1.6,
      maxSeconds: 5
    })
    const shortFilters = short[short.indexOf('-af') + 1]
    assert.doesNotMatch(shortFilters, /atrim/)
    assert.match(shortFilters, /afade=t=in:d=0\.005/)
    for (const args of [long, short]) {
      assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 4), [
        '-c:a',
        'libopus',
        '-b:a',
        '128k'
      ])
      assert.equal(args.at(-1), 'out')
    }
  })
})
