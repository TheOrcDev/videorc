// Plan 189 S1: the starter sounds that ship with Videorc. The manifest at
// apps/desktop/resources/sounds/starter/manifest.json is the source of truth:
// where each sound came from, its licence, and how it was processed. Every
// starter must be CC0 (or the owner's own): the repo is open source and the
// files ship inside the app. Pure helpers, so the rules are tested in node.

import { createHash } from 'node:crypto'

export const STARTER_SOUNDS_DIR = 'apps/desktop/resources/sounds/starter'
export const STARTER_MANIFEST = `${STARTER_SOUNDS_DIR}/manifest.json`
export const STARTER_LICENCE = 'CC0-1.0'
/** The keys a sound can take in Studio (`SOUND_HOTKEYS` in shared/backend.ts). */
export const STARTER_HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
/** Starters are effects: the import allows 30 s, the pack keeps each short. */
export const STARTER_MAX_SECONDS = 5

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FREESOUND_PAGE = /^https:\/\/freesound\.org\/people\/[^/]+\/sounds\/\d+\/$/
const FREESOUND_PREVIEW = /^https:\/\/cdn\.freesound\.org\/previews\/\d+\/\d+_\d+-hq\.mp3$/

/** The problems with a manifest, as sentences; empty when it is valid. */
export function manifestProblems(manifest) {
  const problems = []
  if (!manifest || !Array.isArray(manifest.sounds)) {
    return ['The manifest needs a "sounds" array.']
  }
  const slugs = new Set()
  const hotkeys = new Set()
  for (const [index, sound] of manifest.sounds.entries()) {
    const where = `sounds[${index}] (${sound?.slug ?? 'no slug'})`
    if (typeof sound?.slug !== 'string' || !SLUG.test(sound.slug) || sound.slug.length > 32) {
      problems.push(`${where}: the slug must be kebab-case, at most 32 characters.`)
    } else if (slugs.has(sound.slug)) {
      problems.push(`${where}: the slug is used twice.`)
    } else {
      slugs.add(sound.slug)
    }
    if (typeof sound?.name !== 'string' || sound.name.length < 1 || sound.name.length > 64) {
      problems.push(`${where}: the name must be 1 to 64 characters.`)
    }
    if (sound?.hotkey !== undefined) {
      if (!STARTER_HOTKEYS.includes(sound.hotkey)) {
        problems.push(`${where}: the hotkey must be "1" to "9".`)
      } else if (hotkeys.has(sound.hotkey)) {
        problems.push(`${where}: the hotkey is used twice.`)
      } else {
        hotkeys.add(sound.hotkey)
      }
    }
    if (sound?.file !== `${sound?.slug}.ogg`) {
      problems.push(`${where}: the file must be "<slug>.ogg" beside the manifest.`)
    }
    if (typeof sound?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sound.sha256)) {
      problems.push(`${where}: sha256 must be 64 lowercase hex digits.`)
    }
    if (sound?.licence !== STARTER_LICENCE) {
      problems.push(`${where}: the licence must be ${STARTER_LICENCE}.`)
    }
    if (typeof sound?.sourceUrl !== 'string' || !FREESOUND_PAGE.test(sound.sourceUrl)) {
      problems.push(`${where}: sourceUrl must be the freesound.org sound page.`)
    }
    if (typeof sound?.previewUrl !== 'string' || !FREESOUND_PREVIEW.test(sound.previewUrl)) {
      problems.push(`${where}: previewUrl must be the sound's freesound HQ preview.`)
    }
    if (typeof sound?.author !== 'string' || sound.author.length === 0) {
      problems.push(`${where}: the author is required.`)
    }
    if (typeof sound?.originalTitle !== 'string' || sound.originalTitle.length === 0) {
      problems.push(`${where}: the original title is required.`)
    }
    const maxSeconds = sound?.processing?.maxSeconds
    if (typeof maxSeconds !== 'number' || maxSeconds <= 0 || maxSeconds > STARTER_MAX_SECONDS) {
      problems.push(
        `${where}: processing.maxSeconds must be above 0 and at most ${STARTER_MAX_SECONDS}.`
      )
    }
  }
  return problems
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The ffmpeg arguments that turn a downloaded preview into the shipped file:
 * trim near-silence at both ends, cut to `maxSeconds` with a 300 ms fade when
 * the sound was longer, a 5 ms fade in and a 10 ms fade out so no edge clicks,
 * then Opus at 128 kb/s, 48 kHz stereo. Loudness is left alone on purpose:
 * the backend levels every sound at import, starters and the streamer's own
 * alike (plan 189 D5).
 */
export function encodeArguments({ input, output, durationSeconds, maxSeconds }) {
  const trim = 'silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.01'
  const filters = [trim, 'areverse', trim, 'areverse', 'afade=t=in:d=0.005']
  const kept = Math.min(durationSeconds, maxSeconds)
  if (durationSeconds > maxSeconds) {
    filters.push(`atrim=end=${maxSeconds}`, `afade=t=out:st=${(maxSeconds - 0.3).toFixed(3)}:d=0.3`)
  } else {
    filters.push(`afade=t=out:st=${Math.max(0, kept - 0.01).toFixed(3)}:d=0.01`)
  }
  return [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    filters.join(','),
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    // Reproducible bytes: no encoder tag or creation metadata.
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    output
  ]
}

/** LICENSES.md, generated from the manifest so the two never drift. */
export function licencesMarkdown(manifest) {
  const lines = [
    '# Starter sound licences',
    '',
    'Every starter sound Videorc ships is dedicated to the public domain under',
    '[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) by its author',
    'on Freesound. Videorc trims each one and re-encodes it to Opus',
    '(`pnpm sounds:build-starters`); the sounds are otherwise unchanged.',
    'Generated from `manifest.json`; do not edit by hand.',
    '',
    '| Sound | Author | Original title | Source |',
    '| ----- | ------ | -------------- | ------ |'
  ]
  for (const sound of manifest.sounds) {
    lines.push(`| ${sound.name} | ${sound.author} | ${sound.originalTitle} | ${sound.sourceUrl} |`)
  }
  return `${lines.join('\n')}\n`
}
