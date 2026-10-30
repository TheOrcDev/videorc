import type { Device } from './backend'
import {
  sceneSourceGaps,
  sceneSourceProblems,
  type SceneApp,
  type SceneVisual
} from './scene-presets'

/**
 * Plan 210 S3: the strict check before a saved scene goes on stream, without
 * a fresh `devices.list` round trip. That enumeration (a full
 * SCShareableContent walk) cost about 320 ms per switch, most of the budget
 * the owner set for click to new picture (150 ms p95, D5).
 *
 * The Studio already holds the latest device list it was told about, and an
 * app scene's window was proven by the resolver a moment ago (the same
 * one-second discovery cache the listing uses). So:
 *
 * - a source the streamer turned off on purpose (Screen None, Camera Off)
 *   refuses at once; no list could change that;
 * - a chosen source present in the held list is proven;
 * - a chosen source missing from the held list asks for one fresh list (a
 *   device that came back since the list was last read), then refuses if it
 *   is still missing;
 * - an app scene's screen is the resolver's word and is not re-judged here.
 */
export type ScenePreflightJudgement =
  | { kind: 'proven' }
  | { kind: 'refetch'; missing: Array<'camera' | 'screen'> }
  | { kind: 'refused'; issues: string[] }

export function judgeSceneSources(
  visual: SceneVisual,
  devices: readonly Device[],
  sceneApp?: SceneApp
): ScenePreflightJudgement {
  const judged: SceneVisual = sceneApp
    ? { ...visual, sources: { ...visual.sources, app: sceneApp } }
    : visual
  const gaps = sceneSourceGaps(judged, devices)
  if (gaps.length === 0) return { kind: 'proven' }
  if (gaps.some((gap) => gap.state === 'off')) {
    return { kind: 'refused', issues: sceneSourceProblems(judged, devices) }
  }
  return { kind: 'refetch', missing: gaps.map((gap) => gap.source) }
}

export type SavedScenePreflightInput = {
  visual: SceneVisual
  sceneApp?: SceneApp
  /** The device list the Studio holds now. */
  devices: readonly Device[]
  /** One fresh `devices.list`, used only when a chosen source is missing from the held list. */
  listDevices: () => Promise<readonly Device[]>
  /** Whether the scene's background asset is on disk; `null` when the scene has none. */
  backgroundExists: (() => Promise<boolean>) | null
}

export type SavedScenePreflightResult = {
  /** Problems that refuse the switch, in the order they are said. */
  issues: string[]
  /** Whether a fresh `devices.list` was needed. */
  refetched: boolean
}

/**
 * The device judgement and the background check run side by side; the
 * background IPC never waits behind a refetch, and a refetch never waits
 * behind the IPC.
 */
export async function runSavedScenePreflight(
  input: SavedScenePreflightInput
): Promise<SavedScenePreflightResult> {
  const background = input.backgroundExists
    ? input.backgroundExists().then(
        (exists) =>
          exists ? [] : ['Saved background unavailable. Resolve it or apply without background.'],
        () => ['Saved background unavailable. Resolve it or apply without background.']
      )
    : Promise.resolve([] as string[])
  const sources = (async (): Promise<{ issues: string[]; refetched: boolean }> => {
    const first = judgeSceneSources(input.visual, input.devices, input.sceneApp)
    if (first.kind === 'proven') return { issues: [], refetched: false }
    if (first.kind === 'refused') return { issues: first.issues, refetched: false }
    const fresh = await input.listDevices()
    const second = judgeSceneSources(input.visual, fresh, input.sceneApp)
    if (second.kind === 'proven') return { issues: [], refetched: true }
    const judged: SceneVisual = input.sceneApp
      ? { ...input.visual, sources: { ...input.visual.sources, app: input.sceneApp } }
      : input.visual
    return { issues: sceneSourceProblems(judged, fresh), refetched: true }
  })()
  const [sourceResult, backgroundIssues] = await Promise.all([sources, background])
  return {
    issues: [...sourceResult.issues, ...backgroundIssues],
    refetched: sourceResult.refetched
  }
}
