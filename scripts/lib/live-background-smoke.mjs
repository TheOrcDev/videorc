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
