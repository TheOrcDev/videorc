import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm, stat, readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const SHA256 = /^[0-9a-f]{64}$/

export class DownloadFileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DownloadFileError'
    this.code = code
  }
}

function requireDownload(condition, code, message) {
  if (!condition) throw new DownloadFileError(code, message)
}

export function uniqueHttpUrls(urls) {
  const seen = new Set()
  const unique = []
  for (const value of urls ?? []) {
    const url = String(value ?? '').trim()
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    unique.push(url)
  }
  return unique
}

export function ffmpegOrgMirrorUrls(url) {
  const source = String(url ?? '').trim()
  if (source.startsWith('https://ffmpeg.org/')) {
    return uniqueHttpUrls([source, source.replace('https://ffmpeg.org/', 'https://www.ffmpeg.org/')])
  }
  if (source.startsWith('https://www.ffmpeg.org/')) {
    return uniqueHttpUrls([source, source.replace('https://www.ffmpeg.org/', 'https://ffmpeg.org/')])
  }
  return uniqueHttpUrls([source])
}

export function sourceUrlsFromPin(pin) {
  const urls = uniqueHttpUrls([
    pin?.sourceUrl,
    ...(Array.isArray(pin?.sourceUrls) ? pin.sourceUrls : [])
  ])
  requireDownload(urls.length > 0, 'source-url', 'Pin is missing an https source URL.')
  return urls
}

export function parseSha256(value) {
  const sha256 = String(value ?? '').trim().toLowerCase()
  requireDownload(SHA256.test(sha256), 'sha256', 'Expected a lowercase 64-character SHA-256.')
  return sha256
}

export async function sha256OfFile(path, read = readFile) {
  return createHash('sha256').update(await read(path)).digest('hex')
}

export async function fileMatchesSha256(path, sha256, { statImpl = stat, sha256Of = sha256OfFile } = {}) {
  try {
    const info = await statImpl(path)
    if (!info.isFile() || info.size <= 0) return false
    return (await sha256Of(path)) === sha256
  } catch {
    return false
  }
}

export function nextRetryDelayMs(attempt, initialDelayMs = 2_000) {
  return Math.min(initialDelayMs * 2 ** Math.max(0, attempt - 1), 60_000)
}

export async function downloadFile({
  urls,
  destination,
  sha256,
  attempts = 5,
  initialDelayMs = 2_000,
  timeoutMs = 180_000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  writeResponse,
  sha256Of = sha256OfFile,
  matchesExisting = fileMatchesSha256
} = {}) {
  const expectedSha256 = parseSha256(sha256)
  const candidates = uniqueHttpUrls((urls ?? []).flatMap((url) => ffmpegOrgMirrorUrls(url)))
  requireDownload(candidates.length > 0, 'source-url', 'At least one https URL is required.')
  requireDownload(
    typeof destination === 'string' && destination.length > 0,
    'destination',
    'Download destination is required.'
  )

  if (await matchesExisting(destination, expectedSha256, { sha256Of })) {
    return { reused: true, destination, sha256: expectedSha256 }
  }

  const errors = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of candidates) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let response
        try {
          response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
        } finally {
          clearTimeout(timer)
        }
        requireDownload(
          response?.ok === true && response.body,
          'http',
          `download failed: HTTP ${response?.status ?? 'error'} for ${url}`
        )
        if (writeResponse) {
          await writeResponse(response, destination)
        } else {
          await writeFetchedBody(response, destination)
        }
        const actual = await sha256Of(destination)
        requireDownload(
          actual === expectedSha256,
          'checksum',
          `checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`
        )
        return { reused: false, url, attempt, destination, sha256: expectedSha256 }
      } catch (error) {
        errors.push(`${url} (attempt ${attempt}): ${error.message}`)
        await rm(`${destination}.partial`, { force: true }).catch(() => undefined)
      }
    }
    if (attempt < attempts) await sleep(nextRetryDelayMs(attempt, initialDelayMs))
  }

  throw new DownloadFileError(
    'exhausted',
    `Download failed after ${attempts} attempts:\n  - ${errors.join('\n  - ')}`
  )
}

async function writeFetchedBody(response, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.partial`
  await rm(partial, { force: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  await rename(partial, destination)
}
