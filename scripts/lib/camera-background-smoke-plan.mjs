// Plan 258 S2/S3: the shape of `pnpm smoke:camera-background`, pure for its
// tests.
//
// Every output a camera background must reach is listed here once. The dev
// app judges the ones it can produce; the rest carry the slice or the owner
// check that covers them and why the dev app cannot, so a run always says
// which outputs it vouched for and never passes one silently.
import { EXPECT_ROOM_HIDDEN, EXPECT_ROOM_VISIBLE } from './camera-background-leak.mjs'

/** Every output, in report order. `pending` names the slice that adds it. */
export const CAMERA_BACKGROUND_OUTPUTS = Object.freeze([
  { id: 'recording', label: 'Recording' },
  { id: 'stream-horizontal', label: 'Stream (horizontal leg)' },
  { id: 'stream-vertical', label: 'Stream (vertical leg)' },
  { id: 'clip', label: 'Clips save' },
  { id: 'camera-file', label: 'Camera file (separate source recordings)' },
  { id: 'preview', label: 'Preview' },
  {
    id: 'videorc-camera',
    label: 'Videorc Camera',
    pending:
      'S3: Videorc Camera exists only in the signed app in /Applications (plan 214); the dev app has no camera extension to read back. Owed by the owner: smoke:virtual-camera against the packaged, signed app with a real camera and an effect on, and a by-eye check at enable and camera switch.'
  },
  {
    id: 'room',
    label: 'Talk-show room',
    pending:
      "S8: in a room the renderer owns the camera through getUserMedia (plan 224 D6), so the backend's fixture camera never reaches it. S8 feeds the same fixture to Chromium's fake camera and scans the published track."
  }
])

export const EFFECTS = Object.freeze(['off', 'slight-blur', 'strong-blur', 'image', 'all'])

/** The bundled picture the image pass puts behind the figure (Podcast). */
export const IMAGE_ASSET_ID = 'builtin-bg-06'

/**
 * The passes a run makes, in order. `all` is the S3 gate: Off first (the
 * detector still sees the room), then each effect-on pass.
 * - strong-blur, slight-blur, image: one session on every output.
 * - stall: the segment worker held mid-recording; the cover must take over
 *   within D6's budget and the recording never shows the room.
 * - camera-switch-record: the camera stopped and started again with the
 *   effect on (a new camera store), Record pressed at once; every frame
 *   from the first is scanned.
 * - relaunch: the app quit and started again on the same profile, the
 *   camera started with the effect on and Record pressed; every frame scanned.
 */
export function passesFor(effect) {
  if (effect === 'all') {
    return ['off', 'strong-blur', 'image', 'stall', 'camera-switch-record', 'relaunch']
  }
  return [effect]
}

/** The passes that run a full session on every output. */
export function isFullPass(pass) {
  return ['off', 'slight-blur', 'strong-blur', 'image'].includes(pass)
}

/** The camera's background for a pass (`null` for Off), as the renderer would put it on the layout. */
export function cameraBackgroundFor(pass) {
  switch (pass) {
    case 'off':
      return null
    case 'slight-blur':
      return { mode: 'blur', blurPct: 30, edges: 'balanced' }
    case 'image':
      return { mode: 'image', blurPct: 70, edges: 'balanced', assetId: IMAGE_ASSET_ID }
    case 'strong-blur':
    case 'stall':
    case 'camera-switch-record':
    case 'relaunch':
      return { mode: 'blur', blurPct: 70, edges: 'balanced' }
    default:
      throw new Error(`unknown pass ${pass}`)
  }
}

/** `--effect <name>` (or `--effect=<name>`); Off by default. */
export function parseSmokeArgs(argv) {
  let effect = 'off'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--effect') effect = argv[++i]
    else if (arg.startsWith('--effect=')) effect = arg.slice('--effect='.length)
    else if (arg !== '--')
      throw new Error(`unknown argument ${arg}; use --effect ${EFFECTS.join('|')}`)
  }
  if (!EFFECTS.includes(effect)) {
    throw new Error(`unknown effect ${effect}; use one of ${EFFECTS.join(', ')}`)
  }
  return { effect }
}

/** Off proves the detector sees the room; any effect must hide it everywhere. */
export function expectationFor(pass) {
  return pass === 'off' ? EXPECT_ROOM_VISIBLE : EXPECT_ROOM_HIDDEN
}

/**
 * Whether the backend applied the pass's background, from
 * `preview.camera.status`: an effect shows its stage line with the same
 * mode; Off shows none.
 */
