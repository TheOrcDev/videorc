// The picture: a scene by its id, or by a layout it uses (plan 231 D14), and
// a takeover screen.

import type { LayoutPreset } from '@/lib/backend'
import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const sceneApply: StudioActionExecutor = async (context, fields) => {
  if (typeof fields.sceneId === 'string') {
    if (!fields.sceneId.trim() || fields.sceneId.length > 128 || !context.applySavedSceneResult)
      return { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
    const result = await context.applySavedSceneResult(fields.sceneId)
    return result.ok
      ? result
      : { ok: false, message: result.message ?? REMOTE_INTENT_COPY.sceneFailed }
  }
  const layoutPreset = fields.layoutPreset as LayoutPreset | undefined
  if (!layoutPreset || !(context.knownLayoutPresets as readonly string[]).includes(layoutPreset)) {
    return { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
  }
  const result = await context.applyLayoutPreset(layoutPreset)
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
