// Which microphone route a Windows dev app's Record takes.
//
// The packaged app runs its microphone through `ffmpeg-capture.exe`, the
// capture worker beside the bundled FFmpeg: the worker feeds the session audio
// bus, the Clips session hands the open microphone over to Record (#1228),
// and Record's FFmpeg reads one PCM pipe. Without that worker the backend
// falls back to FFmpeg's own DirectShow input (`-f dshow -i audio=…`), which
// FFmpeg opens before it reaches the video pipe on every start: about
// 0.45 s standalone and 0.55-0.85 s inside a Record on an Intel UHD 620 laptop
// (docs/acceptance/2026-11-11-windows-record-ffmpeg-fifo-open.md). A latency
// number measured on that fallback is not the shipped start.
//
// This mirrors how the dev app finds the worker: Electron main passes
// `<workspace>/vendor/ffmpeg/windows-x64/bin/ffmpeg.exe` as the bundled
// FFmpeg only when that file exists (`resolvePackagedFfmpegBinDir`), otherwise
// the backend runs `ffmpeg` from PATH; the backend then looks for the worker
// as that path's sibling (`audio_capture_adapter::windows_worker_path`), which
// a bare `ffmpeg` never has.

import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export const WINDOWS_CAPTURE_WORKER_FILE = 'ffmpeg-capture.exe'
export const WINDOWS_WORKER_FALLBACK_HEALTH_CODE = 'microphone-capture-worker-fallback'

/**
 * @param {string} workspaceRoot the checkout the dev app runs from
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {{ route: 'capture-worker' | 'directshow', bundledFfmpeg: string | null, worker: string, reason: string | null }}
 */
export function windowsDevMicrophoneRoute(workspaceRoot, { exists = existsSync } = {}) {
  const binDir = win32.join(workspaceRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin')
  const bundledFfmpeg = win32.join(binDir, 'ffmpeg.exe')
  const worker = win32.join(binDir, WINDOWS_CAPTURE_WORKER_FILE)
  if (!exists(bundledFfmpeg)) {
    return {
      route: 'directshow',
      bundledFfmpeg: null,
      worker,
      reason: `${bundledFfmpeg} is missing, so the backend runs \`ffmpeg\` from PATH, which has no capture worker beside it`
    }
  }
  if (!exists(worker)) {
    return {
      route: 'directshow',
      bundledFfmpeg,
      worker,
      reason: `${worker} is missing beside the bundled FFmpeg`
    }
  }
  return { route: 'capture-worker', bundledFfmpeg, worker, reason: null }
}

/** Starts whose capture worker failed and fell back to DirectShow. */
export function workerFallbackCount(events) {
  return events.filter(
    (record) =>
      record.event === 'health.event' &&
      record.payload?.code === WINDOWS_WORKER_FALLBACK_HEALTH_CODE
  ).length
}

/**
 * One line for the smoke log, naming what the run measured. Pass
 * `workerFallbacks` once the run is over: a present worker that failed to
 * start fell back to DirectShow for those sessions.
 */
export function describeWindowsMicrophoneRoute(route) {
  if (route.route === 'capture-worker' && route.workerFallbacks > 0) {
    return `microphone route: capture worker present (${route.worker}), but ${route.workerFallbacks} session start(s) FELL BACK to FFmpeg DirectShow (${WINDOWS_WORKER_FALLBACK_HEALTH_CODE}), so this run did not measure only the packaged app's path`
  }
  if (route.route === 'capture-worker') {
    return `microphone route: capture worker (${route.worker}), the packaged app's path`
  }
  return `microphone route: FFmpeg DirectShow FALLBACK, not the packaged app's path: ${route.reason}. FFmpeg opens the microphone before the video pipe on every start, which adds about 0.5 s; provision the worker (docs/windows-dev-loop.md, "Record latency on Windows") to measure the shipped start`
}
