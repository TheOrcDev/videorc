import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { measureAvSync } from '../../lib/av-sync.mjs'
import { analyzeRecording } from '../../lib/recording-analyzer.mjs'

// Plan 178 U8 (plan 176 L4 step 3, plan 166 S7 step 2). Records N seconds of
// the lab channel's own live output as YouTube serves it, then runs the
// recording analyzer (freezes, audio gaps) and the flash+click A/V sync
// measurement on it. The analysis JSON is kept; the media is deleted unless
// the analysis shows an incident. Media never lands inside the repo.
//
// How: `yt-dlp -g` resolves the live HLS URL (from the live edge, not from
// the start), then `ffmpeg -t N -c copy` records it. yt-dlp's
// `--download-sections` does not apply to a live stream, and a plain yt-dlp
// live download has no duration limit.
//
// Terms gate: pulling is allowed only for a broadcast of the lab's own
// channel, checked through the broadcaster's API (`isOwnVideo`) before any
// download, and only while `clipPull` is true. See plan 178 U8's note for the
// YouTube Terms of Service finding; the owner's policy decides `clipPull`.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const DEFAULT_CLIP_SECONDS = 120
// Plan 166's public output thresholds.
export const CLIP_THRESHOLDS = Object.freeze({
  maxFreezeMs: 1000,
  maxAudioGapMs: 100,
  maxAvOffsetMs: 150
})

/** Pure: the YouTube video id in a watch, live, youtu.be or shorts URL. */
export function videoIdFromUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname.replace(/^(www\.|m\.)/, '')
  if (host === 'youtu.be') return parsed.pathname.slice(1).split('/')[0] || null
  if (host !== 'youtube.com') return null
  const v = parsed.searchParams.get('v')
  if (v) return v
  const match = parsed.pathname.match(/^\/(live|shorts|embed)\/([A-Za-z0-9_-]{6,})/)
  return match ? match[2] : null
}

/** Pure: true when `dir` is the repo or anywhere inside it. */
export function isInsideRepo(dir, repoRoot = REPO_ROOT) {
  const rel = relative(resolve(repoRoot), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Pure: yt-dlp args that print the live HLS URL(s), from the live edge. */
export function ytDlpUrlArgs(url) {
  return [
    '--no-live-from-start',
    '--no-playlist',
    '--no-warnings',
    '-f',
    'best[protocol^=m3u8]/best',
    '-g',
    url
  ]
}

/** Pure: ffmpeg args that record `seconds` of one muxed or two split inputs. */
export function ffmpegRecordArgs(inputs, seconds, outPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  for (const input of inputs) args.push('-i', input)
  if (inputs.length === 2) args.push('-map', '0:v:0', '-map', '1:a:0')
  args.push('-t', String(seconds), '-c', 'copy', '-f', 'mpegts', outPath)
  return args
}

/** Pure: plan 166 incident rules over the clip analysis summary. */
export function clipIncidents(summary, thresholds = CLIP_THRESHOLDS) {
  const incidents = []
  const raise = (type, detail) => incidents.push({ type, signature: type, severity: 'P1', detail })
  if (!summary.hasVideo) raise('clip:no-video', 'The pulled clip has no video stream.')
  if ((summary.longestFreezeMs ?? 0) > thresholds.maxFreezeMs) {
    raise(
      'clip:freeze',
      `Freeze of ${Math.round(summary.longestFreezeMs)} ms in the public output (limit ${thresholds.maxFreezeMs} ms).`
    )
  }
  if ((summary.maxAudioGapMs ?? 0) > thresholds.maxAudioGapMs) {
    raise(
      'clip:audio-gap',
      `Audio gap of ${Math.round(summary.maxAudioGapMs)} ms in the public output (limit ${thresholds.maxAudioGapMs} ms).`
    )
  }
  if (summary.avOffsetMs != null && Math.abs(summary.avOffsetMs) > thresholds.maxAvOffsetMs) {
    raise(
      'clip:av-offset',
      `A/V offset ${Math.round(summary.avOffsetMs)} ms in the public output (limit ${thresholds.maxAvOffsetMs} ms).`
    )
  }
  return incidents
}

/**
 * Analyzes a clip with the repo's recording analyzer and A/V sync
 * measurement (both injectable for tests). A failed A/V measurement (no
 * flash/click pairs) is recorded, not an incident: the clip may not show
 * the test card's flash at all.
 */
export async function analyzeClip(
  path,
  {
    analyze = analyzeRecording,
    measureSync = measureAvSync,
    thresholds = CLIP_THRESHOLDS,
    ffmpegPath,
    ffprobePath
  } = {}
) {
  const report = await analyze(path, { ffmpegPath, ffprobePath })
  let sync = null
  let syncError = null
  try {
    sync = await measureSync(path, { ffmpegPath })
  } catch (error) {
    syncError = error.message
  }
  const metrics = report.metrics ?? {}
  const summary = {
    hasVideo: metrics.hasVideo === true,
    hasAudio: metrics.hasAudio === true,
    durationSeconds: metrics.durationSeconds ?? null,
    width: metrics.width ?? null,
    height: metrics.height ?? null,
    avgFps: metrics.avgFps ?? null,
    // The test card always moves, so raw freezedetect is the right signal
    // here (YouTube's re-encode makes exact-repeat corroboration unreliable).
    longestFreezeMs: metrics.longestFreezeMs ?? null,
    freezeCount: metrics.freezeCount ?? null,
    maxAudioGapMs: metrics.maxAudioGapMs ?? null,
    longestSilenceMs: metrics.longestSilenceMs ?? null,
    avOffsetMs: sync?.medianOffsetMs ?? null,
    avPairs: Array.isArray(sync?.pairs) ? sync.pairs.length : 0,
    avSyncError: syncError ?? (sync && sync.medianOffsetMs == null ? 'no flash/click pairs' : null),
    analyzerFailures: report.verdict?.failures ?? [],
    analyzerWarnings: report.verdict?.warnings ?? []
  }
  return { summary, incidents: clipIncidents(summary, thresholds) }
}

/** Default runner: spawns an owned child, bounded by `timeoutMs`. */
export function spawnRunner(command, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => (stdout += text))
    child.stderr.on('data', (text) => (stderr = (stderr + text).slice(-8000)))
    let killTimer = null
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      rejectRun(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolveRun({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr })
    })
  })
}

function compactStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/**
 * Records and analyzes one clip of the lab channel's own live stream.
 * @returns {Promise<{status: 'analyzed'|'skipped'|'failed', reason?: string,
 *   videoId?: string, clipPath?: string|null, analysisPath?: string,
 *   summary?: object, incidents?: object[], kept?: boolean}>}
 */
export async function pullClip({
  url,
  seconds = DEFAULT_CLIP_SECONDS,
  outDir,
  runner = spawnRunner,
  clipPull = true,
  isOwnVideo,
  keepOnIncident = true,
  analyze = analyzeClip,
  ytDlpPath = 'yt-dlp',
  ffmpegPath = 'ffmpeg',
  now = () => new Date()
}) {
  if (!clipPull) return { status: 'skipped', reason: 'clip-pull-disabled' }
  const videoId = videoIdFromUrl(url)
  if (!videoId) return { status: 'skipped', reason: 'not-a-youtube-video-url' }
  if (!outDir) throw new Error('pullClip needs an outDir outside the repo.')
  if (isInsideRepo(outDir)) {
    throw new Error('pullClip refuses an outDir inside the repo: media is never written there.')
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error('seconds must be between 1 and 600.')
  }
  if (typeof isOwnVideo !== 'function') {
    return { status: 'skipped', reason: 'ownership-unverified', videoId }
  }
  let own = false
  try {
    own = await isOwnVideo(videoId)
  } catch (error) {
    return { status: 'skipped', reason: 'ownership-check-failed', videoId, detail: error.message }
  }
  if (!own) return { status: 'skipped', reason: 'not-own-video', videoId }

  await mkdir(outDir, { recursive: true, mode: 0o700 })
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  const resolved = await runner(ytDlpPath, ytDlpUrlArgs(watchUrl), { timeoutMs: 60_000 })
  const inputs = String(resolved.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
  if (resolved.code !== 0 || inputs.length === 0 || inputs.length > 2) {
    // The HLS URL is signed: report only the exit code and a short stderr tail.
    return {
      status: 'failed',
      reason: 'no-live-url',
      videoId,
      detail: `yt-dlp exit ${resolved.code}, ${inputs.length} URL(s): ${String(
        resolved.stderr ?? ''
      )
        .trim()
        .slice(-300)}`
    }
  }

  const stamp = compactStamp(now())
  const clipPath = join(outDir, `clip-${videoId}-${stamp}.ts`)
  const analysisPath = join(outDir, `clip-${videoId}-${stamp}.analysis.json`)
  const recorded = await runner(ffmpegPath, ffmpegRecordArgs(inputs, seconds, clipPath), {
    timeoutMs: seconds * 1000 + 90_000
  })
  if (recorded.code !== 0 || !existsSync(clipPath) || statSync(clipPath).size === 0) {
    await rm(clipPath, { force: true })
    return {
      status: 'failed',
      reason: 'record-failed',
      videoId,
      detail: `ffmpeg exit ${recorded.code}: ${String(recorded.stderr ?? '')
        .replace(/https?:\/\/\S+/g, '<url>')
        .trim()
        .slice(-300)}`
    }
  }

  let analysis
  try {
    analysis = await analyze(clipPath, { ffmpegPath })
  } catch (error) {
    await rm(clipPath, { force: true })
    return { status: 'failed', reason: 'analysis-failed', videoId, detail: error.message }
  }
  const kept = keepOnIncident && analysis.incidents.length > 0
  if (!kept) await rm(clipPath, { force: true })
  const record = {
    schemaVersion: 1,
    videoId,
    recordedAt: now().toISOString(),
    seconds,
    inputs: inputs.length,
    clipKept: kept,
    clipFile: kept ? clipPath : null,
    summary: analysis.summary,
    incidents: analysis.incidents
  }
  await writeFile(analysisPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return {
    status: 'analyzed',
    videoId,
    clipPath: kept ? clipPath : null,
    analysisPath,
    summary: analysis.summary,
    incidents: analysis.incidents,
    kept
  }
}
