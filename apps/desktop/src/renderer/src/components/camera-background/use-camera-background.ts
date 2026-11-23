import { useCallback, useMemo, useState } from 'react'

import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import { slotAsset } from '@/lib/background-assets'
import type { CameraBackground } from '@/lib/backend'
import {
  cameraBackgroundFor,
  cameraBackgroundIsEffect,
  cameraBackgroundChoiceId,
  cameraBackgroundChoices,
  cameraBackgroundForChoice,
  cameraBackgroundValueLabel,
  platformBackgroundReason,
  ROOM_BACKGROUND_UNAVAILABLE,
  type CameraBackgroundChoice,
  type CameraBackgroundChoiceId,
  type CameraBackgroundImage
} from '@/lib/camera-background-view'

/** What every Background control shows and does (Studio, Retro LCD, Scene page, ⌘K). */
export interface CameraBackgroundControl {
  /** False with no camera: there is nothing to put a background behind. */
  available: boolean
  background: CameraBackground
  /** The tile it lights, or null for a pick no tile shows. */
  choiceId: CameraBackgroundChoiceId | null
  valueLabel: string
  /** Every picture in the Images library, in its order. */
  images: CameraBackgroundImage[]
  /** The picked picture's file, for the trigger's thumbnail. */
  picture?: string
  roomOpen: boolean
  /** Why an effect can't be picked now (the platform, or an open room before S8). */
  effectReason: string | null
  isEffect: boolean
  mirror: boolean
  choices: (options?: {
    imageLimit?: number
    images?: CameraBackgroundImage[]
  }) => CameraBackgroundChoice[]
  choose: (choice: CameraBackgroundChoiceId) => void
  /** The whole background (a slider, the key's tuning); `commit: false` mid-drag. */
  set: (background: CameraBackground, options?: { commit?: boolean }) => void
}

/** The Images library's pictures (backgrounds that hold an image), in slot order. */
export function useCameraBackgroundImages(): CameraBackgroundImage[] {
  const { registry } = useBackgroundAssets()
  return useMemo(
    () =>
      registry.slots.flatMap((slot) => {
        const asset = slotAsset(slot, registry)
        if (!asset || slot.status !== 'ready') return []
        const picture = asset.thumbnailPath ?? asset.assetPath
        return [{ assetId: asset.id, name: asset.name, ...(picture ? { picture } : {}) }]
      }),
    [registry]
  )
}

/**
 * The camera's background as one control: the per-camera setting (plan 258
 * D3) for the camera that renders, written through `applyCameraBackground`
 * so every later commit carries it. The stage confirms a pick, so no toast.
 */
export function useCameraBackground(): CameraBackgroundControl {
  const { settings, captureConfig, applyCameraBackground, runtimeInfo } = useStudioCore()
  const { cloudStatus, talkShow } = useStudioCloud()
  const images = useCameraBackgroundImages()
  const cameraId = captureConfig.sources.cameraId
  // A slider mid-drag shows its value here only, for the camera it was
  // dragged on; the drop stores and commits it. Another camera never sees it.
  const [draft, setDraft] = useState<{ cameraId: string; value: CameraBackground } | null>(null)
  const background =
    (draft && draft.cameraId === cameraId ? draft.value : null) ??
    cameraBackgroundFor(settings.cameraBackgrounds, cameraId)
  // The room's phase, or the Show stage standing in for the Preview (a room
  // opening, or the smoke's stand-in for one).
  const roomOpen = cloudStatus?.room?.phase === 'open' || talkShow?.previewReplaced === true
  const platform = runtimeInfo?.platform
  const available = Boolean(cameraId)
  const effectReason =
    platformBackgroundReason(platform) ?? (roomOpen ? ROOM_BACKGROUND_UNAVAILABLE : null)
  const choose = useCallback(
    (choice: CameraBackgroundChoiceId) => {
      setDraft(null)
      void applyCameraBackground(cameraBackgroundForChoice(background, choice))
    },
    [applyCameraBackground, background]
  )
  const set = useCallback(
    (next: CameraBackground, options?: { commit?: boolean }) => {
      if (options?.commit === false) {
        if (cameraId) setDraft({ cameraId, value: next })
        return
      }
      // A drop after the camera changed under the drag commits nothing.
      if (draft && draft.cameraId !== cameraId) {
        setDraft(null)
        return
      }
      setDraft(null)
      void applyCameraBackground(next)
    },
    [applyCameraBackground, cameraId, draft]
  )
  return {
    available,
    background,
    choiceId: cameraBackgroundChoiceId(background),
    valueLabel: cameraBackgroundValueLabel(background, images),
    images,
    ...(background.mode === 'image'
      ? { picture: images.find((image) => image.assetId === background.assetId)?.picture }
      : {}),
    roomOpen,
    effectReason,
    isEffect: cameraBackgroundIsEffect(background),
    mirror: captureConfig.layout.cameraMirror,
    choices: (options) =>
      cameraBackgroundChoices({
        images: options?.images ?? images,
        cameraSelected: available,
        roomOpen,
        platform,
        imageLimit: options?.imageLimit
      }),
    choose,
    set
  }
}
