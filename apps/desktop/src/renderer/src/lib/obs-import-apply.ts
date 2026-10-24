import { type BackgroundAssetRegistry } from '@/lib/background-assets'
import { applySlot, createImportedAsset, importIntoSlot } from '@/lib/background-library'
import type { CaptureConfig } from '@/lib/capture'
import type { ObsImportPlanResult } from '@/lib/obs-import-map'

// OBS import O3 — the apply merge. Pure: (current config, plan, raw stream
// key) → next config. Atomic by construction (one setCaptureConfig update);
// a failed background/asset step never leaves a half-applied config because
// asset registration happens OUTSIDE this merge, after it. The raw stream key
// enters the config exactly the way a user-typed key does (the streaming
// secret machinery converts it to a secret ref on persist — never logged).

export function mergeObsImportIntoConfig(
  config: CaptureConfig,
  plan: ObsImportPlanResult,
  rawStreamKey: string | null,
  now: string = new Date().toISOString()
): CaptureConfig {
  const next: CaptureConfig = {
    ...config,
    sources: { ...config.sources, ...plan.sources, testPattern: false },
    layout: {
      ...config.layout,
      layoutPreset: plan.layout.layoutPreset,
      ...(plan.layout.cameraTransformMode
        ? {
            cameraTransformMode: plan.layout.cameraTransformMode,
            cameraTransform: plan.layout.cameraTransform
          }
        : {}),
      ...(plan.layout.cameraAspect ? { cameraAspect: plan.layout.cameraAspect } : {})
    },
    video: {
      ...config.video,
      width: plan.video.width,
      height: plan.video.height,
      fps: plan.video.fps
    },
    audio: {
      ...config.audio,
      ...(typeof plan.audio.microphoneGainDb === 'number'
        ? { microphoneGainDb: plan.audio.microphoneGainDb }
        : {}),
      ...(typeof plan.audio.microphoneMuted === 'boolean'
        ? { microphoneMuted: plan.audio.microphoneMuted }
        : {}),
      ...(typeof plan.audio.systemAudioEnabled === 'boolean'
        ? { systemAudioEnabled: plan.audio.systemAudioEnabled }
        : {})
    }
  }

  if (plan.stream?.kind === 'rtmp-custom' || plan.stream?.kind === 'rtmp-platform') {
    const { serverUrl } = plan.stream
    const platform = plan.stream.kind === 'rtmp-custom' ? 'custom' : plan.stream.platform
    next.streaming = {
      ...config.streaming,
      targets: config.streaming.targets.map((target) =>
        target.platform === platform
          ? {
              ...target,
              enabled: true,
              serverUrl,
              ...(rawStreamKey
                ? { streamKey: rawStreamKey, streamKeyPresent: true, streamKeySecretRef: undefined }
                : {}),
              authMode: 'manual-rtmp' as const,
              updatedAt: now
            }
          : target
      ),
      enabledTargetIds: Array.from(new Set([...config.streaming.enabledTargetIds, platform]))
    }
  }

  return next
}

/**
 * The background half of an OBS apply (plan 174, C-7): exactly what the
 * report promised. The OBS image goes into the slot the report named and
 * becomes the scene background (the registry's active slot, which the Studio
 * applies). A plan that promised no background leaves the registry alone.
 */
export function withObsBackground(
  registry: BackgroundAssetRegistry,
  plan: Pick<ObsImportPlanResult, 'backgroundAsset' | 'backgroundSlotId'>,
  now: string = new Date().toISOString()
): BackgroundAssetRegistry {
  const imported = plan.backgroundAsset
  const slotId = plan.backgroundSlotId
  if (!imported || !slotId || !registry.slots.some((slot) => slot.id === slotId)) {
    return registry
  }
  const asset = createImportedAsset({
    id: imported.id,
    name: imported.name,
    assetPath: imported.assetPath,
    thumbnailPath: imported.thumbnailPath,
    createdAt: now,
    updatedAt: now
  })
  return applySlot(importIntoSlot(registry, slotId, asset), slotId)
}