export function effectRequestFrom(pass, status) {
  const wanted = cameraBackgroundFor(pass)
  const stage = status?.cameraBackground ?? null
  if (!wanted) {
    return stage
      ? { requested: 'off', applied: false, reason: `the stage still runs ${stage.mode}` }
      : { requested: 'off', applied: true, reason: null }
  }
  if (!stage) {
    return {
      requested: wanted.mode,
      applied: false,
      reason: 'preview.camera.status has no cameraBackground: the stage never armed'
    }
  }
  if (stage.mode !== wanted.mode) {
    return {
      requested: wanted.mode,
      applied: false,
      reason: `the stage runs ${stage.mode}, not ${wanted.mode}`
    }
  }
  if (stage.state === 'unavailable') {
    return {
      requested: wanted.mode,
      applied: false,
      reason: `the stage is unavailable: ${stage.message ?? 'no reason given'}`
    }
  }
  return { requested: wanted.mode, applied: true, reason: null }
}

/** D6: the cover must stand in once the newest matte is 100 ms old: at the first capture past it. */
export function stallCoverBudgetMs(fps) {
  return 100 + Math.ceil(1000 / Math.max(1, fps))
}

/**
 * The stall pass's own judgement, from the camera status polled while the
 * segment worker was held.
 * @param {{coverSeen:boolean, coverAfterMaskAgeMs:number|null|undefined,
 *   recovered:boolean, fps:number}} stall
 */
export function judgeStall({ coverSeen, coverAfterMaskAgeMs, recovered, fps }) {
  const failures = []
  const budget = stallCoverBudgetMs(fps)
  if (!coverSeen) failures.push('the camera status never said cover while the segmenter was held')
  if (typeof coverAfterMaskAgeMs !== 'number') {
    failures.push('the stage did not report the matte age when the cover took over')
  } else if (coverAfterMaskAgeMs > budget) {
    failures.push(
      `the cover took over with a ${coverAfterMaskAgeMs} ms old matte; D6 allows ${budget} ms at ${fps} fps`
    )
  } else if (coverAfterMaskAgeMs < 100) {
    failures.push(`the cover took over early, at ${coverAfterMaskAgeMs} ms`)
  }
  if (!recovered) failures.push('processed frames never came back after the stall ended')
  return { ok: failures.length === 0, failures, budgetMs: budget }
}

/** The fixture's neutral ground (`NEUTRAL_GROUND_BGRA` in the stage), RGB. */
export const NEUTRAL_GROUND_RGB = Object.freeze([0x1a, 0x1c, 0x1f])

/** Share of a frame's pixels within a few levels of the neutral ground. */
export function neutralGroundFraction({ width, height, rgb }) {
  const [r0, g0, b0] = NEUTRAL_GROUND_RGB
  let near = 0
  const pixels = width * height
  for (let i = 0; i < pixels; i += 1) {
    const p = i * 3
    if (
      Math.abs(rgb[p] - r0) <= 6 &&
      Math.abs(rgb[p + 1] - g0) <= 6 &&
      Math.abs(rgb[p + 2] - b0) <= 6
    ) {
      near += 1
    }
  }
  return pixels ? near / pixels : 0
}

/**
 * The run's verdict from each output's judgement. `outputIds` limits it to
 * the outputs a short pass produces (its recording and the Preview).
 * @param {{effect:string, effectRequest:{applied:boolean,reason:string|null},
 *   outputs: Record<string, {ok:boolean, skipped?:boolean, reason?:string, failures?:string[]}>,
 *   outputIds?: string[]}} run
 */
export function finalVerdict({ effect, effectRequest, outputs, outputIds }) {
  const lines = []
  const failures = []
  if (!effectRequest.applied) {
    failures.push(`${effect} was requested but not applied: ${effectRequest.reason}`)
  }
  const listed = outputIds
    ? [
        ...CAMERA_BACKGROUND_OUTPUTS.filter((output) => outputIds.includes(output.id)),
        ...outputIds
          .filter((id) => !CAMERA_BACKGROUND_OUTPUTS.some((output) => output.id === id))
          .map((id) => ({ id, label: id }))
      ]
    : CAMERA_BACKGROUND_OUTPUTS
  let judged = 0
  for (const output of listed) {
    const result = outputs[output.id]
    if (!result) {
      failures.push(`${output.label}: never judged`)
      lines.push(`${output.label}: FAIL (never judged)`)
      continue
    }
    if (result.skipped) {
      lines.push(`${output.label}: SKIP (${result.reason})`)
      continue
    }
    judged += 1
    if (result.ok) {
      lines.push(`${output.label}: PASS`)
    } else {
      const why = (result.failures ?? []).join('; ') || 'failed'
      failures.push(`${output.label}: ${why}`)
      lines.push(`${output.label}: FAIL (${why})`)
    }
  }
  if (judged === 0) failures.push('no output was judged')
  return { ok: failures.length === 0, judged, failures, lines }
}
