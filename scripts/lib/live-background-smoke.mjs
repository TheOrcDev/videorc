// Plan 190/203 (fix plan 0007): who reports the idle preview's live
// background, for `smoke-live-background-app.mjs`. On macOS the Metal
// compositor draws it in the idle preview, so `compositor.status.liveBackground`
// carries it. On Linux the idle CPU compositor composes no pixels: the
// Electron proof surface draws the background in WebGL2 and reports its own
// state, and the compositor draws (and reports) it only while a session
// composes frames (docs/live-backgrounds.md, Linux "Lifecycle").

/** Who reports the idle preview's live background on this platform. */
export function idlePreviewLiveBackgroundReporter(platform) {
  return platform === 'linux' ? 'proof-surface' : 'compositor'
}

/**
 * The proof surface's poster reasons that come from the host's Chromium, not
 * from the app: no WebGL2 context at all, or only a software one (SwiftShader).
 */
export const PROOF_SURFACE_HOST_STILL_REASONS = Object.freeze(['no-gpu', 'software-gpu'])

/** The launch turned Chromium's GPU off (`gpu-fallback.ts`'s explicit switches). */
export function chromiumGpuDisabled(env) {
  return env.VIDEORC_DISABLE_GPU === '1' || env.VIDEORC_SMOKE_DISABLE_ELECTRON_GPU === '1'
}

/**
 * The proof surface's verdict on a case: `shader` when it moves, `host-still`
 * when it shows the poster because the host's Chromium has no usable GPU,
 * `failed` for any other poster, or null while it starts or still reports
 * another case. A host still passes only when the launch turned Chromium's
 * GPU off on purpose; otherwise the preview must move.
 */
export function proofSurfaceLiveBackgroundVerdict(liveBackground, { id, look }, { gpuDisabled }) {
  if (!liveBackground || liveBackground.id !== id || liveBackground.look !== look) return null
  if (liveBackground.rendering === 'shader') return 'shader'
  if (liveBackground.rendering !== 'still') return null
  return gpuDisabled && PROOF_SURFACE_HOST_STILL_REASONS.includes(liveBackground.reason)
    ? 'host-still'
    : 'failed'
}

/** The scene still carries the case's background (the app did not displace it). */
export function sceneCarriesBackground(status, assetId) {
  return (status?.sceneSources ?? []).some(
    (source) => source.kind === 'background-image' && source.id === `background-image:${assetId}`
  )
}

/**
 * No live background drawn by the compositor: no status, programs or scratch.
 * The idle Linux preview composes none, and a stopped session leaves none.
 */
export function compositorDrawsNoLiveBackground(status) {
  return (
    status?.liveBackground === undefined &&
    (status?.framePipeline?.liveBackgroundPrograms ?? 0) === 0 &&
    (status?.framePipeline?.liveBackgroundScratchBytes ?? 0) === 0
  )
}

/**
 * The idle Linux preview after a take: `clear` when the scene still carries
 * the case's background and the compositor reports none (the stopped take
 * took its status down), `stale` while it still reports one, and `displaced`
 * when the app re-committed a scene without the background, which clears any
 * status by itself and so proves nothing.
 */
export function afterTakeLiveBackgroundState(status, assetId) {
  if (!sceneCarriesBackground(status, assetId)) return 'displaced'
  return compositorDrawsNoLiveBackground(status) ? 'clear' : 'stale'
}

/**
 * The take's status samples (from the first that reports) that name another
 * background, or, forced, give a reason other than `forced`. On Linux the
 * take is where the compositor's own report is checked; its idle preview has
 * none.
 */
export function liveBackgroundSampleMismatches(samples, { id, forced }) {
  return samples.filter(
    (sample) =>
      sample.liveBackground?.id !== id || (forced && sample.liveBackground?.reason !== 'forced')
  )
}

/**
 * The take's microphone: the debug fixture microphone (CoreAudio id
 * `u32::MAX`, `CAPTION_CONTRACT_TEST_DEVICE_ID`) except on Linux, where that
 * id names no microphone. A Linux take records the paced-silence bus, so it
 * selects none and the analyzer's silent-microphone gate (issue 1064) knows.
 */
export function smokeMicrophoneId(platform) {
  return platform === 'linux' ? undefined : 'microphone:coreaudio:4294967295'
}

/**
 * The app env the take's microphone needs. The fixture id is the backend's
 * synthetic microphone: a debug backend opens it only with
 * VIDEORC_CAPTION_CONTRACT_TEST=1 (audio.rs `start_native_audio_source`), and
 * it sends a continuous tone only with VIDEORC_LIVE_SOURCE_SWITCH_TEST=1;
 * otherwise it is silent unless a test injects audio, so the take's audio
 * check failed as digital silence (refused without the first flag, silent
 * without the second). The same pair smoke:banners and smoke:html-overlay set.
 * The smoke sets them itself so it never depends on the caller's shell.
 */
