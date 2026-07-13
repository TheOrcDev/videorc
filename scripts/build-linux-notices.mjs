#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const outputPath = resolve(process.argv[2] || 'apps/desktop/release/THIRD-PARTY-NOTICES.txt')
const sourcePath = resolve(process.cwd(), 'vendor', 'ffmpeg', 'current', 'NOTICE.txt')
const licensePath = resolve(process.cwd(), 'vendor', 'ffmpeg', 'current', 'LICENSE.txt')
const sourceInfoPath = resolve(process.cwd(), 'vendor', 'ffmpeg', 'current', 'SOURCE.txt')
const buildConfigPath = resolve(process.cwd(), 'vendor', 'ffmpeg', 'current', 'BUILD-CONFIG.txt')

const ffmpegNotices = []
if (existsSync(sourcePath)) {
  ffmpegNotices.push(readFileSync(sourcePath, 'utf8').trim())
}
if (existsSync(licensePath)) {
  ffmpegNotices.push(`\nSource license file: LICENSE.txt\n` + readFileSync(licensePath, 'utf8').trim())
}
if (existsSync(sourceInfoPath)) {
  ffmpegNotices.push(`\nSource and build metadata:\n${readFileSync(sourceInfoPath, 'utf8').trim()}`)
}
if (existsSync(buildConfigPath)) {
  ffmpegNotices.push(`\nBuild configuration:\n${readFileSync(buildConfigPath, 'utf8').trim()}`)
}

const fallback = [
  'THIRD-PARTY-NOTICES.txt',
  '',
  'No packaged FFmpeg notice files were discoverable at build time.',
  'The project still includes source and license files in vendor/ffmpeg/current for audit.',
  `Generated at: ${new Date().toISOString()}`
]

const content = [
  'Videorc Linux third-party notices',
  'Includes bundled FFmpeg notices and configured build artifacts when available.',
  '',
  ...ffmpegNotices,
  '',
  ...fallback
].join('\n')

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${content}\n`, 'utf8')
console.log(`linux-notices: wrote ${outputPath}`)
