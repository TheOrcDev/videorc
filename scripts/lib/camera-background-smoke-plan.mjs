// Plan 258 S2: the shape of `pnpm smoke:camera-background`, pure for its tests.
//
// Every output a camera background must reach is listed here once. S2 judges
// the ones the dev app can produce today; the rest carry the slice that fills
// them in and why they cannot run yet, so a run always says which outputs it
// vouched for and never passes one silently.
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
      'S3: Videorc Camera exists only in the signed app in /Applications (plan 214); the dev app has no camera extension to read back. S3 runs smoke:virtual-camera against a packaged build with the fixture.'
  },
  {
    id: 'room',
    label: 'Talk-show room',
    pending:
      "S8: in a room the renderer owns the camera through getUserMedia (plan 224 D6), so the backend's fixture camera never reaches it. S8 feeds the same fixture to Chromium's fake camera and scans the published track."
  }
])

export const EFFECTS = Object.freeze(['off', 'slight-blur', 'strong-blur', 'image'])

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
export function expectationFor(effect) {
  return effect === 'off' ? EXPECT_ROOM_VISIBLE : EXPECT_ROOM_HIDDEN
}

/**
 * What this build can do when an effect is asked for. S2 has no setting and
 * no stage: S1 adds the per-camera setting and S3 the macOS stage, and S3
 * replaces this with the real request.
 */
export function effectRequestToday(effect) {
  if (effect === 'off') return { requested: 'off', applied: true, reason: null }
  return {
    requested: effect,
    applied: false,
    reason:
      'this build has no camera background setting or stage yet (plan 258 S1 adds the setting, S3 the macOS stage), so the fixture camera reaches every output raw'
  }
}

/**
 * The run's verdict from each output's judgement.
 * @param {{effect:string, effectRequest:{applied:boolean,reason:string|null},
 *   outputs: Record<string, {ok:boolean, skipped?:boolean, reason?:string, failures?:string[]}>}} run
 */
export function finalVerdict({ effect, effectRequest, outputs }) {
  const lines = []
  const failures = []
  if (effect !== 'off' && !effectRequest.applied) {
    failures.push(`${effect} was requested but not applied: ${effectRequest.reason}`)
  }
  let judged = 0
  for (const output of CAMERA_BACKGROUND_OUTPUTS) {
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
