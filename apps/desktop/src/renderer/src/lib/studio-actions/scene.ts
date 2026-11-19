// The picture: a scene by its id, or by a layout it uses (plan 231 D14), and
// a takeover screen.

import { buildCaptureSources } from '@/lib/capture'
import type { LayoutPreset } from '@/lib/backend'
import { visualSources } from '@/lib/scene-presets'
import { showsFromSources, type SceneShows } from '@/lib/scenes'
import type {
  StudioActionContext,
  StudioActionExecutor,
  StudioActionFields,
  StudioActionOutcome
} from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const sceneApply: StudioActionExecutor = async (context, fields) => {
  const switches = fields.sceneId !== undefined || fields.layoutPreset !== undefined
  if (fields.screenId === undefined)
    return switches
      ? switchScene(context, fields)
      : { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
  const screen = context.sourcePicker?.capture.find(
    (device) =>
      device.id === fields.screenId && (device.kind === 'screen' || device.kind === 'window')
  )
  if (!screen || !context.sourcePicker || (!switches && !context.switchSource))
    return { ok: false, message: REMOTE_INTENT_COPY.screenMissing }
  const sources = buildCaptureSources(
    context.sourcePicker.sources,
    [...context.sourcePicker.capture],
    screen.id
  )
  // Plan 231 D2: a scene and a screen together are one switch. The scene it
  // names goes on showing that screen, and keeps it; never a second step
  // that would edit whichever scene was on stream while the switch landed.
  if (switches) return switchScene(context, fields, showsFromSources(visualSources(sources)))
  return context.switchSource!('capture', sources)
}

async function switchScene(
  context: StudioActionContext,
  fields: StudioActionFields,
  shows?: SceneShows
): Promise<StudioActionOutcome> {
  if (typeof fields.sceneId === 'string') {
    if (!fields.sceneId.trim() || fields.sceneId.length > 128 || !context.applySavedSceneResult)
      return { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
    const result = shows
      ? await context.applySavedSceneResult(fields.sceneId, { shows })
      : await context.applySavedSceneResult(fields.sceneId)
    return result.ok
      ? result
      : { ok: false, message: result.message ?? REMOTE_INTENT_COPY.sceneFailed }
  }
  const layoutPreset = fields.layoutPreset as LayoutPreset | undefined
  if (!layoutPreset || !(context.knownLayoutPresets as readonly string[]).includes(layoutPreset)) {
    return { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
  }
  const result = shows
    ? await context.applyLayoutPreset(layoutPreset, { shows })
    : await context.applyLayoutPreset(layoutPreset)
  if (result === true || (typeof result === 'object' && result.ok)) return { ok: true }
  return {
    ok: false,
    message: (typeof result === 'object' && result.message) || REMOTE_INTENT_COPY.sceneFailed
  }
}

export const takeoverShow: StudioActionExecutor = async (context, fields) => {
  const assetId = fields.assetId as string | undefined
  if (!assetId || !context.hasTakeover(assetId)) {
    return { ok: false, message: REMOTE_INTENT_COPY.takeoverMissing }
  }
  return (await context.activateTakeover(assetId))
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.takeoverShow }
}

export const takeoverHide: StudioActionExecutor = async (context) =>
  (await context.clearTakeover())
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.takeoverHide }
