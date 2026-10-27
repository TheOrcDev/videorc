// The picture: a built-in scene by its preset, and a takeover screen.

import type { LayoutPreset } from '@/lib/backend'
import type { StudioActionExecutor } from './context'
import { REMOTE_INTENT_COPY } from './copy'

export const sceneApply: StudioActionExecutor = async (context, fields) => {
  const layoutPreset = fields.layoutPreset as LayoutPreset | undefined
  if (!layoutPreset || !(context.knownLayoutPresets as readonly string[]).includes(layoutPreset)) {
    return { ok: false, message: REMOTE_INTENT_COPY.sceneMissing }
  }
  return (await context.applyLayoutPreset(layoutPreset))
    ? { ok: true }
    : { ok: false, message: REMOTE_INTENT_COPY.sceneFailed }
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