export function smokeMicrophoneEnv(platform) {
  return smokeMicrophoneId(platform)
    ? { VIDEORC_CAPTION_CONTRACT_TEST: '1', VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1' }
    : {}
}

/**
 * Squares around the stage margin (Visibility 20: 10 % a side), each square
 * on a 16:9 frame. The first is the smoke's long-standing ring square. A
 * sparse background (Ghost Fibers' dots on black, 2026-11-26) can leave any
 * one of them black for a whole take, so a still-looking ring is judged on
 * the busiest square before it fails.
 */
export const RING_SQUARES = Object.freeze([
  { name: 'left', rect: { x: 0.015, y: 0.4, w: 0.06, h: 0.1067 } },
  { name: 'right', rect: { x: 0.925, y: 0.4, w: 0.06, h: 0.1067 } },
  { name: 'top', rect: { x: 0.4775, y: 0.01, w: 0.045, h: 0.08 } },
  { name: 'bottom', rect: { x: 0.4775, y: 0.91, w: 0.045, h: 0.08 } },
  { name: 'top-left', rect: { x: 0.01, y: 0.01, w: 0.045, h: 0.08 } },
  { name: 'top-right', rect: { x: 0.945, y: 0.01, w: 0.045, h: 0.08 } },
  { name: 'bottom-left', rect: { x: 0.01, y: 0.91, w: 0.045, h: 0.08 } },
  { name: 'bottom-right', rect: { x: 0.945, y: 0.91, w: 0.045, h: 0.08 } }
])

/**
 * A square's mean frame-to-frame change (64 × 64, five a second) above which
 * a sparse ring moves. A still margin measures 0.00–0.01; Ghost Fibers' dots
 * in their busiest square 0.53–0.76 on the takes that failed the old check.
 */
export const SPARSE_RING_MOTION = 0.3

/** The busiest of `[{name, rect, motion}]`: the first of the highest. */
export function busiestRingSquare(measured) {
  let busiest = null
  for (const square of measured) {
    if (!Number.isFinite(square.motion)) continue
    if (!busiest || square.motion > busiest.motion) busiest = square
  }
  return busiest
}

/** Q186: timing is diagnostic; an animated Half is allowed, a poster is not. */
export function liveBackgroundContinuityFailures(
  samples,
  { forced = false, guardReports = [] } = {}
) {
  const allowed = forced ? ['still'] : ['shader', 'half']
  const failures = []
  if (samples.length === 0) failures.push('no live background samples')
  for (const [index, sample] of samples.entries()) {
    if (!allowed.includes(sample.liveBackground?.rendering)) {
      failures.push(
        `sample ${index} left ${allowed.join('/')}: ${JSON.stringify(sample.liveBackground)}`
      )
    }
  }
  if (
    !forced &&
    guardReports.some(({ before, after }) => before === 'Still' || after === 'Still')
  ) {
    failures.push('the guard reached Still (poster), even if it later recovered')
  }
  return failures
}

/** Existing backend transition logs carry p50; the pinned status protocol only has p95. */
export function parseLiveBackgroundGuardReport(line) {
  const match =
    /live background (?:Some\()?([A-Za-z]+)\)? at (\d+)x(\d+): guard (Full|Half|Still) -> (Full|Half|Still) \(median ([\d.]+|NaN) ms, p95 ([\d.]+|NaN) ms, (\d+) frames/.exec(
      line
    )
  if (!match) return null
  return {
    id: match[1].replace(/[A-Z]/g, (letter, index) => (index ? '-' : '') + letter.toLowerCase()),
    width: Number(match[2]),
    height: Number(match[3]),
    before: match[4],
    after: match[5],
    p50Ms: Number.isFinite(Number(match[6])) ? Number(match[6]) : null,
    p95Ms: Number.isFinite(Number(match[7])) ? Number(match[7]) : null,
    frames: Number(match[8])
  }
}

/** Do not manufacture a median from p95 polls; name unavailable diagnostics explicitly. */
export function liveBackgroundTimingSummary(liveBackground, guardReports, referenceMs) {
  const report = guardReports.findLast((item) => item.p50Ms !== null)
  return {
    p50Ms: report?.p50Ms ?? null,
    p50Source: report
      ? 'last guard transition window'
      : 'unavailable: status exposes p95 only; no guard transition',
    p95Ms: Number.isFinite(liveBackground?.p95Ms) ? liveBackground.p95Ms : null,
    p95Source: 'last status window',
    referenceMs,
    timingGated: false
  }
}
