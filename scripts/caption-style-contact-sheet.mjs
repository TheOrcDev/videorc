import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_CAPTION_STYLE_SHEET_DIR ??
    join(tmpdir(), `videorc-caption-style-sheets-${Date.now()}`)
)
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-caption-style-renderer-'))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const styles = [
  { id: 'classic', label: 'Classic' },
  { id: 'glass', label: 'Glass' },
  { id: 'lower-third', label: 'Lower third' },
  { id: 'high-contrast', label: 'High contrast' }
]
const sizes = [
  { width: 1280, height: 720, label: '720p' },
  { width: 1920, height: 1080, label: '1080p' },
  { width: 3840, height: 2160, label: '4K' },
  { width: 1080, height: 1920, label: 'Vertical' }
]
const backgrounds = [
  { id: 'light', source: (size) => `color=c=#e8e9ed:s=${size.width}x${size.height}:r=1` },
  { id: 'dark', source: (size) => `color=c=#17181d:s=${size.width}x${size.height}:r=1` },
  { id: 'motion', source: (size) => `testsrc2=s=${size.width}x${size.height}:r=1` }
]

mkdirSync(outputDirectory, { recursive: true })
const overlayDirectory = join(outputDirectory, 'overlays')
const previewDirectory = join(outputDirectory, 'previews')
mkdirSync(overlayDirectory, { recursive: true })
mkdirSync(previewDirectory, { recursive: true })

let launched
try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: stateRoot
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  const manifest = []

  for (const size of sizes) {
    const previews = []
    for (const style of styles) {
      const pngBase64 = await renderCaptionFrame(smoke, {
        styleId: style.id,
        canvasWidth: size.width,
        canvasHeight: size.height
      })
      const overlayPath = join(overlayDirectory, `${size.width}x${size.height}-${style.id}.png`)
      writeFileSync(overlayPath, Buffer.from(pngBase64, 'base64'))

      for (const background of backgrounds) {
        const previewPath = join(
          previewDirectory,
          `${size.width}x${size.height}-${style.id}-${background.id}.png`
        )
        compositePreview({
          background,
          label: `${style.label} / ${background.id}`,
          overlayPath,
          previewPath,
          size
        })
        previews.push(previewPath)
        manifest.push({
          background: background.id,
          height: size.height,
          label: size.label,
          overlayPath,
          previewPath,
          styleId: style.id,
          width: size.width
        })
      }
    }
    const sheetPath = join(
      outputDirectory,
      `caption-styles-${size.label.toLowerCase()}-${size.width}x${size.height}.png`
    )
    stackContactSheet(previews, sheetPath)
    console.log(`${size.label} caption style contact sheet: ${sheetPath}`)
  }

  const manifestPath = join(outputDirectory, 'caption-style-contact-sheet.json')
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        layout: {
          columns: backgrounds.map(({ id }) => id),
          rows: styles.map(({ id }) => id)
        },
        manifest
      },
      null,
      2
    )
  )
  console.log(
    `Caption style contact sheets PASS — exact renderer PNGs over light/dark/motion: ${outputDirectory}`
  )
} finally {
  await launched?.stop().catch(() => {})
  rmSync(stateRoot, { force: true, recursive: true })
}

async function renderCaptionFrame(smoke, params) {
  const response = await smokeCommand(smoke, 'eval-js', {
    code: `
      const { renderCaptionCueFramePng } = await import('/src/lib/caption-overlay.ts');
      return renderCaptionCueFramePng({
        text: 'Captions stay clear while the conversation keeps moving.',
        canvasWidth: Number(params.canvasWidth),
        canvasHeight: Number(params.canvasHeight),
        position: 'bottom',
        textSize: 'm',
        styleId: String(params.styleId)
      });
    `,
    ...params
  })
  const pngBase64 = response?.result
  if (typeof pngBase64 !== 'string' || pngBase64.length < 32) {
    throw new Error(`Renderer did not produce a PNG for ${params.styleId}.`)
  }
  return pngBase64
}

function compositePreview({ background, overlayPath, previewPath, size }) {
  const filter = [
    '[0:v][1:v]overlay=0:0:format=auto',
    'scale=w=480:h=420:force_original_aspect_ratio=decrease',
    'pad=480:480:(ow-iw)/2:(oh-ih)/2:color=#0b0b0d'
  ].join(',')
  execFileSync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      background.source(size),
      '-i',
      overlayPath,
      '-filter_complex',
      filter,
      '-frames:v',
      '1',
      previewPath
    ],
    { stdio: 'inherit' }
  )
}

function stackContactSheet(previews, sheetPath) {
  if (previews.length !== styles.length * backgrounds.length) {
    throw new Error(`Expected 12 caption previews, got ${previews.length}.`)
  }
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const preview of previews) args.push('-i', preview)
  const layout = previews
    .map((_, index) => `${(index % 3) * 480}_${Math.floor(index / 3) * 480}`)
    .join('|')
  args.push(
    '-filter_complex',
    `${previews.map((_, index) => `[${index}:v]`).join('')}xstack=inputs=${previews.length}:layout=${layout}:fill=#0b0b0d[out]`,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    sheetPath
  )
  execFileSync(ffmpegPath, args, { stdio: 'inherit' })
}

async function smokeCommand(smoke, command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${smoke.capability}`
    },
    body: JSON.stringify({ command, params }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}
