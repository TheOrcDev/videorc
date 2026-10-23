#!/usr/bin/env node
// Plan 189 S1: rebuild the starter sounds from their manifest.
//
//   pnpm sounds:build-starters            download every preview, re-encode, update sha256
//   pnpm sounds:build-starters -- airhorn only the named slugs
//
// Each row's `previewUrl` is the Freesound HQ preview of a CC0 sound; the
// licence was checked on its `sourceUrl` page when the row was added. The
// script needs network access and an ffmpeg with libopus
// (VIDEORC_STARTER_SOUNDS_FFMPEG, default `ffmpeg`). Downloads go to a fresh
// temporary directory and are only ever passed to ffmpeg as input files.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  STARTER_MANIFEST,
  STARTER_SOUNDS_DIR,
  encodeArguments,
  licencesMarkdown,
  manifestProblems,
  sha256Hex
} from './lib/starter-sounds.mjs'

const root = resolve(import.meta.dirname, '..')
const ffmpeg = process.env.VIDEORC_STARTER_SOUNDS_FFMPEG ?? 'ffmpeg'
const ffprobe = process.env.VIDEORC_STARTER_SOUNDS_FFPROBE ?? 'ffprobe'
const only = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('-')))

const manifestPath = join(root, STARTER_MANIFEST)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const downloads = mkdtempSync(join(tmpdir(), 'videorc-starter-sounds-'))

try {
  for (const sound of manifest.sounds) {
    if (only.size > 0 && !only.has(sound.slug)) continue
    const response = await fetch(sound.previewUrl, { headers: { 'User-Agent': 'videorc-build' } })
    if (!response.ok) {
      throw new Error(`${sound.slug}: download failed, HTTP ${response.status}`)
    }
    const input = join(downloads, `${sound.slug}.mp3`)
    writeFileSync(input, Buffer.from(await response.arrayBuffer()))
    const durationSeconds = Number(
      execFileSync(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        input
      ])
        .toString()
        .trim()
    )
    const output = join(root, STARTER_SOUNDS_DIR, sound.file)
    execFileSync(
      ffmpeg,
      encodeArguments({
        input,
        output,
        durationSeconds,
        maxSeconds: sound.processing.maxSeconds
      }),
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    sound.sha256 = sha256Hex(readFileSync(output))
    console.log(`${sound.slug}: ${sound.file} ${sound.sha256.slice(0, 12)}`)
  }
} finally {
  rmSync(downloads, { recursive: true, force: true })
}

const problems = manifestProblems(manifest)
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(root, STARTER_SOUNDS_DIR, 'LICENSES.md'), licencesMarkdown(manifest))
console.log(`Wrote ${STARTER_MANIFEST} and LICENSES.md`)
