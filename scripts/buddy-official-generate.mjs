#!/usr/bin/env node
// Plan 170 Phase B: draws Videorc's official Buddy characters in the house
// look through the Vercel AI Gateway and exports them for the app.
//
//   pnpm buddy:official --slug all                 # every generated character, all four poses
//   pnpm buddy:official --slug orc --states laugh  # redo one pose of one character
//   pnpm buddy:official --slug all --export-only   # re-export the committed masters
//
// Options: --anchor <png> (the style anchor; default: the Buddy master
// trimmed onto a 1024 px transparent canvas, the same as videorc-web
// lib/ai/buddy-look/style-reference.png), --model <id>.
//
// The key comes from AI_GATEWAY_API_KEY or ~/.config/videorc/ai-gateway-key
// and is never printed. Masters land in assets/brand/buddy/official/<slug>/
// (1024 px PNG, outside every bundle); exports in
// apps/desktop/src/renderer/src/assets/buddy/official/<slug>/ (WebP, scaled
// so the idle is as tall as the default Buddy's). The owner
// reviews every set before it ships. CI never runs this.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EDIT_STATES,
  buildCreatePrompt,
  buildStatePrompt,
  officialPaths,
  parseArgs,
  readCatalog
} from './lib/buddy-official.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATEWAY = 'https://ai-gateway.vercel.sh/v1/images/edits'
const TIMEOUT_MS = 180_000

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

function takeAnchorArg(argv) {
  const index = argv.indexOf('--anchor')
  if (index === -1) return { argv, anchor: null }
  const anchor = argv[index + 1]
  if (!anchor) throw new Error('--anchor needs a path.')
  return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], anchor: resolve(anchor) }
}

function buildDefaultAnchor(workDir) {
  const out = join(workDir, 'style-reference.png')
  execFileSync('magick', [
    join(repoRoot, 'assets/brand/buddy/golem-master.png'),
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
    out
  ])
  return out
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`

async function editImage({ key, model, prompt, images }) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now()
    try {
      const response = await fetch(GATEWAY, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size: '1024x1024',
          response_format: 'b64_json',
          images: images.map((path) => ({ image_url: dataUrl(path) })),
          providerOptions: { openai: { background: 'transparent', output_format: 'png' } }
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      const text = await response.text()
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429
        console.error(
          `  gateway ${response.status} after ${Date.now() - started} ms: ${text.slice(0, 200)}`
        )
        if (retryable && attempt === 1) continue
        throw new Error(`AI Gateway answered ${response.status}`)
      }
      const b64 = JSON.parse(text)?.data?.[0]?.b64_json
      if (!b64) throw new Error('The AI Gateway returned no image.')
      return { png: Buffer.from(b64, 'base64'), ms: Date.now() - started }
    } catch (error) {
      if (attempt === 1 && (error.name === 'TimeoutError' || error.cause)) {
        console.error(`  ${error.message}; retrying once`)
        continue
      }
      throw error
    }
  }
  throw new Error('unreachable')
}

/**
 * The character's height inside the default Buddy's idle: default/idle.webp
 * is 640 px tall including its 2 % pad on each side, so the buddy is 615 px.
 */
const IDLE_EXPORT_HEIGHT = 615

/** How tall the character in a master is, after the haze is cleared and the frame trimmed. */
function trimmedHeight(masterPath) {
  const out = execFileSync('magick', [
    masterPath,
    '-channel',
    'A',
    '-fx',
    'u<0.06?0:u',
    '+channel',
    '-trim',
    '-format',
    '%h',
    'info:'
  ])
  return Number(out.toString().trim())
}

/**
 * Every pose of a character is scaled by one factor, the one that makes its
 * idle IDLE_EXPORT_HEIGHT tall, so all four stand at the same size (a
 * raised arm may make a pose taller) and every official character matches
 * the default Buddy's size on stream.
 */
function exportWebp(masterPath, webpPath, workDir, scalePercent) {
  const trimmed = join(workDir, 'export.png')
  execFileSync('magick', [
    masterPath,
    '-channel',
    'A',
    '-fx',
    'u<0.06?0:u',
    '+channel',
    '-resize',
    `${scalePercent}%`,
    '-background',
    'none',
    '-trim',
    '+repage',
    '-bordercolor',
    'none',
    '-border',
    '2%',
    trimmed
  ])
  mkdirSync(dirname(webpPath), { recursive: true })
  execFileSync('cwebp', ['-quiet', '-q', '90', '-alpha_q', '100', trimmed, '-o', webpPath])
}

async function main() {
  const { argv, anchor } = takeAnchorArg(process.argv.slice(2))
  const catalog = readCatalog(repoRoot)
  const options = parseArgs(argv, catalog)
  const workDir = mkdtempSync(join(tmpdir(), 'buddy-official-'))
  try {
    const key = options.exportOnly ? null : readKey()
    const anchorPath = options.exportOnly ? null : (anchor ?? buildDefaultAnchor(workDir))
    for (const slug of options.slugs) {
      const entry = catalog.find((candidate) => candidate.slug === slug)
      const paths = officialPaths(slug)
      mkdirSync(join(repoRoot, paths.masterDir), { recursive: true })
      if (!options.exportOnly) {
        if (options.states.includes('idle')) {
          console.log(`${slug}: drawing idle`)
          const idle = await editImage({
            key,
            model: options.model,
            prompt: buildCreatePrompt(entry.description),
            images: [anchorPath]
          })
          writeFileSync(join(repoRoot, paths.master('idle')), idle.png)
          console.log(`${slug}: idle in ${idle.ms} ms`)
        }
        const idleMaster = join(repoRoot, paths.master('idle'))
        if (!existsSync(idleMaster)) throw new Error(`${slug} has no idle master to edit.`)
        const edits = EDIT_STATES.filter((state) => options.states.includes(state))
        const results = await Promise.allSettled(
          edits.map(async (state) => {
            const made = await editImage({
              key,
              model: options.model,
              prompt: buildStatePrompt(state),
              images: [idleMaster]
            })
            writeFileSync(join(repoRoot, paths.master(state)), made.png)
            console.log(`${slug}: ${state} in ${made.ms} ms`)
          })
        )
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(
              `${slug}: ${edits[index]} FAILED: ${result.reason?.message ?? result.reason}`
            )
            process.exitCode = 1
          }
        })
      }
      const idleHeight = trimmedHeight(join(repoRoot, paths.master('idle')))
      const scalePercent = ((IDLE_EXPORT_HEIGHT / idleHeight) * 100).toFixed(2)
      for (const state of options.states) {
        const master = join(repoRoot, paths.master(state))
        if (!existsSync(master)) continue
        exportWebp(master, join(repoRoot, paths.appWebp(state)), workDir, scalePercent)
      }
      console.log(`${slug}: exported ${options.states.join(', ')} at ${scalePercent}%`)
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
